// URL ⇄ ViewerState sync. The URL is the bookmarkable representation of:
//   - which dataset is open (`path=<encoded>`)
//   - the current row idx                       (`idx=<n>`)
//   - the active filter list                    (`filters=<json>`; legacy `q`/`qcol`/`qmode`)
//   - the shuffle seed                          (`shuffle=<n>`)
//   - the visible drawer                        (`drawer=chat|marks|judges|sql|help|highlights`)
//   - the chat session id                       (`session=<id>`)
//   - the row-view sub-mode                     (`mode=list|single`)
//   - the render-mode override                  (`view=samples|table|plot|stats`)
//   - whether to render every row as raw JSON   (`raw=1`)
//
// IMPORTANT: the actual URL↔state effects are owned by `<UrlSyncBridge />`
// mounted exactly once at the App root. Component-level callers use the
// read-only `useUrlSync()` hook to GET the URL and push updates via setters;
// they do not run their own effects, otherwise N parallel reconciliations
// race on every render (and that thrashes the API).

import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "./api";
import { useViewerState } from "./state";
import type { FilterSpec } from "./types";

export type DrawerKey = "none" | "chat" | "marks" | "judges" | "sql" | "help" | "highlights" | "plots";
export type ViewMode = "list" | "single";
/** Render-mode override for the multi-view datasets (null = detected default). */
export type RenderView = "samples" | "table" | "plot" | "stats";

/**
 * How a filter's raw text is interpreted. The URL keeps this "pretty" form so a
 * user-typed literal round-trips without leaking its escaped regex, and the
 * stats view can author `exact` chips. `compileTriple` lowers it to the single
 * `{column, regex}` the server understands.
 */
export type FilterMode = "text" | "regex" | "exact";
/** URL/UI representation of one filter: `[column|null, rawText, mode]`. */
export type FilterTriple = [string | null, string, FilterMode];

export type UrlState = {
  path: string | null;
  idx: number;
  filters: FilterTriple[];
  shuffleSeed: number | null;
  sortColumn: string | null;
  sortDesc: boolean;
  sql: string | null;
  sqlMode: "off" | "selection" | "view";
  drawer: DrawerKey;
  session: string | null;
  viewMode: ViewMode;
  view: RenderView | null;
  raw: boolean;
  groupBy: string | null;
};

const DRAWERS: DrawerKey[] = ["none", "chat", "marks", "judges", "sql", "help", "highlights", "plots"];
const RENDER_VIEWS: RenderView[] = ["samples", "table", "plot", "stats"];

export function readUrl(params: URLSearchParams): UrlState {
  const get = (k: string) => params.get(k);
  const drawer = (get("drawer") ?? "none") as DrawerKey;
  return {
    path: get("path") || null,
    idx: parseInt(get("idx") || "0", 10) || 0,
    filters: readFilters(params),
    shuffleSeed: get("shuffle") ? parseInt(get("shuffle")!, 10) : null,
    sortColumn: get("sort") || null,
    sortDesc: get("sortdir") === "desc",
    sql: get("sql") || null,
    sqlMode: (get("sqlmode") === "selection" || get("sqlmode") === "view") ? (get("sqlmode") as any) : "off",
    drawer: DRAWERS.includes(drawer) ? drawer : "none",
    session: get("session") || null,
    viewMode: get("mode") === "single" ? "single" : "list",
    view: RENDER_VIEWS.includes(get("view") as RenderView) ? (get("view") as RenderView) : null,
    raw: get("raw") === "1",
    groupBy: get("group") || null,
  };
}

/** Escape user input so it works as a literal substring inside a regex. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFilterTriple(t: unknown): t is FilterTriple {
  return (
    Array.isArray(t) &&
    t.length === 3 &&
    (t[0] === null || typeof t[0] === "string") &&
    typeof t[1] === "string" &&
    (t[2] === "text" || t[2] === "regex" || t[2] === "exact")
  );
}

/**
 * Read the active filter list from the URL. Prefers the canonical `filters`
 * param (a JSON array of `[column, text, mode]` triples); when it's absent,
 * migrates a legacy single filter (`q` + optional `qcol`/`qmode`) into a
 * one-triple list so old deep links keep working. A malformed `filters` param
 * degrades to no filter rather than crashing the app (URLs are hand-editable).
 */
