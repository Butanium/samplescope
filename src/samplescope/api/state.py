"""Process-wide ViewerState plus a tiny pub/sub for SSE fan-out.

There is exactly one ViewerState per process. The frontend treats it as the
source of truth and re-renders on every push. UI clicks and Claude tool calls
both mutate this state through the same code path so they stay consistent.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class ViewerState:
    """Snapshot of what the user (and Claude) is currently looking at."""

    dataset_path: str | None = None
    view_kind: str | None = None
    row_count: int = 0
    columns: list[str] = field(default_factory=list)
    # Numeric columns detected in the dataset; lets the UI offer a plot toggle
    # even when the default view is samples (table/chat/json).
    numeric_cols: list[str] = field(default_factory=list)
    # Whether rows are flat (a spreadsheet rendering is meaningful) — drives the
    # "table" option in the view toggle.
    tabular: bool = False
    row_idx: int = 0
    filter_regex: str | None = None
    filter_column: str | None = None
    shuffle_seed: int | None = None
    sort_column: str | None = None
    sort_desc: bool = False
    # SQL-driven view state. `sql_mode == "selection"` narrows the rendered
    # rows to the __idx values returned by `sql_query` (intersected with any
    # regex filter). `sql_mode == "view"` replaces the main view with the SQL
    # output entirely (rendered by SqlView on the frontend). `sql_selection`
    # is the resolved list of __idx values for selection mode — kept on the
    # state object so the rows endpoint and the SSE-pushed
    # `sql_selection_count` stay consistent. For sane SSE payload sizes,
    # serialize a count rather than the full list (see to_dict).
    sql_query: str | None = None
    sql_mode: str = "off"
    sql_selection: list[int] | None = None
    sample_n: int | None = None
    last_event: str | None = None
    last_event_ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        # Don't broadcast the full selection list over SSE — it can be many
        # thousands of integers. Expose just the count for UI badges; the
        # backend reads the full list directly off BUS.state when needed.
        d = asdict(self)
        sel = d.pop("sql_selection", None)
        d["sql_selection_count"] = len(sel) if sel is not None else None
        return d


class StateBus:
    """Single publisher → many subscribers. Each subscriber gets its own queue."""

    def __init__(self) -> None:
        self.state = ViewerState()
        self._subs: set[asyncio.Queue[dict[str, Any]]] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        """Register a new subscriber. The first event delivered is a full snapshot."""
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=128)
        async with self._lock:
            self._subs.add(q)
        await q.put({"type": "snapshot", "state": self.state.to_dict()})
        return q

    async def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            self._subs.discard(q)

    async def publish(self, event: str, **patch: Any) -> None:
        """Apply a patch to ViewerState and broadcast a delta to all subscribers."""
        async with self._lock:
            for k, v in patch.items():
                if hasattr(self.state, k):
                    setattr(self.state, k, v)
            self.state.last_event = event
            self.state.last_event_ts = time.time()
            payload = {"type": "patch", "event": event, "state": self.state.to_dict()}
            for q in list(self._subs):
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    pass


BUS = StateBus()
