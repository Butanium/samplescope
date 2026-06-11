"""`viewer` CLI — drives the dataset viewer through its HTTP API.

Designed for two callers:
  - Clément, from a terminal, as a real interactive tool.
  - Claude, via Bash, as a replacement for the MCP-tool surface.

The CLI hits the same FastAPI endpoints the frontend uses (default
`http://127.0.0.1:8765/api/...`) so there is one source of truth and editing
the CLI mid-chat takes effect on the next subprocess invocation. Override the
base URL with `VIEWER_BASE_URL`.

Output is plain stdout: aligned-column tables for lists, compact JSON for
single objects, and per-row progressive prints for streaming endpoints. Long
fields are truncated at TRUNCATE_AT chars with " …(truncated)".
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable, Optional

import httpx
import typer
from httpx_sse import connect_sse

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Drive the dataset_viewer over its HTTP API.",
)


BASE_URL = os.environ.get("VIEWER_BASE_URL", "http://127.0.0.1:8765").rstrip("/")
TRUNCATE_AT = 4000
HTTP_TIMEOUT = 60.0


# ---------- HTTP plumbing ----------


def _client() -> httpx.Client:
    """Construct a short-lived httpx.Client bound to the viewer base URL."""
    return httpx.Client(base_url=BASE_URL, timeout=HTTP_TIMEOUT)


def _die(msg: str, code: int = 1) -> None:
    """Print an error to stderr and exit non-zero."""
    print(msg, file=sys.stderr)
    raise typer.Exit(code=code)


def _check(resp: httpx.Response) -> Any:
    """Raise via _die on HTTP error, otherwise return the JSON body."""
    if resp.status_code >= 400:
        body = resp.text
        _die(f"HTTP {resp.status_code} {resp.request.method} {resp.request.url}\n{body}")
    if not resp.content:
        return None
    ctype = resp.headers.get("content-type", "")
    if "application/json" in ctype:
        return resp.json()
    return resp.text


def _get(path: str, params: Optional[dict] = None) -> Any:
    """GET /<path> and return parsed JSON (or text)."""
    with _client() as c:
        return _check(c.get(path, params=params))


def _post(path: str, json_body: Optional[dict] = None) -> Any:
    """POST /<path> with optional JSON body."""
    with _client() as c:
        return _check(c.post(path, json=json_body or {}))


def _put(path: str, json_body: Optional[dict] = None) -> Any:
    """PUT /<path> with optional JSON body."""
    with _client() as c:
        return _check(c.put(path, json=json_body or {}))


def _delete(path: str) -> Any:
    """DELETE /<path>."""
    with _client() as c:
        return _check(c.delete(path))


# ---------- Output helpers ----------


def _truncate(s: str, limit: int = TRUNCATE_AT) -> str:
    """Cap a string at `limit` chars, appending an explicit truncation marker."""
    if len(s) <= limit:
        return s
    return s[:limit] + " …(truncated)"


def _stringify(v: Any) -> str:
    """Render any value as a single-line string suitable for table cells."""
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return _truncate(json.dumps(v, default=str, ensure_ascii=False))
    s = str(v)
    if "\n" in s:
        s = s.replace("\n", "\\n")
    return _truncate(s)


def _print_table(rows: list[dict], columns: list[str]) -> None:
    """Render rows as aligned columns. Missing keys render as empty strings."""
    cells = [[_stringify(r.get(c)) for c in columns] for r in rows]
    widths = [len(c) for c in columns]
    for row in cells:
        for i, cell in enumerate(row):
            if len(cell) > widths[i]:
                widths[i] = len(cell)
    widths = [min(w, 80) for w in widths]
    header = "  ".join(c.ljust(widths[i]) for i, c in enumerate(columns))
    print(header)
    print("  ".join("-" * widths[i] for i in range(len(columns))))
    for row in cells:
        print("  ".join(row[i][: widths[i]].ljust(widths[i]) for i in range(len(columns))))


def _print_json(obj: Any, indent: int = 2) -> None:
    """Pretty-print one object as JSON, with the global field-truncation cap."""
    s = json.dumps(obj, indent=indent, default=str, ensure_ascii=False)
    print(_truncate(s, limit=20_000))


def _truncate_row_fields(row: dict) -> dict:
    """Apply TRUNCATE_AT to every field inside a row dict."""
    out: dict = {}
    for k, v in row.items():
        if isinstance(v, str):
            out[k] = _truncate(v)
        elif isinstance(v, (dict, list)):
            out[k] = json.loads(_truncate(json.dumps(v, default=str, ensure_ascii=False)))  # noqa: E501
        else:
            out[k] = v
    return out


def _state() -> dict:
    """Fetch the current viewer state (used by next/prev and mark default-path)."""
    return _get("/api/state")


def _resolve_path(path: Optional[str]) -> str:
    """Use the supplied path or fall back to the currently-open dataset."""
    if path:
        return path
    st = _state()
    if not st.get("dataset_path"):
        _die("no dataset open and no --path supplied")
    return st["dataset_path"]


# ---------- Discovery ----------


@app.command("ls")
def cmd_ls(
    filter_: Optional[str] = typer.Option(None, "--filter", help="substring match on path"),
) -> None:
    """List discoverable datasets (JSONL + .eval files under scan roots)."""
    items = _get("/api/datasets")
    if filter_:
        items = [i for i in items if filter_ in i.get("path", "")]
    rows = [
        {
            "path": i["path"],
            "kind": i["kind"],
            "size_bytes": i["size_bytes"],
            "name": i["name"],
        }
        for i in items
    ]
    _print_table(rows, ["path", "kind", "size_bytes", "name"])
    print(f"\n{len(rows)} dataset(s)")


@app.command("info")
def cmd_info(path: str) -> None:
    """Schema-detect one dataset: row count, columns, view kind."""
    info = _get("/api/datasets/info", params={"path": path})
    _print_json(info)


# ---------- Navigation ----------


@app.command("open")
def cmd_open(path: str) -> None:
    """Open a dataset in the viewer (UI switches live)."""
    info = _post("/api/datasets/open", {"path": path})
    _print_json(info)


@app.command("goto")
def cmd_goto(idx: int) -> None:
    """Move the viewer to row index `idx`."""
    out = _post("/api/datasets/goto", {"idx": int(idx)})
    _print_json(out)


@app.command("next")
def cmd_next() -> None:
    """Step the viewer forward one row (state-aware)."""
    st = _state()
    target = int(st.get("row_idx") or 0) + 1
    out = _post("/api/datasets/goto", {"idx": target})
    _print_json(out)


@app.command("prev")
def cmd_prev() -> None:
    """Step the viewer back one row (state-aware, clamped at 0)."""
    st = _state()
    target = max(0, int(st.get("row_idx") or 0) - 1)
    out = _post("/api/datasets/goto", {"idx": target})
    _print_json(out)


# ---------- Filtering / shuffling ----------


@app.command("filter")
def cmd_filter(
    regex: str,
    column: Optional[str] = typer.Option(None, "--column", help="restrict to one column; omit for whole-row"),
) -> None:
    """Apply a regex filter to the open dataset."""
    out = _post("/api/datasets/filter", {"regex": regex, "column": column})
    _print_json(out)


@app.command("clear-filter")
def cmd_clear_filter() -> None:
    """Remove any active regex filter."""
    out = _post("/api/datasets/filter", {"regex": None, "column": None})
    _print_json(out)


@app.command("shuffle")
def cmd_shuffle(
    seed: Optional[int] = typer.Option(None, "--seed", help="explicit seed; omit for random"),
) -> None:
    """Pick a fresh shuffle seed for the open dataset. Clears any active sort."""
    body: dict = {}
    if seed is not None:
        body["seed"] = int(seed)
    out = _post("/api/datasets/shuffle", body)
    _print_json(out)


@app.command("sort")
def cmd_sort(
    column: str = typer.Argument(..., help="column name to sort by"),
    desc: bool = typer.Option(False, "--desc/--asc", help="sort direction (default ascending)"),
) -> None:
    """Sort the open dataset by a column. Clears any active shuffle."""
    out = _post("/api/datasets/sort", {"column": column, "desc": desc})
    _print_json(out)


@app.command("clear-sort")
def cmd_clear_sort() -> None:
    """Drop the active sort and return to natural / shuffled order."""
    out = _post("/api/datasets/sort", {"column": None})
    _print_json(out)


# ---------- Reads ----------


@app.command("sample")
def cmd_sample(n: int = typer.Argument(..., help="how many rows to draw")) -> None:
    """Pull n random rows from the currently-open dataset."""
    path = _resolve_path(None)
    page = _get("/api/datasets/sample", params={"path": path, "n": int(n)})
    print(f"path={path}  indices={page['indices']}")
    for idx, row in zip(page["indices"], page["rows"]):
        print(f"\n--- row {idx} ---")
        _print_json(_truncate_row_fields(row))


@app.command("rows")
def cmd_rows(
    path: str,
    offset: int = typer.Option(0, "--offset"),
    limit: int = typer.Option(20, "--limit"),
    filter_: Optional[str] = typer.Option(None, "--filter", help="regex filter (whole row or one column)"),
    column: Optional[str] = typer.Option(None, "--column", help="filter only this column"),
    shuffle: Optional[int] = typer.Option(None, "--shuffle", help="seed for stable shuffle"),
) -> None:
    """Read a window of rows from a dataset on disk."""
    params: dict = {"path": path, "offset": int(offset), "limit": int(limit)}
    if filter_ is not None:
        params["filter_regex"] = filter_
    if column is not None:
        params["filter_column"] = column
    if shuffle is not None:
        params["shuffle_seed"] = int(shuffle)
    page = _get("/api/datasets/rows", params=params)
    print(
        f"path={path}  offset={page['offset']} limit={page['limit']}"
        f"  total_filtered={page['total_filtered']}"
    )
    for idx, row in zip(page["indices"], page["rows"]):
        print(f"\n--- row {idx} ---")
        _print_json(_truncate_row_fields(row))


@app.command("row")
def cmd_row(path: str, idx: int) -> None:
    """Read a single row by its original index."""
    row = _get("/api/datasets/row", params={"path": path, "idx": int(idx)})
    _print_json(_truncate_row_fields(row))


# ---------- Marks ----------


def _parse_tags(tags: Optional[str]) -> list[str]:
    """Parse a comma-separated tag list into a clean list[str]."""
    if not tags:
        return []
    return [t.strip() for t in tags.split(",") if t.strip()]


@app.command("mark")
def cmd_mark(
    idx: int,
    tags: Optional[str] = typer.Option(None, "--tags", help="comma-separated tags"),
    note: Optional[str] = typer.Option(None, "--note"),
    path: Optional[str] = typer.Option(None, "--path", help="defaults to the open dataset"),
) -> None:
    """Mark / annotate a row in the currently-open dataset (or --path)."""
    p = _resolve_path(path)
    body = {"tags": _parse_tags(tags), "note": note or ""}
    out = _put(f"/api/marks/{p}/{int(idx)}", body)
    _print_json(out)


@app.command("unmark")
def cmd_unmark(
    idx: int,
    path: Optional[str] = typer.Option(None, "--path"),
) -> None:
    """Remove a row's mark."""
    p = _resolve_path(path)
    out = _delete(f"/api/marks/{p}/{int(idx)}")
    _print_json(out)


