"""Detect a viewer-friendly schema for a JSONL file by sniffing the first N rows."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

# The two kind taxonomies are declared here as the single source of truth and
# imported wherever the backend needs them (models, datasets._classify). The
# TS side is *generated* from the OpenAPI schema these feed (see
# `samplescope._openapi` + `web` `npm run gen:types`), so the unions can't drift
# across the language boundary — adding a kind here flows to the frontend.
FileKind = Literal["jsonl", "csv", "parquet", "eval", "json", "pdf", "image", "markdown", "other"]
ViewKind = Literal["chat", "table", "metrics", "eval_log", "json", "markdown"]

MARKDOWN_SUFFIXES = {".md", ".markdown"}


def detect_view(path: Path, peek: int = 64) -> tuple[ViewKind, dict]:
    """Inspect the first `peek` rows and pick a view kind plus useful metadata.

    Heuristics:
    - A `.md`/`.markdown` file is rendered as prose, not parsed as rows → markdown
    - All rows have a well-formed `messages: [{role, content}, ...]` list  → chat
    - All rows are flat dicts with a numeric `step` and ≥3 numeric metric cols → metrics
    - Otherwise, all rows are flat dicts (only scalars) → table
    - Else → json (raw tree fallback)
    """
    if path.suffix == ".eval":
        return "eval_log", {}
    if path.suffix.lower() in MARKDOWN_SUFFIXES:
        return "markdown", {}
    if path.suffix.lower() in {".csv", ".tsv"}:
        return _detect_csv(path, peek)
    if path.suffix.lower() == ".parquet":
        return _detect_parquet(path, peek)
    if not path.exists() or path.stat().st_size == 0:
        return "json", {"empty": True}
    rows: list[dict] = []
    if path.suffix.lower() == ".json":
        # A plain `.json` file is one JSON value, not newline-delimited. Parse
        # the whole thing: an array of dicts is sniffed like JSONL rows; any
        # other shape (lone object, scalars) falls back to the raw tree view.
        # Cap the parse so a pathologically large file can't stall discovery.
        if path.stat().st_size > 64 * 1024 * 1024:
            return "json", {"large": True}
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return "json", {}
        if isinstance(doc, list):
            rows = [r for r in doc[:peek] if isinstance(r, dict)]
        if not rows:
            return "json", {}
    else:
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

    # `numeric_cols` (plottable series) and `tabular` (flat rows → a spreadsheet
    # is meaningful) are reported in every branch so the frontend can offer
    # table / plot as alternate renderings of the same multi-sample dataset.
    flat = all(_is_flat(r) for r in rows)
    if all(_is_chat_row(r) for r in rows):
        return "chat", {"sampled": len(rows), "numeric_cols": _numeric_columns(rows), "tabular": flat}
    return _classify_flat_rows(rows, tabular=flat)


def _classify_flat_rows(rows: list[dict], *, tabular: bool, extra_meta: dict | None = None) -> tuple[ViewKind, dict]:
    """Shared metrics-curve / long-text / table decision over flat rows.

    Rows must already hold JSON scalars (CSV rows are normalized first). Chat
    detection is the caller's job — CSV skips it (a `messages` column there is a
    JSON string the chat renderer can't consume). `tabular` is the flatness
    verdict: always True for CSV, `all(_is_flat)` for JSONL/JSON.
    """
    numeric_cols = _numeric_columns(rows)
    meta = {"numeric_cols": numeric_cols, "tabular": tabular, **(extra_meta or {})}
    if tabular:
        # A genuine training-curve log is a flat dict of mostly numbers, one row
        # per logging step. Per-sample logs (RL rollouts, eval rows) often *also*
        # carry a `step` plus a couple numeric fields (reward/advantage), but
        # they're sample data with rich text — don't hijack them into the
        # chart-only metrics view. Require: a numeric step that's ~unique per row
        # AND no long free-text columns.
        is_curve = (
            "step" in numeric_cols
            and len(numeric_cols) >= 3
            and _step_mostly_unique(rows)
            and not _has_long_text(rows)
        )
        if is_curve:
            return "metrics", meta
        # Flat rows carrying long free-text (prompt/response/thinking) read far
        # better as per-sample cards than as a truncating spreadsheet; a plain
        # tabular dump (short scalars only) stays a table.
        if _has_long_text(rows):
            return "json", meta
        return "table", meta
    return "json", meta


def _detect_csv(path: Path, peek: int) -> tuple[ViewKind, dict]:
    """CSV/TSV: sniff the first `peek` rows so the frontend can offer the same
    samples / table / plot toggle it gets for JSONL. CSV is flat by
    construction, so `tabular` is always True and chat detection is skipped."""
    fmt = path.suffix.lower().lstrip(".")
    try:
        rows = _read_rows_duckdb(path, peek)
    except Exception:
        # Malformed / unreadable CSV is a system boundary — a file listed by the
        # scan can vanish or be half-written before detection runs. Discovery
        # must not 500; fall back to the plain table view. `dataset_info`'s own
        # DuckDB read surfaces the real error to the client if it persists.
        return "table", {"format": fmt}
    return _classify_flat_rows(rows, tabular=True, extra_meta={"format": fmt})


def _detect_parquet(path: Path, peek: int) -> tuple[ViewKind, dict]:
    """Parquet: sniff like JSONL. DuckDB hands STRUCT/LIST columns back as real
    dicts/lists, so the *full* heuristic run applies — including chat detection
    (unlike CSV, where a `messages` cell is an unusable JSON string)."""
    meta = {"format": "parquet"}
    try:
        rows = _read_rows_duckdb(path, peek)
    except Exception:
        # Same system boundary as CSV: a scanned file can vanish / be
        # half-written before detection runs; degrade instead of 500ing.
        return "table", meta
    if not rows:
        # A schema with zero rows: all-rows checks are vacuous, so decide here.
        return "table", {**meta, "empty": True}
    flat = all(_is_flat(r) for r in rows)
    if all(_is_chat_row(r) for r in rows):
        return "chat", {"sampled": len(rows), "numeric_cols": _numeric_columns(rows), "tabular": flat, **meta}
    return _classify_flat_rows(rows, tabular=flat, extra_meta=meta)


def _read_rows_duckdb(path: Path, peek: int) -> list[dict]:
    """Read the first `peek` rows via DuckDB, normalized to JSON scalars."""
    from .duck import cursor
    from .source import read_source_expr

    src = read_source_expr(path)  # read_csv_auto / read_parquet on extension
    with cursor() as cur:
        cur.execute(f"SELECT * FROM {src} LIMIT {int(peek)}", [str(path)])
        cols = [c[0] for c in cur.description] if cur.description else []
        raw = cur.fetchall()
    return [{k: _normalize_scalar(v) for k, v in zip(cols, r)} for r in raw]


def _normalize_scalar(v):
    """Coerce a DuckDB value to a JSON-compatible one for the row heuristics.

    `Decimal` → float (counts as numeric); `date`/`datetime`/other non-JSON
    scalars → a short string (non-numeric, never long text)."""
    from decimal import Decimal

    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (str, int, float)):
        return v
    if isinstance(v, (dict, list)):
        # Parquet STRUCT/LIST columns arrive as real containers — keep them so
        # chat detection and flatness see the same shapes as JSONL rows.
        return v
    return str(v)


def _is_chat_row(row: dict) -> bool:
    """A 'chat' row carries a non-empty list of {role, content} messages."""
    msgs = row.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return False
    return all(
        isinstance(m, dict) and "role" in m and "content" in m
        for m in msgs
    )


def _step_mostly_unique(rows: list[dict], frac: float = 0.9) -> bool:
    """True if `step` is ~one-per-row (a logging curve) vs repeated (per-sample)."""
    steps = [
        r["step"] for r in rows
        if isinstance(r.get("step"), (int, float)) and not isinstance(r.get("step"), bool)
    ]
    if not steps:
        return False
    return len(set(steps)) >= frac * len(steps)


def _has_long_text(rows: list[dict], threshold: int = 200) -> bool:
    """True if any sampled row carries a long free-text string (prompt/response)."""
    return any(
        isinstance(v, str) and len(v) > threshold
        for r in rows for v in r.values()
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
