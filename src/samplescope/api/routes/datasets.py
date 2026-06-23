"""Dataset discovery + paged row reads, all backed by DuckDB.

`read_json_auto(path, format='newline_delimited', union_by_name=true)` handles
schema variety without a per-file ingest step. Random sampling uses an
order-by-hash trick keyed off a seed so the order is stable for the same seed
yet changes when the user clicks "shuffle".
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from ..duck import cursor, safe_path
from ..models import DatasetEntry, DatasetInfo, RowPage
from ..schema_detect import MARKDOWN_SUFFIXES, detect_view
from ..settings import SETTINGS
from ..state import BUS

router = APIRouter(prefix="/api/datasets", tags=["datasets"])

JSONL_SUFFIXES = {".jsonl", ".ndjson"}
# Tabular formats DuckDB reads natively without a materialization step. CSV/TSV
# are dispatched through `_read_source` like JSONL.
CSV_SUFFIXES = {".csv", ".tsv"}


def _read_source(p: Path, param: str = "?") -> str:
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
    if ext == ".json":
        # A plain `.json` file is a single JSON value — a pretty-printed object
        # or an array of records — not newline-delimited. `format='auto'` lets
        # DuckDB detect the shape: an array becomes one row per element, a lone
        # object becomes a single row. Forcing 'newline_delimited' here 500s on
        # any multi-line JSON.
        return f"read_json_auto({param}, format='auto', union_by_name=true)"
    return f"read_json_auto({param}, format='newline_delimited', union_by_name=true)"

# Eval logs are materialized to one-line-per-sample JSONL under .cache/ on first
# access, then every read goes through the same DuckDB path as a normal JSONL.
# That gives /rows, /sample, /sql, /filter, /shuffle all work over .eval samples
# for free, without per-route branching.
EVAL_MAT_DIR = SETTINGS.cache_dir / "eval_materialized"


def _materialize_eval(p: Path) -> Path:
    """Return a cached newline-delimited JSON view of an .eval log.

    Cache key is `<stem>__<mtime_ns hash>.jsonl`, so edits to the source eval
    re-materialize automatically. Each output row mirrors the field set the
    /api/eval-logs/samples endpoint exposes — id, epoch, input, target,
    messages, output, scores, metadata, error, model_usage, total_time — so
    DuckDB's `read_json_auto` infers a usable schema and a regex filter over
    `to_json(t)` matches anywhere in the sample.
    """
    EVAL_MAT_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(f"{p}|{p.stat().st_mtime_ns}".encode()).hexdigest()[:16]
    out = EVAL_MAT_DIR / f"{p.stem}__{key}.jsonl"
    if out.exists():
        return out
    from inspect_ai.log import read_eval_log
    log = read_eval_log(str(p), resolve_attachments="core")
    KEEP = ("id", "epoch", "input", "target", "messages", "output",
            "scores", "metadata", "error", "model_usage", "total_time")
    tmp = out.with_suffix(out.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for s in (log.samples or []):
            d = s.model_dump(mode="json", exclude_none=True) if hasattr(s, "model_dump") else dict(s)
            row = {k: d.get(k) for k in KEEP if k in d}
            f.write(json.dumps(row, default=str, ensure_ascii=False) + "\n")
    tmp.replace(out)
    return out


def _from_t_clause(p: Path) -> str:
    """Build the ``FROM t`` expansion the /sql + /sql_apply endpoints rewrite to.

    Wrapping in a subquery exposes ``__idx`` (the synthetic row index) so
    user-supplied queries can ``SELECT __idx, … FROM t`` for selection-mode
    binding.
    """
    inline_path = f"'{p}'"
    return (
        f"FROM (SELECT *, ROW_NUMBER() OVER () - 1 AS __idx "
        f"FROM {_read_source(p, param=inline_path)}) t"
    )


def query_path(p: Path) -> Path:
    """Resolve a viewer path to the underlying file DuckDB should read.

    For JSONL/NDJSON this is a no-op. For .eval logs this materializes a cached
    JSONL projection (one sample per row) so the standard read pipeline works.
    """
    if p.suffix.lower() == ".eval":
        return _materialize_eval(p)
    return p


@router.get("/file")
def serve_file(path: str):
    """Serve a raw repo-rooted file (images / PDFs). Used by the plot panel.

    Validates via `safe_path` so requests can't escape the repo root.
    """
    from fastapi.responses import FileResponse
    p = safe_path(path)
    return FileResponse(p)


@router.get("", response_model=list[DatasetEntry])
def list_datasets() -> list[DatasetEntry]:
    """Walk every scan root and return JSONL + .eval + image + PDF files."""
    out: list[DatasetEntry] = []
    for root in SETTINGS.scan_roots:
        if not root.exists():
            continue
        for p in sorted(root.rglob("*")):
            if not p.is_file():
                continue
            kind = _classify(p)
            if kind == "other":
                continue
            try:
                rel = p.relative_to(SETTINGS.root).as_posix()
            except ValueError:
                continue
            out.append(
                DatasetEntry(
                    path=rel,
                    name=p.name,
                    size_bytes=p.stat().st_size,
                    kind=kind,
                    parent=p.parent.relative_to(SETTINGS.root).as_posix(),
                )
            )
    return out


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"}


def _classify(p: Path) -> str:
    """Map an extension to a viewer kind, or 'other' to filter out."""
    s = p.suffix.lower()
    if s in JSONL_SUFFIXES:
        return "jsonl"
    if s in CSV_SUFFIXES:
        return "csv"
    if s == ".eval":
        return "eval"
    if s == ".json":
        return "json"
    if s in MARKDOWN_SUFFIXES:
        return "markdown"
    if s == ".pdf":
        return "pdf"
    if s in IMAGE_SUFFIXES:
        return "image"
    return "other"


@router.get("/info", response_model=DatasetInfo)
def dataset_info(path: str) -> DatasetInfo:
    """Detect schema, count rows, and project the column list."""
    p = safe_path(path)
    view_kind, meta = detect_view(p)
    row_count = 0
    columns: list[str] = []
    if (
        p.suffix.lower() in JSONL_SUFFIXES
        or p.suffix.lower() in CSV_SUFFIXES
        or p.suffix.lower() in {".eval", ".json"}
    ):
        qp = query_path(p)
        src = _read_source(qp)
        with cursor() as cur:
            row_count = cur.execute(
                f"SELECT count(*) FROM {src}",
                [str(qp)],
            ).fetchone()[0]
            cols = cur.execute(
                f"SELECT * FROM {src} LIMIT 1",
                [str(qp)],
            ).description
            columns = [c[0] for c in cols] if cols else []
    return DatasetInfo(
        path=path,
        view_kind=view_kind,
        row_count=row_count,
        columns=columns,
        detect_meta=meta,
    )


def _build_rows_query(
    path: Path,
    filter_regex: str | None,
    filter_column: str | None,
    shuffle_seed: int | None,
    sort_column: str | None = None,
    sort_desc: bool = False,
    sql_selection: list[int] | None = None,
) -> tuple[str, list]:
    """Compose the SELECT for a paged, optionally filtered/sorted/shuffled read.

    `__idx` is the original 0-based row index (i.e. line number in the JSONL).
    DuckDB evaluates window functions *before* QUALIFY, so the index is stable
    under filtering — using WHERE here would renumber over the filtered rows.

    Sort vs shuffle: sort wins if both are set. NULLS LAST so a column with
    sparse coverage doesn't bury the populated rows at the top.

    SQL-driven selection composes with the regex filter via intersection —
    a row must be in the SQL result AND match the regex to be visible. Empty
    selection (`[]`) is treated as "no selection mode" so a query that
    returns zero rows doesn't silently empty the view; that case is surfaced
    via `sql_selection_count` in ViewerState instead.
    """
    qp = query_path(path)
    src = _read_source(qp)
    base = f"SELECT t.*, ROW_NUMBER() OVER () - 1 AS __idx FROM {src} t"
    qualify_parts: list[str] = []
    params: list = [str(qp)]
    if filter_regex:
        if filter_column:
            qualify_parts.append(f"regexp_matches(CAST({_quote_ident(filter_column)} AS VARCHAR), ?)")
        else:
            qualify_parts.append("regexp_matches(to_json(t)::VARCHAR, ?)")
        params.append(filter_regex)
    if sql_selection:
        # Inline the indices: parameterizing a thousand-element list is
        # rejected by DuckDB's prepared-statement layer in older versions
        # and even when accepted bloats the prepared cache. We sanitize by
        # constructing the integer list ourselves above.
        joined = ",".join(str(int(i)) for i in sql_selection)
        qualify_parts.append(f"__idx IN ({joined})")
    qualify = (" QUALIFY " + " AND ".join(qualify_parts)) if qualify_parts else ""
    order = ""
    if sort_column:
        dir_ = "DESC" if sort_desc else "ASC"
        order = f" ORDER BY {_quote_ident(sort_column)} {dir_} NULLS LAST"
    elif shuffle_seed is not None:
        order = f" ORDER BY hash(__idx, {int(shuffle_seed)})"
    return base + qualify + order, params


def _quote_ident(name: str) -> str:
    """Double-quote a column identifier and escape internal quotes."""
    return '"' + name.replace('"', '""') + '"'


@router.get("/rows", response_model=RowPage)
def read_rows(
    path: str,
    offset: int = 0,
    limit: int = Query(50, le=10_000),
    filter_regex: str | None = None,
    filter_column: str | None = None,
    shuffle_seed: int | None = None,
    sort_column: str | None = None,
    sort_desc: bool = False,
) -> RowPage:
    """Return a window of rows. `__idx` is the original 0-based row index."""
    p = safe_path(path)
    # SQL-driven selection is read from server state (not query params): the
    # list can be many thousands of indices and would balloon URL length. It
    # only applies to the currently-open dataset.
    sql_selection: list[int] | None = None
    if (
        BUS.state.sql_mode == "selection"
        and BUS.state.sql_selection is not None
        and BUS.state.dataset_path == path
    ):
        sql_selection = BUS.state.sql_selection
    sql, params = _build_rows_query(
        p, filter_regex, filter_column, shuffle_seed, sort_column, sort_desc, sql_selection,
    )
    paged = sql + f" LIMIT {int(limit)} OFFSET {int(offset)}"
    with cursor() as cur:
        cur.execute(paged, params)
        rows = cur.fetchall()
        cols = [c[0] for c in cur.description] if cur.description else []
        # Total count uses the same WHERE without ORDER/LIMIT/window.
        count_sql = sql.split(" ORDER BY")[0]
        count_outer = f"SELECT count(*) FROM ({count_sql}) sub"
        total = cur.execute(count_outer, params).fetchone()[0]
    indices: list[int] = []
    out: list[dict] = []
    idx_col = cols.index("__idx") if "__idx" in cols else -1
    for r in rows:
        d = dict(zip(cols, r))
        idx = d.pop("__idx", None)
        if idx is None and idx_col >= 0:
            idx = r[idx_col]
        indices.append(int(idx) if idx is not None else -1)
        out.append(_jsonify(d))
    return RowPage(rows=out, indices=indices, offset=offset, limit=limit, total_filtered=int(total))


def _jsonify(d: dict) -> dict:
    """DuckDB returns JSON-typed columns as Python strings; restore native types."""
    out: dict = {}
    for k, v in d.items():
        if isinstance(v, str) and v and v[0] in "{[":
            try:
                out[k] = json.loads(v)
                continue
            except json.JSONDecodeError:
                pass
        out[k] = v
    return out


@router.get("/sample", response_model=RowPage)
def sample_rows(path: str, n: int = 50, seed: int | None = None) -> RowPage:
    """Pull n rows uniformly at random."""
    import random
    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    return read_rows(path=path, offset=0, limit=n, shuffle_seed=seed)


@router.get("/row")
def read_one_row(path: str, idx: int) -> dict:
    """Fetch a single row by its original index."""
    p = safe_path(path)
    qp = query_path(p)
    src = _read_source(qp)
    with cursor() as cur:
        cur.execute(
            f"""
            SELECT * FROM (
                SELECT *, ROW_NUMBER() OVER () - 1 AS __idx
                FROM {src}
            ) WHERE __idx = ?
            """,
            [str(qp), int(idx)],
        )
        row = cur.fetchone()
        cols = [c[0] for c in cur.description] if cur.description else []
    if row is None:
        raise HTTPException(404, f"row {idx} not found")
    d = dict(zip(cols, row))
    d.pop("__idx", None)
    return _jsonify(d)


@router.post("/sql")
def run_sql(payload: dict) -> dict:
    """Run a read-only DuckDB query. The open file is exposed as `t`."""
    sql = payload.get("sql", "")
    path = payload.get("path")
    if not sql.strip():
        raise HTTPException(400, "empty sql")
    if _looks_writey(sql):
        raise HTTPException(400, "only read-only queries are allowed")
    if path:
        p = query_path(safe_path(path))
        sql = sql.replace("FROM t", _from_t_clause(p))
    with cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()
        cols = [c[0] for c in cur.description] if cur.description else []
    return {"columns": cols, "rows": [list(r) for r in rows]}


_WRITE_PATTERN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|attach|detach|copy|truncate|grant|revoke|pragma)\b",
    re.IGNORECASE,
)


def _looks_writey(sql: str) -> bool:
    """Coarse guard: refuse anything that looks like a state-changing statement."""
    return bool(_WRITE_PATTERN.search(sql))


@router.post("/open")
async def open_dataset(payload: dict) -> dict:
    """Mark a dataset as the user's currently-open one and broadcast the change."""
    path = payload["path"]
    info = dataset_info(path=path)
    await BUS.publish(
        "open_dataset",
        dataset_path=path,
        view_kind=info.view_kind,
        row_count=info.row_count,
        columns=info.columns,
        numeric_cols=info.detect_meta.get("numeric_cols", []),
        tabular=info.detect_meta.get("tabular", False),
        row_idx=0,
        filter_regex=None,
        filter_column=None,
        shuffle_seed=None,
        sort_column=None,
        sort_desc=False,
        sql_query=None,
        sql_mode="off",
        sql_selection=None,
        sample_n=None,
    )
    return info.model_dump()