@app.command("marks")
def cmd_marks(
    path: Optional[str] = typer.Option(None, "--path", help="filter to one dataset"),
) -> None:
    """List marks across datasets, optionally narrowed."""
    params = {"dataset_path": path} if path else None
    items = _get("/api/marks", params=params)
    rows = [
        {
            "dataset_path": m["dataset_path"],
            "row_idx": m["row_idx"],
            "tags": m["tags"],
            "note": m["note"],
        }
        for m in items
    ]
    _print_table(rows, ["dataset_path", "row_idx", "tags", "note"])
    print(f"\n{len(rows)} mark(s)")


# ---------- Judges ----------


@app.command("judges")
def cmd_judges() -> None:
    """List configured judge presets."""
    items = _get("/api/judges/presets")
    rows = [
        {
            "name": j["name"],
            "kind": j.get("kind") or "prompt",
            "model": j.get("model") or "(default)",
            "score_field": j.get("score_field"),
            "schema": "yes" if j.get("response_schema") else "no",
            "import_path": j.get("scorer_import_path") or "",
            "description": j.get("description") or "",
        }
        for j in items
    ]
    _print_table(
        rows,
        ["name", "kind", "model", "score_field", "schema", "import_path", "description"],
    )
    print(f"\n{len(rows)} preset(s)")


