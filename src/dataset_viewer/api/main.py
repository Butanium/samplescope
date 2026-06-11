"""FastAPI app entry point."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .duck import get_conn
from .routes import chat, datasets, eval_logs, highlights, judges, marks, metrics, plots, prefs, state


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Open the DuckDB connection at startup so the first request is fast."""
    get_conn()
    yield


app = FastAPI(title="dataset_viewer", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
app.include_router(chat.router)
app.include_router(highlights.router)
app.include_router(prefs.router)
app.include_router(plots.router)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}
