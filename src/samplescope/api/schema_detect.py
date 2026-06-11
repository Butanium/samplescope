"""Detect a viewer-friendly schema for a JSONL file by sniffing the first N rows."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

ViewKind = Literal["chat", "table", "metrics", "eval_log", "json"]


def detect_view(path: Path, peek: int = 64) -> tuple[ViewKind, dict]:
    """Inspect the first `peek` rows and pick a view kind plus useful metadata.

    Heuristics:
    - All rows have a well-formed `messages: [{role, content}, ...]` list  → chat
    - All rows are flat dicts with a numeric `step` and ≥3 numeric metric cols → metrics
    - Otherwise, all rows are flat dicts (only scalars) → table
    - Else → json (raw tree fallback)
    """
    if path.suffix == ".eval":
        return "eval_log", {}
    if path.suffix.lower() in {".csv", ".tsv"}:
        # CSVs are flat by construction; let TableRowView handle them. Schema +
        # rowcount come from DuckDB downstream in `dataset_info`.
        return "table", {"format": path.suffix.lower().lstrip(".")}
    if not path.exists() or path.stat().st_size == 0:
        return "json", {"empty": True}
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if i >= peek:
                break
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    if not rows:
        return "json", {"empty": True}

    if all(_is_chat_row(r) for r in rows):
        return "chat", {"sampled": len(rows)}
    flat_rows = [r for r in rows if _is_flat(r)]
    if len(flat_rows) == len(rows):
        if any("step" in r for r in rows):
            numeric_cols = _numeric_columns(rows)
            if "step" in numeric_cols and len(numeric_cols) >= 3:
                return "metrics", {"numeric_cols": numeric_cols}
        return "table", {}
    return "json", {}


def _is_chat_row(row: dict) -> bool:
    """A 'chat' row carries a non-empty list of {role, content} messages."""
    msgs = row.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return False
    return all(
        isinstance(m, dict) and "role" in m and "content" in m
        for m in msgs
    )


def _is_flat(row: dict) -> bool:
    """Flat = all values are JSON scalars or short lists/dicts of scalars."""
    for v in row.values():
        if isinstance(v, (str, int, float, bool)) or v is None:
            continue
        if isinstance(v, (list, dict)):
            continue
        return False
    return True


def _numeric_columns(rows: list[dict]) -> list[str]:
    """Columns where every present value is numeric (int/float, not bool)."""
    cols: dict[str, bool] = {}
    for r in rows:
        for k, v in r.items():
            if isinstance(v, bool) or v is None:
                continue
            cols[k] = cols.get(k, True) and isinstance(v, (int, float))
    return [k for k, ok in cols.items() if ok]