@app.command("add-judge")
def cmd_add_judge(
    name: str,
    prompt_file: Optional[Path] = typer.Option(
        None, "--prompt-file", exists=True, dir_okay=False, readable=True,
        help="prompt-template file with {question}/{answer} slots (mutex with --import-path)",
    ),
    import_path: Optional[str] = typer.Option(
        None, "--import-path",
        help="'module.path:attr' pointing at an inspect @scorer factory (mutex with --prompt-file)",
    ),
    score_field: str = typer.Option("score", "--score-field"),
    schema_file: Optional[Path] = typer.Option(
        None, "--schema-file", exists=True, dir_okay=False, readable=True,
        help="optional JSON-schema file (prompt kind only); judge replies must conform",
    ),
    model: Optional[str] = typer.Option(None, "--model", help="inspect provider/model id"),
    description: Optional[str] = typer.Option(None, "--description"),
) -> None:
    """Save (or replace) a judge preset.

    Choose one backend:

    * ``--prompt-file PATH`` — prompt-template kind. The file may use
      ``{question}/{answer}`` placeholders. Combine with ``--schema-file``
      to enable structured (JSON-schema) output.
    * ``--import-path 'mod.path:fn'`` — scorer kind. The path is resolved via
      ``importlib`` to an inspect ``@scorer``-decorated factory.
    """
    if (prompt_file is None) == (import_path is None):
        _die("specify exactly one of --prompt-file or --import-path")
    body: dict = {"score_field": score_field, "model": model}
    if description is not None:
        body["description"] = description
    if prompt_file is not None:
        body["kind"] = "prompt"
        body["system_prompt"] = prompt_file.read_text()
        if schema_file is not None:
            body["response_schema"] = schema_file.read_text()
    else:
        if schema_file is not None:
            _die("--schema-file only applies to --prompt-file (scorer kind owns its own output shape)")
        body["kind"] = "scorer"
        body["scorer_import_path"] = import_path
    out = _put(f"/api/judges/presets/{name}", body)
    _print_json(out)