@router.post("/goto")
async def goto_row(payload: dict) -> dict:
    """Update the current row index in shared ViewerState."""
    idx = int(payload["idx"])
    await BUS.publish("goto_row", row_idx=idx)
    return {"ok": True, "row_idx": idx}


@router.post("/filter")
async def set_filter(payload: dict) -> dict:
    """Apply (or clear) the regex filter and broadcast."""
    regex = payload.get("regex") or None
    column = payload.get("column") or None
    await BUS.publish("set_filter", filter_regex=regex, filter_column=column, row_idx=0)
    return {"ok": True}


@router.post("/shuffle")
async def shuffle(payload: dict | None = None) -> dict:
    """Set a new shuffle seed. Clears any active sort (mutex)."""
    import random
    payload = payload or {}
    seed = payload.get("seed")
    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    await BUS.publish(
        "shuffle", shuffle_seed=int(seed), sort_column=None, sort_desc=False, row_idx=0,
    )
    return {"ok": True, "seed": seed}


@router.post("/sql_apply")
async def sql_apply(payload: dict) -> dict:
    """Bind a SQL query into the viewer.

    Modes:
      - "off": forget the SQL, clear any selection.
      - "selection": run the SQL, take its `__idx` column as the visible
        row set (intersected with regex filter on subsequent reads). The
        SQL must return an `__idx` column; recommended shape is
        `SELECT __idx, … FROM t WHERE …`.
      - "view": store the SQL + flip the main view to render the SQL
        result table (rendered by the frontend's SqlView). No __idx required.
    """
    mode = payload.get("mode", "off")
    if mode not in ("off", "selection", "view"):
        raise HTTPException(400, "mode must be one of: off, selection, view")
    sql_text = (payload.get("sql") or "").strip()

    if mode == "off":
        await BUS.publish("sql_apply", sql_query=None, sql_mode="off", sql_selection=None, row_idx=0)
        return {"ok": True, "mode": "off", "selection_count": None}

    if not sql_text:
        raise HTTPException(400, "non-empty 'sql' required for mode=selection|view")
    if _looks_writey(sql_text):
        raise HTTPException(400, "only read-only queries are allowed")

    if mode == "view":
        # Don't run yet — SqlView fetches via /api/datasets/sql with the same string.
        await BUS.publish("sql_apply", sql_query=sql_text, sql_mode="view", sql_selection=None, row_idx=0)
        return {"ok": True, "mode": "view", "selection_count": None}

    # mode == "selection": run now and capture __idx.
    if not BUS.state.dataset_path:
        raise HTTPException(400, "no dataset open; cannot apply selection")
    p = query_path(safe_path(BUS.state.dataset_path))
    expanded = sql_text.replace("FROM t", _from_t_clause(p))
    with cursor() as cur:
        cur.execute(expanded)
        rows = cur.fetchall()
        cols = [c[0] for c in cur.description] if cur.description else []
    if "__idx" not in cols:
        raise HTTPException(
            400,
            "selection mode requires the query to project an `__idx` column; try `SELECT __idx, ... FROM t WHERE ...`",
        )
    idx_col = cols.index("__idx")
    indices = [int(r[idx_col]) for r in rows if r[idx_col] is not None]
    await BUS.publish(
        "sql_apply", sql_query=sql_text, sql_mode="selection", sql_selection=indices, row_idx=0,
    )
    return {"ok": True, "mode": "selection", "selection_count": len(indices)}


