"""The DuckDB table-producing expression for a dataset path.

Extracted from ``api/routes/datasets.py`` so schema detection can build the
same read expression without importing the datasets router — that import would
create a ``datasets`` ↔ ``schema_detect`` cycle (datasets imports detect_view;
schema_detect now needs the read expression to sniff CSV rows).
"""
from __future__ import annotations

from pathlib import Path


def read_source_expr(p: Path, param: str = "?") -> str:
    """Return the DuckDB table-producing expression for a path's extension.

    `param` is the placeholder (use `?` for parameterized queries; pass a
    literal `'...'`-wrapped path for inline use in `_from_t_clause`).
    Dispatch is on the *post* `query_path` extension — `.eval` doesn't reach
    here because it's materialized to JSONL first.
    """
    ext = p.suffix.lower()
    if ext == ".tsv":
        return f"read_csv_auto({param}, header=true, delim='\\t')"
    if ext == ".csv":
        return f"read_csv_auto({param}, header=true)"
    if ext == ".parquet":
        return f"read_parquet({param})"
    if ext == ".json":
        # A plain `.json` file is a single JSON value — a pretty-printed object
        # or an array of records — not newline-delimited. `format='auto'` lets
        # DuckDB detect the shape: an array becomes one row per element, a lone
        # object becomes a single row. Forcing 'newline_delimited' here 500s on
        # any multi-line JSON.
        return f"read_json_auto({param}, format='auto', union_by_name=true)"
    return f"read_json_auto({param}, format='newline_delimited', union_by_name=true)"
