"""FastAPI app entry point.

Serves both the JSON API and (when a build exists) the compiled web UI from
one process: routers are registered first, then the SPA is mounted at `/`,
so `/api/*` always wins precedence.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .duck import get_conn
from .routes import datasets, eval_logs, highlights, judges, marks, metrics, plots, prefs, state

# claude-agent-sdk is a default dependency, but degrade gracefully anyway if
# its import breaks: probe the route module import and fall back to a 501
# stub + health flag the UI can read.
try:
    from .routes import chat
except ImportError:
    chat = None  # type: ignore[assignment]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the DuckDB connection at startup so the first request is fast."""
    get_conn()
    yield


app = FastAPI(title="samplescope", lifespan=lifespan)

# Only the vite dev server is cross-origin (the packaged UI is same-origin);
# allow any localhost port so dev proxies don't need CORS surgery.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

app.include_router(datasets.router)
app.include_router(marks.router)
app.include_router(judges.router)
app.include_router(eval_logs.router)
app.include_router(metrics.router)
app.include_router(state.router)
app.include_router(highlights.router)
app.include_router(prefs.router)
app.include_router(plots.router)

if chat is not None:
    app.include_router(chat.router)
else:
    @app.api_route("/api/chat/{rest:path}", methods=["GET", "POST", "PUT", "DELETE"])
    def chat_unavailable(rest: str) -> None:
        raise HTTPException(
            501,
            "chat is unavailable: claude-agent-sdk failed to import (check server logs)",
        )


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "chat_available": chat is not None}


def _web_dist() -> Path | None:
    """Locate the built frontend: packaged `web_dist/` (wheel) or `web/dist`
    (source checkout where `npm run build` has been run)."""
    packaged = Path(__file__).resolve().parents[1] / "web_dist"
    if (packaged / "index.html").exists():
        return packaged
    checkout = Path(__file__).resolve().parents[3] / "web" / "dist"
    if (checkout / "index.html").exists():
        return checkout
    return None


_dist = _web_dist()
if _dist is not None:
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_dist, html=True), name="ui")