_NL_SQL_SYSTEM = """\
You translate plain-English research questions into a single DuckDB SQL query
over the open dataset. The query MUST:

- Be a single SELECT statement (no INSERT/UPDATE/DDL).
- Reference the open dataset via the alias `FROM t` exactly — the backend
  rewrites `t` to point at the right file. Do not invent table names.
- Include an `__idx` column in the projection when the user's question is
  "find me rows where …" — that lets the viewer narrow its main pane to
  those rows. Aggregations (counts, group-by) don't need __idx.

DuckDB schema access — read the column-types listing in the grounding
section carefully and follow these rules:

- Nested fields are **parsed STRUCT/LIST values, not JSON strings**. Access
  them with dot notation: `scores.cheap_alignment_judge.value`, not
  `json_extract_string(scores, '$.cheap_alignment_judge.value')`. Dot access
  preserves the underlying numeric type, so comparisons like
  `scores.cheap_alignment_judge.value < 30` work directly with no CAST.
- LIST elements are 1-indexed in DuckDB: `messages[1].role` is the first
  message. Use `len(messages)` for length.
- For genuinely dynamic JSON (only when the column type is literally `JSON`
  in the schema below — uncommon), use `json_extract` / `json_extract_string`.
- NEVER guess inner field names — only use names that appear in the listed
  STRUCT type. If a needed field isn't in the schema, say so in the
  explanation and write a best-effort query that still parses.

Keep the explanation to one or two short sentences focused on WHY the query
answers the user's question — not a play-by-play of the SQL.
"""


