"""Chat: a real Claude Code session driven from the browser.

Sessions are kept in-memory keyed by `session_id`. A session owns one
ClaudeSDKClient lifetime; messages stream back as SSE events that the
frontend renders into chat cards (text, tool-use, tool-result).
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

import re as _re
import shutil
import uuid as _uuid
from pathlib import Path as _Path

from ..duck import cursor
from ..models import ChatMessageRequest
from ..routes.datasets import read_one_row
from ..settings import SETTINGS
from ..state import BUS


def _claude_project_dir() -> _Path:
    """Return the Claude Code session directory for our cwd.

    Claude Code encodes the project's absolute path into the dir name by
    replacing non-alnum chars with `-`. Mirrors the SDK's `project_key_for_directory`.
    """
    encoded = _re.sub(r"[^a-zA-Z0-9]", "-", str(SETTINGS.root))
    return _Path.home() / ".claude" / "projects" / encoded


def _fork_session_jsonl(sdk_session_id: str) -> str | None:
    """Copy the SDK's session JSONL to a fresh UUID and return that new id.

    Each call to `resume=...` writes new messages into the JSONL. If the SDK
    subprocess is killed abruptly (e.g. uvicorn reload), the JSONL can be
    left in a state that the next `receive_messages()` chokes on with
    "Fatal error in message reader". Forking before every resume sidesteps
    that — the original stays pristine for any future resume, and the new
    copy is what the live session writes into.

    Returns None if the source JSONL is missing (sdk can't resume anyway).
    """
    src = _claude_project_dir() / f"{sdk_session_id}.jsonl"
    if not src.exists():
        return None
    new_id = str(_uuid.uuid4())
    dst = src.with_name(f"{new_id}.jsonl")
    shutil.copy2(src, dst)
    return new_id

router = APIRouter(prefix="/api/chat", tags=["chat"])

# Model classes the UI can pick from. Aliases resolve to the latest model of
# each class inside the Claude Code CLI, so this list stays version-agnostic.
ALLOWED_MODELS = ("haiku", "sonnet", "opus", "fable")

# The embedded agent's system-prompt append = a short SITUATIONAL preamble
# (below) + the full samplescope SKILL.md body (preloaded — the SDK has no
# native main-loop skill preloading, so we read the packaged file ourselves;
# see docs: modifying-system-prompts). The skill is the single source of
# truth for the command surface (its reference block is generated from the
# Typer app by `python -m samplescope._gen_cli_ref`), shared with terminal
# Claude sessions and the README.
CHAT_PREAMBLE = """\
You are the chat agent embedded in a running samplescope server — the user is
looking at its web UI right now, and your `sscope view` commands (via Bash)
drive THEIR live view. You are in the "embedded chat agent" situation of the
skill below: the server is already running and `sscope view` is pre-targeted
at it via SAMPLESCOPE_BASE_URL — never start/find a server. Prefer driving
the view over pasting data into chat. Use Read/Edit on Python source only
when changing the CLI itself.
"""


def _skill_body() -> str:
    """The packaged SKILL.md body (frontmatter stripped), for prompt preload."""
    from importlib.resources import files

    text = files("samplescope").joinpath("skill/SKILL.md").read_text(encoding="utf-8")
    return _re.sub(r"\A---\n.*?\n---\n", "", text, count=1, flags=_re.DOTALL)


CLI_INTRO = CHAT_PREAMBLE + "\n" + _skill_body()


@dataclass
class Session:
    """One active chat session.

    Architecture: ONE long-running listener task pumps every message from
    `client.receive_messages()` into the SSE queue for the lifetime of the
    session. `query()` can be called at any time — the SDK writes it onto
    the same transport, so new user input is picked up mid-trace by the
    underlying Claude Code subprocess (this is how the CLI handles typing
    while the model is generating). `interrupt()` cancels the current turn's
    generation; the listener keeps running and picks up the next turn.

    `in_turn` is informational only — flipped by tracking ResultMessage in
    the listener — so the UI can grey out the send button label or show a
    spinner without having to infer state from the event stream.

    Events fan out to per-connection `subscribers` queues. A single shared
    queue would make concurrent SSE consumers (two browsers on the same
    session, or a stale connection during drawer reopen) COMPETE for events —
    each message delivered to exactly one of them, the rest seeing silent
    gaps ("queued…" forever while answers only show up after a reload).
    """
    id: str
    client: ClaudeSDKClient
    permission_mode: str
    model: str | None = None
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    listener_task: asyncio.Task | None = None
    in_turn: bool = False
    seq: int = 0

    def publish(self, evt: dict) -> None:
        """Broadcast one event to every live SSE connection, never blocking
        the listener. A slow consumer loses its oldest event rather than
        stalling the session (history in DuckDB is the source of truth)."""
        for q in list(self.subscribers):
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                q.put_nowait(evt)


SESSIONS: dict[str, Session] = {}


def _serialize_block(b: Any) -> dict:
    """Convert a content block to a JSON-friendly dict the frontend understands."""
    if isinstance(b, TextBlock):
        return {"type": "text", "text": b.text}
    if isinstance(b, ThinkingBlock):
        # `thinking` is the readable summary when the session enables
        # `display="summarized"`; otherwise it's empty (the actual reasoning
        # is encrypted into `signature`, opaque to us).
        return {"type": "thinking", "text": b.thinking}
    if isinstance(b, ToolUseBlock):
        return {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input}
    if isinstance(b, ToolResultBlock):
        content = b.content
        if isinstance(content, list):
            content = [
                c if isinstance(c, dict) else {"type": "text", "text": str(c)}
                for c in content
            ]
        return {"type": "tool_result", "tool_use_id": b.tool_use_id, "content": content}
    if dataclasses.is_dataclass(b):
        return dataclasses.asdict(b)
    return {"type": "unknown", "repr": str(b)}


def _serialize_message(m: Any) -> dict | None:
    """Frontend-bound representation of an SDK message."""
    if isinstance(m, AssistantMessage):
        return {"role": "assistant", "model": m.model, "content": [_serialize_block(b) for b in m.content]}
    if isinstance(m, UserMessage):
        if isinstance(m.content, list):
            return {"role": "user", "content": [_serialize_block(b) for b in m.content]}
        return {"role": "user", "content": [{"type": "text", "text": str(m.content)}]}
    if isinstance(m, SystemMessage):
        return {"role": "system", "subtype": getattr(m, "subtype", None), "data": getattr(m, "data", None)}
    if isinstance(m, ResultMessage):
        return {
            "role": "result",
            "subtype": m.subtype,
            "duration_ms": m.duration_ms,
            "is_error": m.is_error,
            "num_turns": m.num_turns,
            "total_cost_usd": m.total_cost_usd,
        }
    return None


def _persist(session_id: str, payload: dict) -> int:
    """Append one message-event to state.chat_messages and return its seq."""
    with cursor() as cur:
        seq = cur.execute(
            "SELECT COALESCE(max(seq), -1) + 1 FROM state.chat_messages WHERE session_id = ?",
            [session_id],
        ).fetchone()[0]
        cur.execute(
            "INSERT INTO state.chat_messages(session_id, seq, role, payload) VALUES (?, ?, ?, ?)",
            [session_id, seq, payload.get("role", "unknown"), json.dumps(payload)],
        )
    return seq


def _build_options(
    permission_mode: str,
    resume: str | None = None,
    model: str | None = None,
) -> ClaudeAgentOptions:
    """Shared option construction for fresh + resumed sessions."""
    kwargs: dict[str, Any] = dict(
        cwd=str(SETTINGS.root),
        permission_mode=permission_mode,
        # None ⇒ the CLI's configured default model.
        model=model or SETTINGS.chat_model,
        # Chat-spawned `sscope view` must target *this* server instance —
        # not whatever cwd-based discovery would pick. Merged into the
        # subprocess env by the SDK (inherits the rest of os.environ).
        env={"SAMPLESCOPE_BASE_URL": SETTINGS.base_url},
        system_prompt={
            "type": "preset",
            "preset": "claude_code",
            "append": CLI_INTRO,
        },
        allowed_tools=[
            "Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch",
        ],
        # Adaptive thinking: model decides per-turn whether the prompt needs CoT
        # (cheaper than always-on for trivial turns). `display="summarized"` is
        # the unlock for readable text in ThinkingBlock.thinking — without it
        # the SDK only returns the encrypted signature and the UI shows an
        # empty collapsible. See CLAUDE.md for the probe
        # that established this.
        thinking={"type": "adaptive", "display": "summarized"},
        # The SDK's stdio transport ships each CLI message as a single JSON
        # line and bails with "JSON message exceeded maximum buffer size" if
        # the line is larger than this. The default (1 MB) blows up the
        # instant the model uses Read on an image — base64-inline content
        # bloats fast. Bump to 64 MB so multi-image inspection just works;
        # the limit only caps individual messages, not session memory.
        max_buffer_size=64 * 1024 * 1024,
    )
    # The SDK ships a bundled CLI and prefers it over $PATH, but it lags the
    # released Claude Code (e.g. its 2.1.162 rejects the `fable` alias that
    # 2.1.170 accepts). Prefer the user's auto-updating global install.
    system_cli = shutil.which("claude")
    if system_cli:
        kwargs["cli_path"] = system_cli
    if resume:
        kwargs["resume"] = resume
    return ClaudeAgentOptions(**kwargs)


async def _spawn_session(
    sid: str, permission_mode: str, resume: str | None = None, model: str | None = None
) -> Session:
    """Allocate a Session: build options, connect the SDK, start the listener."""
    client = ClaudeSDKClient(options=_build_options(permission_mode, resume=resume, model=model))
    await client.connect()
    sess = Session(id=sid, client=client, permission_mode=permission_mode, model=model)
    sess.listener_task = asyncio.create_task(_listen(sess))
    SESSIONS[sid] = sess
    return sess


def _lookup_sdk_session_id(sid: str) -> str | None:
    """Return a resumable SDK session UUID — one whose JSONL still exists.

    Strategy:
      1. Prefer the value stored on `state.chat_sessions` IF its JSONL is on
         disk. (A prior bug overwrote this with a per-run runtime UUID for
         which no JSONL exists; we ignore those.)
      2. Otherwise scan `state.chat_messages` for SystemMessage payloads
         carrying `data.session_id` — pick the earliest one that points at
         a JSONL we can actually find. Backfill the validated id.
    """
    project_dir = _claude_project_dir()
    def _has_jsonl(uuid: str) -> bool:
        return (project_dir / f"{uuid}.jsonl").exists()

    with cursor() as cur:
        row = cur.execute(
            "SELECT sdk_session_id FROM state.chat_sessions WHERE session_id = ?",
            [sid],
        ).fetchone()
    stored = row[0] if row and row[0] else None
    if stored and _has_jsonl(stored):
        return stored

    with cursor() as cur:
        rows = cur.execute(
            "SELECT payload FROM state.chat_messages WHERE session_id = ? "
            "AND role = 'system' ORDER BY seq",
            [sid],
        ).fetchall()
    for (raw,) in rows:
        try:
            payload = json.loads(raw)
            data = payload.get("data") or {}
            candidate = data.get("session_id")
            if candidate and _has_jsonl(candidate):
                with cursor() as cur:
                    cur.execute(
                        "UPDATE state.chat_sessions SET sdk_session_id = ? WHERE session_id = ?",
                        [candidate, sid],
                    )
                return candidate
        except Exception:
            continue
    return None


@router.post("/sessions")
async def create_session(payload: dict | None = None) -> dict:
    """Spin up a Claude Code session. Returns the session id used in subsequent calls."""
    payload = payload or {}
    permission_mode = payload.get("permission_mode", "acceptEdits")
    label = payload.get("label")
    model = payload.get("model") or None
    if model is not None and model not in ALLOWED_MODELS:
        raise HTTPException(400, f"invalid model: {model!r} (allowed: {ALLOWED_MODELS})")
    sid = uuid.uuid4().hex[:12]
    await _spawn_session(sid, permission_mode, model=model)
    with cursor() as cur:
        cur.execute(
            "INSERT INTO state.chat_sessions(session_id, label, model) VALUES (?, ?, ?)",
            [sid, label, model],
        )
    return {"session_id": sid, "permission_mode": permission_mode, "model": model}


@router.post("/sessions/{sid}/resume")
async def resume_session(sid: str) -> dict:
    """Re-attach to a persisted session so the user can keep chatting in it.

    If it's already live, no-op. Otherwise create a fresh SDK client with
    `resume=<sdk_session_id>` so the model picks up the prior conversation
    state. Returns `{ok: true, resumed: bool}` where `resumed=false` means
    we had to start the session fresh because the SDK id wasn't captured.
    """
    if sid in SESSIONS:
        return {"ok": True, "resumed": True, "already_live": True}
    sdk_id = _lookup_sdk_session_id(sid)
    if sdk_id is None:
        raise HTTPException(
            404,
            f"session {sid} has no captured sdk_session_id — likely too old; can't resume",
        )
    with cursor() as cur:
        row = cur.execute(
            "SELECT model FROM state.chat_sessions WHERE session_id = ?",
            [sid],
        ).fetchone()
    if row is None:
        raise HTTPException(404, f"session {sid} not found in state.chat_sessions")
    model = row[0]
    # The SDK does its own JSONL copy under the hood (see session_resume.py
    # in claude-agent-sdk); we just hand it the canonical id and let it
    # snapshot a working copy. The runtime UUID it picks goes into a fresh
    # project-dir JSONL automatically; we don't track that one.
    try:
        await _spawn_session(sid, permission_mode="acceptEdits", resume=sdk_id, model=model)
    except Exception as e:
        raise HTTPException(500, f"resume failed: {type(e).__name__}: {e}")
    return {"ok": True, "resumed": True, "sdk_session_id": sdk_id, "model": model}


async def _listen(sess: Session) -> None:
    """Pump every message from the SDK into the session's outbound queue.

    Runs once per session for its lifetime. Tracks `in_turn` by watching for
    ResultMessage (turn-end) and the next assistant/user message after that
    (turn-start). Errors get surfaced as SSE error events but don't kill the
    loop; the SDK is responsible for raising connection-level failures.
    """
    try:
        async for msg in sess.client.receive_messages():
            # First non-result content after the previous turn ended ⇒ new turn
            # began. SystemMessages don't count: the SDK emits an `init` system
            # message right after connect, and treating it as a turn start made
            # fresh sessions show "Claude is thinking…" before any user input.
            if not sess.in_turn and not isinstance(msg, (ResultMessage, SystemMessage)):
                sess.in_turn = True
                sess.publish({"type": "turn_start"})
            payload = _serialize_message(msg)
            if payload is None:
                continue
            _persist(sess.id, payload)
            sess.publish({"type": "message", "payload": payload})
            # Capture the SDK's session UUID — but only ONCE per viewer
            # session. Each subprocess invocation (including each resume)
            # gets a fresh runtime UUID that doesn't correspond to a JSONL
            # on disk; overwriting with that runtime UUID would lose track
            # of the original file we need to resume from later. `WHERE
            # sdk_session_id IS NULL` makes the write idempotent.
            if isinstance(msg, SystemMessage):
                data = getattr(msg, "data", None) or {}
                sdk_id = data.get("session_id")
                if sdk_id:
                    with cursor() as cur:
                        cur.execute(
                            "UPDATE state.chat_sessions SET sdk_session_id = ? "
                            "WHERE session_id = ? AND sdk_session_id IS NULL",
                            [sdk_id, sess.id],
                        )
            if isinstance(msg, ResultMessage):
                sess.in_turn = False
                sess.publish({"type": "turn_end"})
    except asyncio.CancelledError:
        raise
    except Exception as e:
        sess.publish({"type": "error", "payload": {"error": f"{type(e).__name__}: {e}"}})


@router.post("/sessions/{sid}/permission_mode")
async def set_permission_mode(sid: str, payload: dict) -> dict:
    """Update the permission mode of a live session in place."""
    sess = SESSIONS.get(sid)
    if sess is None:
        raise HTTPException(404, f"session {sid} not found")
    mode = payload.get("permission_mode")
    if mode not in ("default", "acceptEdits", "bypassPermissions"):
        raise HTTPException(400, f"invalid mode: {mode}")
    await sess.client.set_permission_mode(mode)
    sess.permission_mode = mode
    return {"ok": True, "permission_mode": mode}


@router.post("/sessions/{sid}/model")
async def set_session_model(sid: str, payload: dict) -> dict:
    """Switch the model of a live session in place (next turn uses it)."""
    sess = SESSIONS.get(sid)
    if sess is None:
        raise HTTPException(404, f"session {sid} not found")
    model = payload.get("model") or None
    if model is not None and model not in ALLOWED_MODELS:
        raise HTTPException(400, f"invalid model: {model!r} (allowed: {ALLOWED_MODELS})")
    await sess.client.set_model(model)
    sess.model = model
    with cursor() as cur:
        cur.execute(
            "UPDATE state.chat_sessions SET model = ? WHERE session_id = ?",
            [model, sid],
        )
    return {"ok": True, "model": model}


@router.delete("/sessions/{sid}")
async def close_session(sid: str) -> dict:
    sess = SESSIONS.pop(sid, None)
    if sess is not None:
        if sess.listener_task is not None:
            sess.listener_task.cancel()
        try:
            await sess.client.disconnect()
        except Exception:
            pass
    # GC empty sessions so the history list doesn't bloat. Anything with at
    # least one user message stays — that's what `list_sessions` shows.
    with cursor() as cur:
        has_user = cur.execute(
            "SELECT 1 FROM state.chat_messages WHERE session_id = ? AND role = 'user' LIMIT 1",
            [sid],
        ).fetchone()
        if has_user is None:
            cur.execute("DELETE FROM state.chat_messages WHERE session_id = ?", [sid])
            cur.execute("DELETE FROM state.chat_sessions WHERE session_id = ?", [sid])
    return {"ok": True, "found": sess is not None}


@router.get("/sessions/{sid}/history")
def session_history(sid: str) -> list[dict]:
    """Replay all persisted message events for this session."""
    with cursor() as cur:
        rows = cur.execute(
            "SELECT seq, role, payload, created_at FROM state.chat_messages WHERE session_id = ? ORDER BY seq",
            [sid],
        ).fetchall()
    return [
        {"seq": r[0], "role": r[1], "payload": json.loads(r[2]), "created_at": str(r[3])}
        for r in rows
    ]


@router.post("/sessions/{sid}/messages")
async def send_message(sid: str, req: ChatMessageRequest) -> dict:
    """Queue a user message; the actual streaming happens in /events.

    If the session is mid-turn, the message lands in `sess.pending` and gets
    sent as the next turn after the current one ends. Either way the user
    payload is persisted + echoed immediately so the UI shows it right away.
    """
    sess = SESSIONS.get(sid)
    if sess is None:
        raise HTTPException(404, f"session {sid} not found")
    text = req.text
    if req.inject_current_row and BUS.state.dataset_path is not None:
        try:
            row = read_one_row(path=BUS.state.dataset_path, idx=BUS.state.row_idx)
            text = (
                f"<viewer_state>\n"
                f"dataset_path: {BUS.state.dataset_path}\n"
                f"row_idx: {BUS.state.row_idx}\n"
                f"row_count: {BUS.state.row_count}\n"
                f"</viewer_state>\n"
                f"<current_row>\n{json.dumps(row, indent=2, default=str)[:4000]}\n</current_row>\n\n"
                f"{req.text}"
            )
        except Exception:
            pass
    mid_turn = sess.in_turn
    user_payload = {
        "role": "user",
        "content": [{"type": "text", "text": req.text}],
        "mid_turn": mid_turn,
    }
    _persist(sid, user_payload)
    sess.publish({"type": "user_input", "payload": user_payload})
    # Fire-and-forget into the SDK's transport. The session's long-running
    # listener picks up responses; if a turn is already in flight, the SDK
    # writes the new user message onto the same stream and the underlying
    # Claude Code subprocess handles incorporating it (matches CLI typing-
    # while-running behavior).
    await sess.client.query(text)
    return {"ok": True, "mid_turn": mid_turn}


@router.post("/sessions/{sid}/interrupt")
async def interrupt_session(sid: str) -> dict:
    """Abort the current turn's generation. The session keeps running; the
    listener picks up the next turn without needing a reconnect."""
    sess = SESSIONS.get(sid)
    if sess is None:
        raise HTTPException(404, f"session {sid} not found")
    try:
        await sess.client.interrupt()
    except Exception as e:
        sess.publish({"type": "error", "payload": {"error": f"interrupt failed: {type(e).__name__}: {e}"}})
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@router.get("/sessions/{sid}/events")
async def session_events(sid: str) -> EventSourceResponse:
    """Long-lived SSE stream of chat events for the lifetime of the session."""
    sess = SESSIONS.get(sid)
    if sess is None:
        raise HTTPException(404, f"session {sid} not found")

    async def gen() -> AsyncIterator[dict]:
        # Own queue per connection — see Session.publish. sse-starlette
        # cancels the generator on client disconnect, so the finally
        # reliably unregisters.
        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        sess.subscribers.append(q)
        try:
            while True:
                try:
                    evt = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield {"event": evt["type"], "data": json.dumps(evt.get("payload", {}))}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            if q in sess.subscribers:
                sess.subscribers.remove(q)

    return EventSourceResponse(gen())


@router.get("/sessions")
def list_sessions() -> list[dict]:
    """Sessions the user actually used (≥1 user message), newest first.

    Sessions that were spun up but never written into are excluded — opening
    the chat drawer and closing it shouldn't clutter the history list. They
    stay in the DB until their tab is closed (which GCs them in
    `close_session`), or until something explicitly prunes them.

    When `label` is null, derive one from the first user message so the
    history sidebar shows readable titles instead of opaque ids. Truncated
    to 60 chars for the UI strip.
    """
    with cursor() as cur:
        rows = cur.execute(
            """
            SELECT s.session_id, s.label, s.created_at,
                   (
                     SELECT payload FROM state.chat_messages m
                     WHERE m.session_id = s.session_id AND m.role = 'user'
                     ORDER BY m.seq LIMIT 1
                   ) AS first_user_msg
            FROM state.chat_sessions s
            WHERE EXISTS (
                SELECT 1 FROM state.chat_messages m
                WHERE m.session_id = s.session_id AND m.role = 'user'
            )
            ORDER BY s.created_at DESC
            """
        ).fetchall()
    out = []
    for sid, label, created, first in rows:
        if not label and first:
            try:
                payload = json.loads(first)
                blocks = payload.get("content") or []
                text = next(
                    (b.get("text", "") for b in blocks if b.get("type") == "text"),
                    "",
                )
                label = text.strip().splitlines()[0][:60] if text else None
            except Exception:
                label = None
        out.append({
            "id": sid,
            "label": label,
            "created_at": str(created),
            "live": sid in SESSIONS,
        })
    return out