export function readFilters(params: URLSearchParams): FilterTriple[] {
  const raw = params.get("filters");
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isFilterTriple);
    } catch {
      /* malformed filters param → treat as no filter */
    }
    return [];
  }
  const q = params.get("q");
  if (q) {
    const col = params.get("qcol") || null;
    const mode: FilterMode = params.get("qmode") === "regex" ? "regex" : "text";
    return [[col, q, mode]];
  }
  return [];
}

/**
 * Lower one pretty filter triple to the `{column, regex}` the server consumes:
 * `text` → escaped literal substring, `regex` → verbatim, `exact` → anchored
 * literal (`^…$`). This is the single compile seam — the server never sees the
 * text/mode distinction.
 */
export function compileTriple([column, text, mode]: FilterTriple): FilterSpec {
  const regex =
    mode === "regex" ? text : mode === "exact" ? `^${escapeRegex(text)}$` : escapeRegex(text);
  return { column, regex };
}

export function compileFilters(triples: FilterTriple[]): FilterSpec[] {
  return triples.map(compileTriple);
}

/** Order-sensitive equality of two compiled filter lists (column + regex). */
function compiledFiltersEqual(a: FilterSpec[], b: FilterSpec[]): boolean {
  return (
    a.length === b.length &&
    a.every((f, i) => (f.column ?? null) === (b[i].column ?? null) && f.regex === b[i].regex)
  );
}

/** Read the URL state plus get setters that mutate URL params. No effects. */
export function useUrlSync() {
  const [params, setParams] = useSearchParams();
  const url = readUrl(params);

  const setDrawer = useCallback((d: DrawerKey) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (d === "none") next.delete("drawer");
      else next.set("drawer", d);
      return next;
    }, { replace: true });
  }, [setParams]);

  const setSession = useCallback((id: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("session", id);
      else next.delete("session");
      return next;
    }, { replace: true });
  }, [setParams]);

  const setViewMode = useCallback((m: ViewMode) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (m === "list") next.delete("mode");
      else next.set("mode", m);
      return next;
    }, { replace: true });
  }, [setParams]);

  const setRaw = useCallback((raw: boolean) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (raw) next.set("raw", "1");
      else next.delete("raw");
      return next;
    }, { replace: true });
  }, [setParams]);

  const setView = useCallback((view: RenderView | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (view) next.set("view", view);
      else next.delete("view");
      return next;
    }, { replace: true });
  }, [setParams]);

  const setGroupBy = useCallback((column: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (column) next.set("group", column);
      else next.delete("group");
      return next;
    }, { replace: true });
  }, [setParams]);

  /**
   * Replace the whole active filter list atomically: writes the canonical
   * `filters` URL param (dropping any legacy `q`/`qcol`/`qmode`) and posts the
   * compiled list to the API. Empty list clears the filter.
   */
  const setFilters = useCallback(async (filters: FilterTriple[]) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (filters.length) next.set("filters", JSON.stringify(filters));
      else next.delete("filters");
      next.delete("q");
      next.delete("qcol");
      next.delete("qmode");
      return next;
    }, { replace: true });
    await api.setFilters(compileFilters(filters));
  }, [setParams]);

  return { url, setDrawer, setSession, setViewMode, setView, setRaw, setGroupBy, setFilters };
}

/**
 * Mount once at the App root. Owns the URL↔ViewerState reconciliation:
 *  - On first mount: forces API state to match what the URL says.
 *  - Thereafter: when ViewerState's path/idx/shuffle change, mirrors them
 *    back into the URL (silently, no history push).
 */
