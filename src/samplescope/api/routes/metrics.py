"""Metrics view: training-step time-series for charting."""
from __future__ import annotations

from fastapi import APIRouter

from ..duck import cursor, safe_path
from .datasets import query_path, _read_source

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


@router.get("")
def metrics_series(path: str, columns: str | None = None) -> dict:
    """Return {step, [col]: value} rows. If `columns` is given, project those.

    Routes through `query_path`/`_read_source` so the same plot works for
    JSONL, CSV, plain `.json`, and materialized `.eval` logs.
    """
    p = safe_path(path)
    qp = query_path(p)
    src = _read_source(qp)
    select = "*"
    if columns:
        cols = [c.strip() for c in columns.split(",") if c.strip()]
        cols_q = ", ".join('"' + c.replace('"', '""') + '"' for c in cols)
        select = f"step, {cols_q}"
    with cursor() as cur:
        cur.execute(
            f"SELECT {select} FROM {src} ORDER BY step",
            [str(qp)],
        )
        rows = cur.fetchall()
        col_names = [c[0] for c in cur.description] if cur.description else []
    return {
        "columns": col_names,
        "rows": [dict(zip(col_names, r)) for r in rows],
    }
