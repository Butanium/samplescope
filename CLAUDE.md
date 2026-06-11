# samplescope — implementation notes

README.md is the user quickstart. This file is for design decisions that
aren't self-evident from the code. Extracted 2026-06-11 from
`astra/conditional_misalignment/apps/dataset_viewer/` (see the initial commit
for the verbatim import; everything after is the standalone adaptation).

## Standalone packaging

- **One process serves API + UI.** The hatch build hook (`hatch_build.py`)
  compiles `web/` and stages it at `src/samplescope/web_dist/`, which the
  wheel embeds. `api/main.py` mounts it at `/` AFTER the routers, so `/api/*`
  wins. In a source checkout without a wheel build, `web/dist` (if built) is
  served instead; the vite dev server is for frontend development only.
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

## Viewer internals (inherited from the astra version)

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