export function UrlSyncBridge() {
  const v = useViewerState();
  const [params, setParams] = useSearchParams();
  const initialized = useRef(false);
  // Set once the mount reconciliation below has pushed the URL's filter into
  // state. Until then the mirror must NOT touch the filter params: on first
  // render state is still empty, so a URL filter would look like a divergence
  // and get wiped — losing the pretty text/exact mode (state only carries the
  // compiled regex) and, for a legacy `q` link, dropping it before it applies.
  const mountSynced = useRef(false);
  const prevPath = useRef<string | null>(null);
  // Stable serialization for the mirror effect's dep array (v.filters is a fresh
  // array reference on every SSE patch, even when its contents are unchanged).
  const filtersKey = JSON.stringify(v.filters ?? []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const url = readUrl(params);
    (async () => {
      if (url.path && url.path !== v.dataset_path) {
        await api.openDataset(url.path);
      }
      // Always issue the call so the API's persistent state matches the URL.
      await api.setFilters(compileFilters(url.filters));
      // Sort and shuffle are mutex; URL is the tie-breaker if both are set.
      if (url.sortColumn) {
        await api.setSort(url.sortColumn, url.sortDesc);
      } else if (url.shuffleSeed != null && url.shuffleSeed !== v.shuffle_seed) {
        await api.shuffle(url.shuffleSeed);
      }
      // SQL state runs last so the regex filter and sort/shuffle are already
      // in place when we intersect with the selection.
      if (url.sql && url.sqlMode !== "off") {
        await api.sqlApply(url.sqlMode, url.sql);
      }
      if (url.idx && url.idx !== v.row_idx) {
        await api.goto(url.idx);
      }
      // URL→state is now applied; the mirror may reconcile the filter params.
      mountSynced.current = true;
    })();
  // Mount-only by design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror server-driven state back into the URL.
  useEffect(() => {
    // The render-mode override (`view=`) is per-dataset — drop it when switching
    // to a *different* dataset (its available modes differ), but keep a deep-
    // linked `view=` on first load (prevPath is still null then). Folded into the
    // mirror's single setParams so it can't race a separate `view` writer and
    // clobber the `path` write (react-router batched updaters don't compose).
    const datasetSwitched = prevPath.current !== null && prevPath.current !== v.dataset_path;
    prevPath.current = v.dataset_path;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const setOrDel = (k: string, val: string | number | null | undefined) => {
        if (val == null || val === "") next.delete(k);
        else next.set(k, String(val));
      };
      if (datasetSwitched) next.delete("view");
      setOrDel("path", v.dataset_path);
      setOrDel("idx", v.row_idx || null);
      setOrDel("shuffle", v.shuffle_seed);
      setOrDel("sort", v.sort_column);
      setOrDel("sortdir", v.sort_column && v.sort_desc ? "desc" : null);
      setOrDel("sql", v.sql_mode !== "off" ? v.sql_query : null);
      setOrDel("sqlmode", v.sql_mode !== "off" ? v.sql_mode : null);

      // Filter: state carries the compiled `{column, regex}` list, while the URL
      // keeps the prettier `[column, text, mode]` triples. So only rewrite when
      // the URL's triples no longer compile to the active filter — that
      // preserves a user-typed literal / regex / exact form (which would
      // otherwise leak its escaped regex), while still mirroring an agent-set
      // filter (set via CLI, no matching URL) as verbatim regex triples. A
      // legacy `q`-based URL is migrated to `filters` even when it already
      // matches, so old deep links converge onto the canonical param. Skipped
      // until the mount reconciliation has run (see `mountSynced`), so a
      // deep-linked filter isn't wiped against the initial empty state.
      const urlFilters = readFilters(next);
      if (!mountSynced.current) {
        // Before the mount reconciliation has pushed the URL filter into state,
        // state is still empty — comparing against it would wipe a deep-linked
        // filter. So just canonicalize the URL's *own* representation (folding a
        // legacy `q`/`qcol`/`qmode` link into `filters=`), never consulting
        // state. Idempotent once the URL is already canonical.
        if (urlFilters.length) next.set("filters", JSON.stringify(urlFilters));
        else next.delete("filters");
        next.delete("q");
        next.delete("qcol");
        next.delete("qmode");
      } else {
        const stateFilters = v.filters ?? [];
        if (compiledFiltersEqual(compileFilters(urlFilters), stateFilters)) {
          // URL already compiles to the active filter — leave its pretty triples
          // (a user-typed literal / regex / exact form the state can't recover).
        } else {
          // State diverged (e.g. the chat agent set filters via CLI) — rewrite
          // from state as verbatim regex triples.
          const triples: FilterTriple[] = stateFilters.map((f) => [f.column ?? null, f.regex, "regex"]);
          if (triples.length) next.set("filters", JSON.stringify(triples));
          else next.delete("filters");
          next.delete("q");
          next.delete("qcol");
          next.delete("qmode");
        }
      }

      if (next.toString() !== prev.toString()) return next;
      return prev;
    }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.dataset_path, v.row_idx, v.shuffle_seed, v.sort_column, v.sort_desc, v.sql_query, v.sql_mode, filtersKey]);

  return null;
}