@app.command("settings")
def cmd_settings(
    action: str = typer.Argument(..., help="'get' or 'set'"),
    key: Optional[str] = typer.Argument(None, help="for 'set'; only 'default_judge_model' is accepted"),
    value: Optional[str] = typer.Argument(None, help="for 'set'; the new model id"),
) -> None:
    """Read or write judge settings (currently only ``default_judge_model``)."""
    if action == "get":
        _print_json(_get("/api/judges/settings"))
        return
    if action == "set":
        if key != "default_judge_model" or value is None:
            _die("usage: viewer settings set default_judge_model <model_id>")
        out = _put("/api/judges/settings", {"default_judge_model": value})
        _print_json(out)
        return
    _die(f"unknown settings action: {action}; expected 'get' or 'set'")


def _resolve_judge_indices(scope: str, n: int, idx: list[int], dataset_path: str) -> list[int]:
    """Materialize the list of row indices for `viewer judge` from a scope spec."""
    if scope == "current":
        st = _state()
        return [int(st.get("row_idx") or 0)]
    if scope == "indices":
        if not idx:
            _die("scope=indices requires one or more --idx")
        return [int(i) for i in idx]
    if scope == "sample":
        page = _get("/api/datasets/sample", params={"path": dataset_path, "n": int(n)})
        return [int(i) for i in page["indices"]]
    _die(f"unknown scope: {scope}")
    return []


