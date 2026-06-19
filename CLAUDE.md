# samplescope — implementation notes

README.md is the user quickstart. This file is for design decisions that
aren't self-evident from the code.

## Standalone packaging

- **One process serves API + UI.** The hatch build hook (`hatch_build.py`)
  compiles `web/` and stages it at `src/samplescope/web_dist/`, which the
  wheel embeds. `api/main.py` mounts it at `/` AFTER the routers, so `/api/*`
  wins. In a source checkout without a wheel build, `web/dist` (if built) is
  served instead; the vite dev server is for frontend development only.
- **Dev install is editable** (`uv tool install --force -e .`): the tool venv
  imports straight from `src/`, and `_web_dist()` prefers the checkout's
  `web/dist` over the staged wheel copy. Dev loop: python edit → restart
  `sscope`; frontend edit → `npm run build` → browser refresh. No reinstall
  unless dependencies change. (Non-editable installs from a local path need a
  cache bust: `uv tool install --force --reinstall --refresh-package
  samplescope --from . samplescope` — uv happily reuses a stale cached wheel
  otherwise.) The hatch hook skips the npm build for editable installs.
- **Config flows through env vars.** `serve.py` translates CLI args into
  `SAMPLESCOPE_*` env vars *before* importing the app, because
  `api/settings.py` resolves `SETTINGS` at import time and uvicorn `--reload`
  re-imports in a child process (env survives; function args wouldn't).
- **State lives in `~/.local/state/samplescope/<key>/`**, keyed by a hash
  of the resolved scan-root set (`settings.scan_roots_key`). Same dirs →
  same marks/judges/prefs across restarts; different dir sets are isolated.
  The materialized-`.eval` cache lives in `<key>/cache/`.
- **Instance discovery** (`instances.py`): servers register
  `{pid, host, port, scan_roots}` in
  `~/.local/state/samplescope/instances.json` (flock-serialized; stale
  pids pruned on every read). The `viewer` CLI picks the instance whose
  deepest scan root contains cwd; one running instance is used as fallback;
  real ambiguity errors out listing candidates. `VIEWER_BASE_URL` /
  `--base-url` bypass discovery. The chat-spawned `viewer` subprocess gets
  `VIEWER_BASE_URL` injected via `ClaudeAgentOptions.env` (which the SDK
  *merges* into the inherited environment) so it always self-targets.
- **`SETTINGS.root`** is the common ancestor of all scan roots; every
  dataset path in the API is relative to it and `safe_path` refuses escapes.
  With multiple scan roots the root can be high (e.g. `~`); acceptable for a
  localhost-only single-user tool.
- **Chat ships by default** (claude-agent-sdk is a regular dependency; it
  was briefly an optional `[chat]` extra — Clément chose default-on).
  `api/main.py` still probes the `routes.chat` import and falls back to a
  501 stub on `/api/chat/*` if the SDK somehow fails to import;
  `/api/health` reports `chat_available` so the UI can degrade. NL→SQL
  (`/api/datasets/sql_nl`) guards its lazy SDK import the same way.
- **Port auto-pick**: no `--port` → first free port from 8765 (multi-instance
  is a first-class workflow); explicit `--port` taken → hard error.

## Viewer internals

- **View kind vs render mode.** `detect_view` (`api/schema_detect.py`) sniffs
  the first rows and returns a `view_kind` (chat / table / metrics / eval_log /
  json) plus meta `numeric_cols` + `tabular`. Heuristics worth knowing: flat
  rows carrying long free-text (prompt/response/thinking) → `json` (per-sample
  *cards*, not the truncating spreadsheet); a flat numeric log is only `metrics`
  if `step` is ~unique per row AND there's no long text (otherwise it's
  per-sample data that merely has a `step`). `Layout.tsx`'s `ViewSwitch` then
  turns `view_kind` + `numeric_cols`/`tabular` into a **samples / table / plot**
  toggle over the *same* dataset; `JsonTreeView` adds a **single / scroll**
  (feed, virtualized) sub-toggle sharing `url.viewMode` with the chat view.
  So "what you see" = detection default, overridable client-side; nothing is
  locked to one renderer.

