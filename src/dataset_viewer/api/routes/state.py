"""Single SSE stream for ViewerState. Frontend opens this once on app load."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from ..state import BUS

router = APIRouter(prefix="/api/state", tags=["state"])


@router.get("")
def get_state() -> dict:
    return BUS.state.to_dict()


@router.get("/events")
async def state_events() -> EventSourceResponse:
    """Push every ViewerState change as an SSE message."""
    q = await BUS.subscribe()

    async def gen():
        try:
            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield {"event": payload["type"], "data": json.dumps(payload)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            await BUS.unsubscribe(q)

    return EventSourceResponse(gen())