@app.command("judge")
def cmd_judge(
    preset: str,
    scope: str = typer.Option("current", "--scope", help="current | sample | indices"),
    n: int = typer.Option(10, "--n", help="for scope=sample"),
    idx: list[int] = typer.Option([], "--idx", help="for scope=indices; repeat the flag"),
    path: Optional[str] = typer.Option(None, "--path"),
    model: Optional[str] = typer.Option(None, "--model"),
) -> None:
    """Run a judge over rows; results stream to stdout one row at a time."""
    p = _resolve_path(path)
    indices = _resolve_judge_indices(scope, n, idx, p)
    body = {
        "preset_name": preset,
        "dataset_path": p,
        "indices": indices,
        "model": model,
    }
    print(f"preset={preset}  path={p}  indices={indices}")
    with httpx.Client(base_url=BASE_URL, timeout=None) as c:
        with connect_sse(c, "POST", "/api/judges/run", json=body) as event_source:
            if event_source.response.status_code >= 400:
                body_text = event_source.response.read().decode("utf-8", errors="replace")
                _die(f"HTTP {event_source.response.status_code}: {body_text}")
            for ev in event_source.iter_sse():
                if ev.event == "done":
                    print(f"\n[done] {ev.data}")
                    break
                if not ev.data:
                    continue
                payload = json.loads(ev.data)
                row_idx = payload.get("idx")
                score = payload.get("score")
                err = payload.get("error")
                reasoning = payload.get("reasoning") or ""
                progress = payload.get("progress")
                pct = f" {progress * 100:5.1f}%" if isinstance(progress, (int, float)) else ""
                head = f"row {row_idx}{pct}: score={score}"
                if err:
                    head += f"  ERROR={err}"
                print(head)
                if reasoning:
                    print(f"  reasoning: {_truncate(reasoning, 800)}")


# ---------- Highlights ----------


highlights_app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Named highlight rules that color matching text in row content.",
)
app.add_typer(highlights_app, name="highlights")


def _short_id() -> str:
    """Short, URL-safe random id for new rules. Not security-sensitive."""
    import secrets
    return secrets.token_urlsafe(8)


@highlights_app.command("ls")
def cmd_hl_ls() -> None:
    """List all highlight rules in display order."""
    items = _get("/api/highlights")
    rows = [
        {
            "id": r["id"],
            "on": "✓" if r.get("enabled") else "·",
            "name": r["name"],
            "pattern": r["pattern"],
            "regex": "y" if r.get("is_regex") else "",
            "case": "y" if r.get("case_sensitive") else "",
            "color": r["color"],
            "role": r.get("scope_role") or "",
            "column": r.get("scope_column") or "",
            "condition": r.get("condition") or "",
        }
        for r in items
    ]
    _print_table(
        rows,
        ["id", "on", "name", "pattern", "regex", "case", "color", "role", "column", "condition"],
    )
    print(f"\n{len(rows)} rule(s)")


@highlights_app.command("add")
def cmd_hl_add(
    name: str,
    pattern: str = typer.Option(..., "--pattern", help="literal substring or regex source"),
    regex: bool = typer.Option(False, "--regex/--no-regex", help="treat pattern as regex"),
    case: bool = typer.Option(False, "--case/--no-case", help="case-sensitive match"),
    color: str = typer.Option("#fde047", "--color", help="hex color, e.g. #fde047"),
    role: Optional[str] = typer.Option(None, "--role", help="user|assistant|system|tool"),
    column: Optional[str] = typer.Option(None, "--column", help="restrict to one table column"),
    condition: Optional[str] = typer.Option(None, "--condition", help="JS expression on (row, msg)"),
) -> None:
    """Create a new highlight rule. The id is auto-generated."""
    body = {
        "name": name,
        "pattern": pattern,
        "is_regex": regex,
        "case_sensitive": case,
        "color": color,
        "scope_role": role,
        "scope_column": column,
        "condition": condition,
        "enabled": True,
    }
    out = _put(f"/api/highlights/{_short_id()}", body)
    _print_json(out)


@highlights_app.command("rm")
def cmd_hl_rm(rule_id: str) -> None:
    """Delete a rule by id."""
    out = _delete(f"/api/highlights/{rule_id}")
    _print_json(out)