_NL_SQL_SCHEMA = {
    "type": "object",
    "properties": {
        "sql": {
            "type": "string",
            "description": "A single DuckDB SELECT query using `FROM t`. Include `__idx` in the projection when the question is row-selection-shaped.",
        },
        "explanation": {
            "type": "string",
            "description": "One or two sentences on why this query answers the user's question.",
        },
    },
    "required": ["sql", "explanation"],
}


_NL_MODEL_ALIASES = {"sonnet", "opus", "haiku"}


@router.post("/sql_nl")
async def sql_from_nl(payload: dict) -> dict:
    """Translate a natural-language prompt to DuckDB SQL via Claude.

    Uses claude-agent-sdk with ``output_format={"type":"json_schema"}`` so the
    response comes back already-parsed in ``ResultMessage.structured_output``
    — no tool-use dance, no prose-around-JSON parsing. The agent runs with no
    tools and ``max_turns=1`` so it has no path other than producing the
    structured answer.

    Returns {sql, explanation, model}. The frontend previews both and lets the
    user accept (which populates the SQL editor) before running / applying.
    """
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "empty 'prompt'")
    requested_model = (payload.get("model") or "sonnet").strip().lower()
    if requested_model not in _NL_MODEL_ALIASES:
        raise HTTPException(400, f"model must be one of {sorted(_NL_MODEL_ALIASES)}")
    if not BUS.state.dataset_path:
        raise HTTPException(400, "no dataset open; cannot ground the prompt")

    # No explicit API-key check: claude-agent-sdk authenticates via either
    # ANTHROPIC_API_KEY or an existing `claude` CLI session. Let the SDK
    # surface whatever auth error actually applies.

    # Ground the model with the DESCRIBE'd column types (so nested STRUCT
    # field names are explicit) plus a single sample row for value shapes.
    p = query_path(safe_path(BUS.state.dataset_path))
    schema_lines: list[str] = [f"Dataset path: {BUS.state.dataset_path}"]
    try:
        with cursor() as cur:
            described = cur.execute(
                "DESCRIBE SELECT * FROM read_json_auto(?, format='newline_delimited', union_by_name=true) LIMIT 1",
                [str(p)],
            ).fetchall()
            schema_lines.append("Columns (DuckDB-inferred types):")
            for row in described:
                col_name, col_type = row[0], row[1]
                schema_lines.append(f"  - {col_name}: {col_type}")
            cur.execute(
                "SELECT * FROM read_json_auto(?, format='newline_delimited', union_by_name=true) LIMIT 1",
                [str(p)],
            )
            sample_row = cur.fetchone()
            cols = [c[0] for c in (cur.description or [])]
        if sample_row:
            sample_dict = dict(zip(cols, sample_row))
            schema_lines.append("")
            schema_lines.append("Sample row (truncated):")
            schema_lines.append(json.dumps(sample_dict, default=str, indent=2)[:1500])
    except Exception as e:
        schema_lines.append(f"(schema introspection failed: {e}; columns from open_dataset: {BUS.state.columns})")
    schema_hint = "\n".join(schema_lines)

    # SDK accepts plain aliases ("sonnet", "opus", "haiku") and resolves to the
    # current default version. Env override available for pinning specific IDs.
    model = os.environ.get("SAMPLESCOPE_NL_MODEL") or requested_model
    try:
        from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query
    except ImportError:
        raise HTTPException(
            501,
            "NL→SQL is unavailable: claude-agent-sdk failed to import (check server logs)",
        )
    options = ClaudeAgentOptions(
        system_prompt=_NL_SQL_SYSTEM + "\n\n" + schema_hint,
        output_format={"type": "json_schema", "schema": _NL_SQL_SCHEMA},
        # Allow a couple of turns: the SDK counts the structured-output emission
        # plus an internal acknowledgement, so max_turns=1 reliably trips
        # `error_max_turns` even when the schema was correctly produced.
        max_turns=3,
        allowed_tools=[],  # no Read/Bash/etc. — agent's only job is to emit the schema.
        model=model,
        cwd=str(SETTINGS.root),
    )

    structured: dict | None = None
    used_model = model
    agent_error: str | None = None
    try:
        async for msg in query(prompt=prompt, options=options):
            if isinstance(msg, ResultMessage):
                if msg.structured_output is not None:
                    structured = msg.structured_output
                if msg.model_usage:
                    used_model = next(iter(msg.model_usage.keys()), used_model)
                if msg.is_error and structured is None:
                    # Only surface the agent-level error if we didn't get the
                    # structured output anyway — output_format sometimes lands
                    # the JSON before the turn-count check trips.
                    agent_error = msg.result or msg.subtype
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")

    if not isinstance(structured, dict) or "sql" not in structured:
        raise HTTPException(500, agent_error or "agent did not return a structured {sql, explanation}")

    return {
        "sql": str(structured.get("sql", "")).strip(),
        "explanation": str(structured.get("explanation", "")).strip(),
        "model": used_model,
    }


@router.post("/sort")
async def set_sort(payload: dict | None = None) -> dict:
    """Sort rows by a column ASC/DESC. Pass `{column: null}` to clear.

    Mutex with shuffle: setting a sort clears `shuffle_seed`.
    """
    payload = payload or {}
    column = payload.get("column")
    desc = bool(payload.get("desc", False))
    if column is not None and not isinstance(column, str):
        raise HTTPException(400, "'column' must be a string or null")
    await BUS.publish(
        "set_sort",
        sort_column=column or None,
        sort_desc=desc if column else False,
        shuffle_seed=None if column else BUS.state.shuffle_seed,
        row_idx=0,
    )
    return {"ok": True, "column": column or None, "desc": desc}
