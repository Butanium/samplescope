# dataset_viewer — implementation notes

General `apps/` conventions are one level up. README.md is the user quickstart.
This file is for design decisions that aren't self-evident from the code.

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
  one-row-per-sample JSONL under `.cache/eval_materialized/`. That's why
  filter / shuffle / sort / SQL / marks / judges all work on samples without
  per-route branching. `EvalLogView` still hits `/api/eval-logs/samples` for
  the rich card content.

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