- **Navigation steps through visible order, not `row_idx ± 1`.**
  `web/src/lib/nav.ts` is a module-level cursor; views publish their
  `indexPage.indices` into it; `Layout` arrow handlers + the header next/prev
  buttons read via `nextIdx` / `prevIdx`. Under shuffle / filter / sort the
  URL's `idx=` therefore jumps non-monotonically — intentional.

- **Sort + shuffle are mutex.** `/api/datasets/sort` clears `shuffle_seed`
  and vice versa in the BUS publish; the SQL query in `_build_rows_query`
  picks one ORDER BY branch.

- **`.eval` logs route through the JSONL pipeline via cache materialization.**
  `query_path(p)` in `api/routes/datasets.py` swaps any `.eval` for a cached
  one-row-per-sample JSONL under the state-dir cache. That's why
  filter / shuffle / sort / SQL / marks / judges all work on samples without
  per-route branching. `EvalLogView` still hits `/api/eval-logs/samples` for
  the rich card content.

- **CSV/TSV dispatch in `_read_source`.** DuckDB `read_csv_auto` vs
  `read_json_auto` chosen on extension; everything downstream is shared.

- **Cross-browser prefs: localStorage cache + DuckDB backend.**
  `web/src/lib/prefs.ts`. `usePref`'s `readLocal` memoizes by `(key, raw)` —
  required so `useSyncExternalStore` doesn't loop on `Maximum update depth`.
  `hydrateFromServer()` runs once at app boot from `App.tsx`.

- **Plot panel = persistent gallery.** `api/routes/plots.py` + `PlotPanel.tsx`.
  Image/PDF tabs are deduped server-side on `(kind, source_path)` so clicking
  the same file twice focuses the existing tab. Plotly tabs hold the figure
  spec inline. SSE on `/api/plots/events` pushes the tab list — `sse()` in
  `api.ts` must list every event name it expects (added `"tabs"`; future
  channels need the same).

- **Chat: adaptive thinking with summarizer.** `chat.py` passes
  `thinking={"type": "adaptive", "display": "summarized"}`. Without
  `display="summarized"` the SDK returns encrypted-only ThinkingBlocks
  (text empty, signature populated) and the UI's collapsible looks broken.
  No block at all = adaptive judged the prompt trivial; not a bug.

- **Chat history survives drawer close/reopen.** `ChatTab` rehydrates from
  `/api/chat/sessions/{id}/history` on every mount. `readOnlyHistorical`
  controls only the composer's disabled state — don't conflate with history
  loading.

## Verifying changes (don't fly blind on UI work)

The fastest loop for confirming a change actually renders/behaves correctly,
without touching the user's running instances:

- **Spin up a throwaway instance on a distinct port with an isolated state dir.**
  `state.duckdb` is **single-writer locked** — opening a second connection
  against a running instance's state dir (its `~/.local/state/samplescope/<key>/`)
  fails with a DuckDB lock IOException. So: `export XDG_STATE_HOME=$(mktemp -d)`
  then `sscope <scan-root> --port 8799` (pick a port the user isn't on; check
  `ss -ltn`). Isolated state also means marks/judges/prefs/highlights start
  empty, which is usually what you want for a clean check.
- **Same trick for quick backend checks**: set `SAMPLESCOPE_SCAN_ROOTS` +
  `XDG_STATE_HOME=$(mktemp -d)` and import the route functions directly
  (`from samplescope.api.routes.datasets import dataset_info, read_one_row`),
  or hit the throwaway server with `curl`.
- **Screenshots**: Playwright + a cached chromium are available
  (`uv run python` with `from playwright.sync_api import sync_playwright`). Drive
  `http://127.0.0.1:8799/?path=<urlencoded-rel>&drawer=highlights&...` — the URL
  is the full view state (see `url.ts`), so you can deep-link any view. Gotchas:
  `get_by_role("button", name=...)` is substring-matched, so tree file rows leak
  into matches (use `exact=True` and/or scope with `get_by_role("main")`).
- **Build from `web/`, not the repo root** (`cd web && npm run build`); running
  it at the root fails on missing `package.json` and silently looks "passed" if
  you only check the wrapping shell's exit code. Backend change → restart the
  server; frontend change → rebuild + hard-refresh (the editable install serves
  `web/dist` from disk per request).
- Clean up the throwaway server (`pkill -f "samplescope.*8799"`) and any demo
  files when done; never leave test files inside the user's scan roots.
