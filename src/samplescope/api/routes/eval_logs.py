"""Inspect-AI .eval log reader.

Renders the same per-sample structure inspect's own log viewer shows, but
folds it into the samplescope chrome so marks/judges/chat work uniformly.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ..duck import safe_path

router = APIRouter(prefix="/api/eval-logs", tags=["eval-logs"])


def _to_dict(obj: Any) -> Any:
    """Best-effort recursive conversion of pydantic / dataclass / dict trees."""
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json", exclude_none=True)
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_dict(v) for v in obj]
    return obj


@router.get("/header")
def eval_header(path: str) -> dict:
    """Top-level metadata: task, model, status, plan, results, stats."""
    p = safe_path(path)
    from inspect_ai.log import read_eval_log
    log = read_eval_log(str(p), header_only=True)
    return {
        "version": log.version,
        "status": log.status,
        "eval": _to_dict(log.eval),
        "plan": _to_dict(log.plan),
        "results": _to_dict(log.results),
        "stats": _to_dict(log.stats),
        "error": _to_dict(log.error) if log.error else None,
        # header_only never populates log.samples; the count lives in results.
        # Interrupted runs may lack results entirely — report 0 rather than guess.
        "samples_count": (log.results.total_samples if log.results else None) or 0,
    }


@router.get("/samples")
def eval_samples(path: str, offset: int = 0, limit: int = 50) -> dict:
    """Paged per-sample data, including messages and scores."""
    p = safe_path(path)
    from inspect_ai.log import read_eval_log
    log = read_eval_log(str(p), resolve_attachments="core")
    samples = log.samples or []
    total = len(samples)
    window = samples[offset : offset + limit]
    out = []
    for s in window:
        d = _to_dict(s)
        keep = {
            "id": d.get("id"),
            "epoch": d.get("epoch"),
            "input": d.get("input"),
            "target": d.get("target"),
            "messages": d.get("messages"),
            "output": d.get("output"),
            "scores": d.get("scores"),
            "metadata": d.get("metadata"),
            "error": d.get("error"),
            "model_usage": d.get("model_usage"),
            "total_time": d.get("total_time"),
        }
        out.append(keep)
    return {"samples": out, "offset": offset, "limit": limit, "total": total}


@router.get("/sample")
def eval_sample(path: str, idx: int) -> dict:
    """One full sample, used when the user opens a card."""
    page = eval_samples(path=path, offset=idx, limit=1)
    if not page["samples"]:
        raise HTTPException(404, f"sample {idx} not found")
    return page["samples"][0]
