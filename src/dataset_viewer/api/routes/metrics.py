"""Metrics view: training-step time-series for charting."""
from __future__ import annotations

from fastapi import APIRouter

from ..duck import cursor, safe_path

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


@router.get("")
def metrics_series(path: str, columns: str | None = None) -> dict:
    """Return {step, [col]: value} rows. If `columns` is given, project those."""
    p = safe_path(path)
    select = "*"
    if columns:
        cols = [c.strip() for c in columns.split(",") if c.strip()]
        cols_q = ", ".join('"' + c.replace('"', '""') + '"' for c in cols)
        select = f"step, {cols_q}"
    with cursor() as cur:
        cur.execute(
            f"SELECT {select} FROM read_json_auto(?, format='newline_delimited', union_by_name=true) ORDER BY step",
            [str(p)],
        )
        rows = cur.fetchall()
        col_names = [c[0] for c in cur.description] if cur.description else []
    return {
        "columns": col_names,
        "rows": [dict(zip(col_names, r)) for r in rows],
    }