@highlights_app.command("toggle")
def cmd_hl_toggle(rule_id: str) -> None:
    """Flip the ``enabled`` flag for a rule."""
    items = _get("/api/highlights")
    cur = next((r for r in items if r["id"] == rule_id), None)
    if cur is None:
        _die(f"no rule with id={rule_id}")
    cur["enabled"] = not cur.get("enabled", True)
    out = _put(f"/api/highlights/{rule_id}", cur)
    _print_json(out)


# ---------- SQL ----------


@app.command("sql")
def cmd_sql(
    query: str,
    path: Optional[str] = typer.Option(None, "--path", help="bound to FROM t; defaults to open dataset"),
    apply: Optional[str] = typer.Option(
        None, "--apply",
        help="bind to viewer: 'selection' narrows the main view to __idx; "
             "'view' replaces the main view with the SQL result table; "
             "omit to just print the result.",
    ),
) -> None:
    """Run a read-only DuckDB query. `FROM t` aliases the chosen JSONL.

    With --apply, the query also drives the live viewer (see sql_apply route).
    """
    if apply is not None:
        if apply not in ("selection", "view"):
            _die("--apply must be 'selection' or 'view'")
        out = _post("/api/datasets/sql_apply", {"mode": apply, "sql": query})
        _print_json(out)
        return
    p = path
    if p is None:
        st = _state()
        p = st.get("dataset_path")
    body = {"sql": query}
    if p:
        body["path"] = p
    out = _post("/api/datasets/sql", body)
    cols: list[str] = out.get("columns", [])
    rows = [dict(zip(cols, r)) for r in out.get("rows", [])]
    _print_table(rows, cols)
    print(f"\n{len(rows)} row(s)")


@app.command("clear-sql")
def cmd_clear_sql() -> None:
    """Drop any applied SQL selection/view, restoring the natural view."""
    out = _post("/api/datasets/sql_apply", {"mode": "off"})
    _print_json(out)


# ---------- Plot panel ----------


plots_app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Persistent gallery of images, PDFs, and plotly figures.",
)
app.add_typer(plots_app, name="plot")


@plots_app.command("ls")
def cmd_plot_ls() -> None:
    """List every tab currently in the plot panel."""
    items = _get("/api/plots")
    rows = [
        {
            "id": t["id"], "kind": t["kind"], "title": t.get("title") or "",
            "source_path": t.get("source_path") or "",
            "created_at": t.get("created_at") or "",
        }
        for t in items
    ]
    _print_table(rows, ["id", "kind", "title", "source_path", "created_at"])
    print(f"\n{len(rows)} tab(s)")


@plots_app.command("add")
def cmd_plot_add(
    file: Optional[Path] = typer.Option(
        None, "--file", exists=True, dir_okay=False, readable=True,
        help="image (.png/.jpg/.svg/...) or .pdf to attach; kind auto-detected",
    ),
    plotly: Optional[Path] = typer.Option(
        None, "--plotly", exists=True, dir_okay=False, readable=True,
        help="JSON file with a plotly figure spec ({data, layout, ...})",
    ),
    title: Optional[str] = typer.Option(None, "--title", help="display label for the tab"),
) -> None:
    """Add a new tab to the plot panel. Exactly one of --file / --plotly.

    For --file, paths are recorded relative to the repo root and served by
    the API on demand; the file is not copied. Image and PDF tabs are
    deduped: re-adding the same path focuses the existing tab.
    """
    if (file is None) == (plotly is None):
        _die("specify exactly one of --file or --plotly")
    if file is not None:
        ext = file.suffix.lower()
        if ext == ".pdf":
            kind = "pdf"
        elif ext in {".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"}:
            kind = "image"
        else:
            _die(f"unsupported extension {ext}; use .pdf or an image type")
        # Resolve to repo-relative — the API only serves files under the repo root.
        from pathlib import Path as _P
        repo_root = _P(__file__).resolve().parents[2]
        abs_p = file.resolve()
        try:
            rel = abs_p.relative_to(repo_root).as_posix()
        except ValueError:
            _die(f"file must live under repo root ({repo_root})")
        body = {"kind": kind, "source_path": rel, "title": title or file.name}
    else:
        try:
            payload = json.loads(plotly.read_text())
        except Exception as e:
            _die(f"failed to parse plotly JSON: {e}")
        body = {"kind": "plotly", "payload": payload, "title": title or plotly.stem}
    out = _post("/api/plots", body)
    _print_json(out)


