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
from dataclasses import dataclass
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
    encoded = _re.sub(r"[^a-zA-Z0-9]", "-", str(SETTINGS.repo_root))
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

CLI_INTRO = """\
A `viewer` CLI is available via Bash; it drives the dataset viewer the user is looking at.
Prefer it for any dataset operation:
  viewer ls                                  # discover datasets
  viewer info <path>                         # row count + columns + view kind
  viewer open <path>                         # switch the user's view
  viewer goto <idx>                          # navigate
  viewer filter <regex> [--column COL]       # apply filter
  viewer shuffle                             # reshuffle
  viewer sort <column> [--desc]              # sort by column
  viewer sample <n>                          # n random rows
  viewer mark <idx> [--tags ...] [--note ..] # mark / annotate
  viewer judge <preset> [--scope ...]        # run a judge
  viewer sql "<query>"                       # DuckDB SQL on the open file (FROM t)
  viewer plot add --file path.png --title "…"  # pin an image/PDF tab to the plot panel
  viewer plot add --plotly fig.json --title "…"  # pin a plotly figure (figure spec inline)
  viewer fields add <column>                 # pin a metadata column above each row in the chat view
  viewer fields rm <column>                  # unpin a pinned column
  viewer fields ls                           # list currently-pinned columns
  viewer state                               # current viewer state
Run `viewer --help` for more. Use Read/Edit on Python source only when changing the CLI itself.

# Viewer schema conventions

When generating JSONL files the user will browse here, pick a schema that lets
the viewer auto-detect a useful view (see `apps/dataset_viewer/api/schema_detect.py`):

- **Chat view (preferred for prompt/completion pairs)** — every row carries a
  `messages: [{role, content}, ...]` list. The conversation renders as bubbles;
  every other scalar field on the row stays as metadata (visible via raw-JSON
  toggle, marks, judges, SQL, sort, filter). Example row:
  ```json
  {
    "messages": [
      {"role": "user",      "content": "<prompt>"},
      {"role": "assistant", "content": "<completion>"}
    ],
    "sample_idx": 0, "align": 25.0, "label": "misaligned", ...
  }
  ```
  Do NOT emit bare `prompt`/`completion` strings without wrapping them in
  `messages` — they fall back to the wide-table view and become hard to read.

- **Table view** — flat scalar columns (string/int/float/bool). DuckDB infers
  the schema; long string columns will be truncated in cells. Fine for metric
  dumps, but if you have a prompt/completion field consider chat view instead.

- **Metrics view** — flat rows with a numeric `step` column and ≥3 numeric
  metric columns triggers a line-chart view. Use for training curves.

- **Eval log** — `.eval` files (inspect-AI) are first-class; no conversion needed.

Plot panel: matplotlib/PDF figures go in via `viewer plot add --file ...`;
plotly figures inline via `viewer plot add --plotly fig.json` where `fig.json`
contains the figure spec (`{data, layout}` or `figure.to_json()` output).
"""


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
    """
    id: str
    client: ClaudeSDKClient
    queue: asyncio.Queue
    permission_mode: str
    listener_task: asyncio.Task | None = None
    in_turn: bool = False
    seq: int = 0


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


def _build_options(permission_mode: str, resume: str | None = None) -> ClaudeAgentOptions:
    """Shared option construction for fresh + resumed sessions."""
    kwargs: dict[str, Any] = dict(
        cwd=str(SETTINGS.repo_root),
        permission_mode=permission_mode,
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
        # empty collapsible. See apps/dataset_viewer/CLAUDE.md for the probe
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
    if resume:
        kwargs["resume"] = resume
    return ClaudeAgentOptions(**kwargs)


async def _spawn_session(sid: str, permission_mode: str, resume: str | None = None) -> Session:
    """Allocate a Session: build options, connect the SDK, start the listener."""
    client = ClaudeSDKClient(options=_build_options(permission_mode, resume=resume))
    await client.connect()
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    sess = Session(id=sid, client=client, queue=queue, permission_mode=permission_mode)
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
    sid = uuid.uuid4().hex[:12]
    await _spawn_session(sid, permission_mode)
    with cursor() as cur:
        cur.execute(
            "INSERT INTO state.chat_sessions(session_id, label) VALUES (?, ?)",
            [sid, label],
        )
    return {"session_id": sid, "permission_mode": permission_mode}


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
            "SELECT 1 FROM state.chat_sessions WHERE session_id = ?",
            [sid],
        ).fetchone()
    if row is None:
        raise HTTPException(404, f"session {sid} not found in state.chat_sessions")
    # The SDK does its own JSONL copy under the hood (see session_resume.py
    # in claude-agent-sdk); we just hand it the canonical id and let it
    # snapshot a working copy. The runtime UUID it picks goes into a fresh
    # project-dir JSONL automatically; we don't track that one.
    try:
        await _spawn_session(sid, permission_mode="acceptEdits", resume=sdk_id)
    except Exception as e:
        raise HTTPException(500, f"resume failed: {type(e).__name__}: {e}")
    return {"ok": True, "resumed": True, "sdk_session_id": sdk_id}


async def _listen(sess: Session) -> None:
    """Pump every message from the SDK into the session's outbound queue.

    Runs once per session for its lifetime. Tracks `in_turn` by watching for
    ResultMessage (turn-end) and the next assistant/user message after that
    (turn-start). Errors get surfaced as SSE error events but don't kill the
    loop; the SDK is responsible for raising connection-level failures.
    """
    try:
        async for msg in sess.client.receive_messages():
            # First non-result content after the previous turn ended ⇒ new turn began.
            if not sess.in_turn and not isinstance(msg, ResultMessage):
                sess.in_turn = True
                await sess.queue.put({"type": "turn_start"})
            payload = _serialize_message(msg)
            if payload is None:
                continue
            _persist(sess.id, payload)
            await sess.queue.put({"type": "message", "payload": payload})
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
                await sess.queue.put({"type": "turn_end"})
    except asyncio.CancelledError:
        raise
    except Exception as e:
        await sess.queue.put({"type": "error", "payload": {"error": f"{type(e).__name__}: {e}"}})


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
    await sess.queue.put({"type": "user_input", "payload": user_payload})
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
        await sess.queue.put({"type": "error", "payload": {"error": f"interrupt failed: {type(e).__name__}: {e}"}})
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@router.get("/sessions/{sid}/events")
async def session_events(sid: str) -> EventSourceResponse:
    """Long-lived SSE stream of chat events for the lifetime of the session."""
    sess = SESSIONS.get(sid)
    if sess is None:
        raise HTTPException(404, f"session {sid} not found")

    async def gen() -> AsyncIterator[dict]:
        while True:
            try:
                evt = await asyncio.wait_for(sess.queue.get(), timeout=15.0)
                yield {"event": evt["type"], "data": json.dumps(evt.get("payload", {}))}
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": "{}"}

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
