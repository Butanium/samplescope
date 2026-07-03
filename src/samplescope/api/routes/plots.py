"""Plot panel: a persistent, cross-browser tabstrip of images / PDFs / plotly figures.

Tabs come from two sources:
  1. The user clicking an image or PDF in the dataset tree (frontend posts an
     `image` / `pdf` tab with `source_path`).
  2. Claude posting a plotly figure or screenshot via the `sscope view plot add`
     CLI — same endpoint, `kind="plotly"` carries the figure JSON inline.

Storage lives in `state.plot_tabs` (DuckDB state DB), so tabs survive reload
and follow the user across browsers — same plumbing as `state.user_prefs`.

A separate SSE channel (`/api/plots/events`) pushes the live tab list so
Claude's `sscope view plot add` makes the new tab appear in an open browser
without a refresh.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from ..duck import cursor

router = APIRouter(prefix="/api/plots", tags=["plots"])

VALID_KINDS = {"image", "pdf", "plotly"}

# Per-process pub/sub for tab-list updates. Each subscriber owns one queue;
# `_notify` fans out a serialized snapshot (so subscribers don't all hit the
# DB simultaneously).
_subs: set[asyncio.Queue[dict[str, Any]]] = set()
_subs_lock = asyncio.Lock()


def _list_tabs() -> list[dict]:
    """Return all tabs in display order."""
    with cursor() as cur:
        rows = cur.execute(
            "SELECT id, kind, title, source_path, payload, position, created_at "
            "FROM state.plot_tabs ORDER BY position, created_at"
        ).fetchall()
    return [
        {
            "id": r[0], "kind": r[1], "title": r[2], "source_path": r[3],
            "payload": json.loads(r[4]) if r[4] else None,
            "position": r[5], "created_at": str(r[6]),
        }
        for r in rows
    ]


async def _notify() -> None:
    """Push the current tab list to every subscriber. Drops on full queues."""
    snapshot = _list_tabs()
    payload = {"type": "tabs", "tabs": snapshot}
    async with _subs_lock:
        for q in list(_subs):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass


@router.get("")
def list_plots() -> list[dict]:
    """Snapshot of every persisted tab."""
    return _list_tabs()


@router.post("")
async def add_plot(payload: dict) -> dict:
    """Add a tab. Idempotent for image/pdf when `source_path` matches an
    existing tab — returns that tab's id rather than creating a duplicate,
    so clicking the same image in the tree twice focuses the existing tab.
    """
    kind = payload.get("kind")
    if kind not in VALID_KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(VALID_KINDS)}")
    title = payload.get("title") or ""
    source_path = payload.get("source_path")
    inline = payload.get("payload")  # dict for plotly, None otherwise

    if kind in {"image", "pdf"}:
        if not source_path:
            raise HTTPException(400, f"{kind} tabs require source_path")
        with cursor() as cur:
            existing = cur.execute(
                "SELECT id FROM state.plot_tabs WHERE kind = ? AND source_path = ?",
                [kind, source_path],
            ).fetchone()
        if existing:
            await _notify()
            return {"id": existing[0], "existing": True}
    elif kind == "plotly":
        if inline is None:
            raise HTTPException(400, "plotly tabs require payload (figure JSON)")

    tab_id = uuid.uuid4().hex[:12]
    with cursor() as cur:
        max_pos = cur.execute(
            "SELECT COALESCE(max(position), -1) + 1 FROM state.plot_tabs"
        ).fetchone()[0]
        cur.execute(
            "INSERT INTO state.plot_tabs(id, kind, title, source_path, payload, position) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [tab_id, kind, title, source_path, json.dumps(inline) if inline is not None else None, int(max_pos)],
        )
    await _notify()
    return {"id": tab_id, "existing": False}


@router.delete("/{tab_id}")
async def delete_plot(tab_id: str) -> dict:
    """Close a single tab."""
    with cursor() as cur:
        cur.execute("DELETE FROM state.plot_tabs WHERE id = ?", [tab_id])
    await _notify()
    return {"ok": True, "id": tab_id}


@router.post("/close")
async def close_plots(payload: dict) -> dict:
    """Bulk close. `mode = "all" | "others" | "selection"`.
    For "others", `keep` must be a single id.
    For "selection", `ids` is the list to drop.
    """
    mode = payload.get("mode")
    if mode == "all":
        with cursor() as cur:
            cur.execute("DELETE FROM state.plot_tabs")
    elif mode == "others":
        keep = payload.get("keep")
        if not keep:
            raise HTTPException(400, "mode=others requires 'keep'")
        with cursor() as cur:
            cur.execute("DELETE FROM state.plot_tabs WHERE id <> ?", [keep])
    elif mode == "selection":
        ids = payload.get("ids") or []
        if not ids:
            return {"ok": True, "closed": 0}
        # DuckDB lacks a clean parameterized IN; small integer-bounded list of
        # short hex ids — sanitize and inline.
        clean = [str(i).replace("'", "") for i in ids if isinstance(i, str)]
        if not clean:
            return {"ok": True, "closed": 0}
        joined = ",".join(f"'{i}'" for i in clean)
        with cursor() as cur:
            cur.execute(f"DELETE FROM state.plot_tabs WHERE id IN ({joined})")
    else:
        raise HTTPException(400, f"mode must be all|others|selection, got {mode!r}")
    await _notify()
    return {"ok": True}


@router.post("/reorder")
async def reorder_plots(payload: dict) -> dict:
    """Replace the tab order with the supplied id list. Missing ids keep
    their old positions (sorted after the explicit ones)."""
    ids = payload.get("ids") or []
    if not isinstance(ids, list):
        raise HTTPException(400, "'ids' must be a list")
    with cursor() as cur:
        for pos, tab_id in enumerate(ids):
            cur.execute(
                "UPDATE state.plot_tabs SET position = ? WHERE id = ?",
                [pos, str(tab_id)],
            )
    await _notify()
    return {"ok": True, "n": len(ids)}


@router.get("/events")
async def plot_events() -> EventSourceResponse:
    """SSE channel that fires the current tab list whenever it changes."""
    q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
    async with _subs_lock:
        _subs.add(q)
    await q.put({"type": "tabs", "tabs": _list_tabs()})

    async def gen() -> AsyncIterator[dict]:
        try:
            while True:
                try:
                    evt = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield {"event": evt["type"], "data": json.dumps(evt)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            async with _subs_lock:
                _subs.discard(q)

    return EventSourceResponse(gen())