@plots_app.command("rm")
def cmd_plot_rm(tab_id: str) -> None:
    """Close a single tab by id."""
    out = _delete(f"/api/plots/{tab_id}")
    _print_json(out)


@plots_app.command("clear")
def cmd_plot_clear() -> None:
    """Close every tab in the plot panel."""
    out = _post("/api/plots/close", {"mode": "all"})
    _print_json(out)


# ---------- Pinned metadata fields (chat-view chip strip) ----------


fields_app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Pin row metadata fields to show above each row in the chat view.",
)
app.add_typer(fields_app, name="fields")


def _pinned_fields_key(path: str) -> str:
    """Pref key matching the frontend's `pinnedFieldsKey()` in ChatRowView."""
    return f"pinnedFields::{path}"


def _get_pinned_fields(path: str) -> list[str]:
    """Read the JSON-encoded list from the shared prefs store."""
    items = _get("/api/prefs") or {}
    raw = items.get(_pinned_fields_key(path))
    if not raw:
        return []
    try:
        val = json.loads(raw)
    except Exception:
        return []
    return [str(v) for v in val] if isinstance(val, list) else []


def _set_pinned_fields(path: str, fields: list[str]) -> None:
    # httpx doesn't auto-encode the path component, so do it explicitly to
    # protect against slashes / colons in the key (dataset paths contain both).
    from urllib.parse import quote
    _put(f"/api/prefs/{quote(_pinned_fields_key(path), safe='')}", {"value": json.dumps(fields)})


@fields_app.command("ls")
def cmd_fields_ls(
    path: Optional[str] = typer.Option(None, "--path", help="defaults to the open dataset"),
) -> None:
    """Show the currently-pinned fields for a dataset."""
    p = _resolve_path(path)
    fields = _get_pinned_fields(p)
    print(f"path={p}")
    print(f"pinned ({len(fields)}): {', '.join(fields) if fields else '(none)'}")


@fields_app.command("set")
def cmd_fields_set(
    columns: list[str] = typer.Argument(..., help="column names to pin (replaces the current list)"),
    path: Optional[str] = typer.Option(None, "--path"),
) -> None:
    """Replace the pinned-field list for a dataset with the given columns."""
    p = _resolve_path(path)
    # Dedupe but preserve order.
    seen: set[str] = set()
    cleaned: list[str] = []
    for c in columns:
        if c and c not in seen:
            seen.add(c)
            cleaned.append(c)
    _set_pinned_fields(p, cleaned)
    print(f"pinned: {', '.join(cleaned) if cleaned else '(none)'}")


@fields_app.command("add")
def cmd_fields_add(
    column: str,
    path: Optional[str] = typer.Option(None, "--path"),
) -> None:
    """Append a column to the pinned list."""
    p = _resolve_path(path)
    fields = _get_pinned_fields(p)
    if column in fields:
        print(f"already pinned: {column}")
        return
    fields.append(column)
    _set_pinned_fields(p, fields)
    print(f"pinned: {', '.join(fields)}")


@fields_app.command("rm")
def cmd_fields_rm(
    column: str,
    path: Optional[str] = typer.Option(None, "--path"),
) -> None:
    """Remove a column from the pinned list."""
    p = _resolve_path(path)
    fields = _get_pinned_fields(p)
    if column not in fields:
        print(f"not pinned: {column}")
        return
    _set_pinned_fields(p, [c for c in fields if c != column])
    print(f"pinned: {', '.join(c for c in fields if c != column) or '(none)'}")


@fields_app.command("clear")
def cmd_fields_clear(
    path: Optional[str] = typer.Option(None, "--path"),
) -> None:
    """Unpin every field."""
    p = _resolve_path(path)
    _set_pinned_fields(p, [])
    print("cleared.")


# ---------- State ----------


@app.command("state")
def cmd_state() -> None:
    """Print the current viewer state (open dataset, row, filter, shuffle, …)."""
    _print_json(_state())


def main() -> None:
    """Entry point shim used when invoked as a module."""
    app()


if __name__ == "__main__":
    main()
