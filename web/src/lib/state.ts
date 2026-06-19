// Single source of viewer state on the frontend, fed by the /api/state/events SSE.

import { useSyncExternalStore } from "react";
import type { ViewerState } from "./types";
import { sse } from "./api";

const empty: ViewerState = {
  dataset_path: null,
  view_kind: null,
  row_count: 0,
  columns: [],
  numeric_cols: [],
  tabular: false,
  row_idx: 0,
  filter_regex: null,
  filter_column: null,
  shuffle_seed: null,
  sort_column: null,
  sort_desc: false,
  sql_query: null,
  sql_mode: "off",
  sql_selection_count: null,
  sample_n: null,
  last_event: null,
  last_event_ts: 0,
};

let current: ViewerState = empty;
const listeners = new Set<() => void>();

function setState(s: ViewerState) {
  current = s;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot() {
  return current;
}

/** React hook returning the live ViewerState. Components re-render on every patch. */
export function useViewerState(): ViewerState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

let started = false;

/** Open the global SSE state stream once on app load. */
export function startViewerStateStream(): void {
  if (started) return;
  started = true;
  sse("/api/state/events", (_event, data) => {
    if (data?.state) setState(data.state as ViewerState);
  });
}
