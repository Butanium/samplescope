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

- **JSON cards: schema-keyed top-level field layout.** Only the *outermost*
  object of each row gets it (nested cards keep the plain recursive render).
  Each top-level field is in one of three states — **body** (the card stack),
  **drawer** (folded into "N more fields"), or **header** (a compact chip next
  to the row index) — plus a drag-reorder of the body fields. `useFieldLayout`
  (`JsonTreeView.tsx`) persists `{order, hidden, header}`. The pref key is the
  *schema*, not the path: `json.fields:<fieldSchemaKey>`, an FNV-1a hash of the
  **sorted top-level field names**. So arranging one `{prompt,response,score}`
  file carries to every file with that same field set (sibling result dumps,
  reruns) — and naturally to every sample within a file. `SingleMode`,
  `RecordBlock`, and `FieldHeaderChips` all derive the same key from their row.
  `hidden`/`header` are kept mutually exclusive (each toggle clears the other);
  `normalizeOrder` folds in present-but-unseen keys (natural order, appended)
  and drops stale ones, so a partial persisted `order` never makes a new field
  vanish. Drag uses native HTML5 DnD armed off the grip handle's mousedown (so a
  card header's collapse-click is untouched); the drag *source* lives in a ref,
  not state, because the drop event can fire before React commits the
  dragstart's `setState`. The toolbar's "↺ fields" resets the schema's layout.
  Reads tolerate older two-field (`{order, hidden}`) prefs via `?? []`.

- **Navigation steps through visible order, not `row_idx ± 1`.**
  `web/src/lib/nav.ts` is a module-level cursor; views publish their
  `indexPage.indices` into it via `usePublishNav` (`web/src/lib/rowPage.ts`);
  `Layout` arrow handlers + the header next/prev buttons read via `nextIdx` /
  `prevIdx`. Under shuffle / filter / sort the URL's `idx=` therefore jumps
  non-monotonically — intentional. New views: fetch the page with `useRowPage`
  and publish order with `usePublishNav` rather than re-rolling the `useQuery` +
  `setNavIndices` effect (the shared seam the multi-sample views were factored
  onto).

- **Sort + shuffle are mutex.** `/api/datasets/sort` clears `shuffle_seed`
  and vice versa in the BUS publish; the SQL query in `_build_rows_query`
  picks one ORDER BY branch.

- **Group-by is a navigation overlay, not a different row set.** Pick a column
  (`group=<col>` in the URL, client-only state — never hits ViewerState/SSE) and
  `GET /api/datasets/groups` buckets the *visible* rows (it reuses
  `_build_rows_query`, so it composes with filter/sort/shuffle/SQL-selection);
  groups are ordered by first appearance, members keep visible order. `useGroups`
  (`web/src/lib/groups.ts`) publishes the buckets into the nav cursor via
  `setNavGroups`, which makes `nextIdx`/`prevIdx` (so j/k + header arrows) step
  *between groups* (landing on each group's first member); `nextMember`/
  `prevMember` (the header `Cycler` + `]`/`[`) walk within one group. Grouping
  takes precedence over the flat `setNavIndices` list while active. The view
  itself is untouched — it just renders whatever `row_idx` the overlay lands on,
  so this works for every sample view (chat/json/eval), not just jsonl. The
  endpoint's `__pos` (a ROW_NUMBER over the inner ordered query) pins visible
  order through the grouping projection — a bare subquery wouldn't guarantee it.

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

## Verifying changes

- **Automated tests hit a real server.** `tests/conftest.py` boots a live
  uvicorn `sscope` over a tmp dataset dir (session-scoped `server` fixture) with
  `XDG_STATE_HOME` isolated to a tmp dir, so API tests, `viewer` CLI subprocess
  tests, and the pytest-playwright UI smokes (`tests/test_web.py`) all exercise
  production-like static serving + the instance registry. Add a regression test
  here for new behavior. `test_web.py` skips cleanly when `web/dist` isn't built;
  Playwright is a declared dep (`pyproject.toml`) — `playwright install chromium`
  once if the browser is missing. Run the suite with `uv run python -m pytest`
  (`uv run pytest` fails — pytest isn't exposed as a script).
- **Backend models → TS types are generated, not hand-mirrored.** The Pydantic
  models in `api/models.py` (and the `FileKind`/`ViewKind` literals in
  `api/schema_detect.py`) are the single source of truth; `web/src/lib/
  api-types.gen.ts` is generated from the FastAPI OpenAPI schema via `cd web &&
  npm run gen:types` (= `python -m samplescope._openapi | openapi-typescript`).
  `types.ts` aliases the backend-owned types to the generated ones and
  hand-writes only the deliberate client refinements (`RowPage` rows as `any`,
  `HighlightRule.combinator` union) plus the non-model types (`ViewerState`,
  `PlotTab`, `ChatBlock`). So: changed a model? rerun `gen:types` and commit the
  `.gen.ts` — `tests/test_codegen.py` fails if you forget. This closes the
  cross-language drift that let a missing `kind` literal 500 at runtime.
- **To eyeball a rendering interactively** (vs assert), spin up a throwaway
  instance and screenshot it — same isolation reason as the fixture:
  `state.duckdb` is **single-writer locked**, so you can't open a second
  connection against a running instance's state dir. `export
  XDG_STATE_HOME=$(mktemp -d); sscope <scan-root> --port 8799` (a port the user
  isn't on — check `ss -ltn`; never disturb their instances), then a small
  `sync_playwright()` script. The URL is the full view state (`url.ts`), so you
  can deep-link any view: `?path=<urlenc-rel>&drawer=highlights&mode=single`.
  Launch that server as a process your harness tracks/backgrounds for you — a
  bare `&` / `setsid` / `nohup` gets SIGTERM'd by tool-call cleanup (exit 144,
  server dies mid-test). UI smokes also **leak prefs across runs**:
  `hydrateFromServer()` reloads prefs from the backend state dir even with fresh
  browser localStorage, so a toggle a prior run flipped bleeds into the next —
  use a fresh `XDG_STATE_HOME` per run, or reset the pref via `PUT /api/prefs`.
- **Gotchas.** Build from `web/` (`cd web && npm run build`); at the repo root it
  errors on a missing `package.json`, and a `$?` check on the *wrapping* shell
  reads as a false pass. `get_by_role("button", name=…)` is substring-matched, so
  tree file rows leak into matches — use `exact=True` / scope with
  `get_by_role("main")`. Backend change → restart the server; frontend → rebuild
  + hard-refresh (editable install serves `web/dist` from disk per request).
  Clean up the throwaway server + any test files (never leave them in a scan root).
