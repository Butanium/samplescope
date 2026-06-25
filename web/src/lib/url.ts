// URL ⇄ ViewerState sync. The URL is the bookmarkable representation of:
//   - which dataset is open (`path=<encoded>`)
//   - the current row idx                       (`idx=<n>`)
//   - the active filter                         (`q=...`, `qcol=...`, `qmode=text|regex`)
//   - the shuffle seed                          (`shuffle=<n>`)
//   - the visible drawer                        (`drawer=chat|marks|judges|sql|help|highlights`)
//   - the chat session id                       (`session=<id>`)
//   - the row-view sub-mode                     (`mode=list|single`)
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

export type DrawerKey = "none" | "chat" | "marks" | "judges" | "sql" | "help" | "highlights" | "plots";
export type ViewMode = "list" | "single";

export type UrlState = {
  path: string | null;
  idx: number;
  filterText: string | null;
  filterColumn: string | null;
  filterIsRegex: boolean;
  shuffleSeed: number | null;
  sortColumn: string | null;
  sortDesc: boolean;
  sql: string | null;
  sqlMode: "off" | "selection" | "view";
  drawer: DrawerKey;
  session: string | null;
  viewMode: ViewMode;
  raw: boolean;
  groupBy: string | null;
};

const DRAWERS: DrawerKey[] = ["none", "chat", "marks", "judges", "sql", "help", "highlights", "plots"];

export function readUrl(params: URLSearchParams): UrlState {
  const get = (k: string) => params.get(k);
  const drawer = (get("drawer") ?? "none") as DrawerKey;
  return {
    path: get("path") || null,
    idx: parseInt(get("idx") || "0", 10) || 0,
    filterText: get("q") || null,
    filterColumn: get("qcol") || null,
    filterIsRegex: get("qmode") === "regex",
    shuffleSeed: get("shuffle") ? parseInt(get("shuffle")!, 10) : null,
    sortColumn: get("sort") || null,
    sortDesc: get("sortdir") === "desc",
    sql: get("sql") || null,
    sqlMode: (get("sqlmode") === "selection" || get("sqlmode") === "view") ? (get("sqlmode") as any) : "off",
    drawer: DRAWERS.includes(drawer) ? drawer : "none",
    session: get("session") || null,
    viewMode: get("mode") === "single" ? "single" : "list",
    raw: get("raw") === "1",
    groupBy: get("group") || null,
  };
}

/** Escape user input so it works as a literal substring inside a regex. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  const setGroupBy = useCallback((column: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (column) next.set("group", column);
      else next.delete("group");
      return next;
    }, { replace: true });
  }, [setParams]);

  /** Apply a filter atomically: writes URL params + posts to the API. */
  const setFilter = useCallback(async (text: string | null, column: string | null, isRegex: boolean) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (text) next.set("q", text); else next.delete("q");
      if (column) next.set("qcol", column); else next.delete("qcol");
      if (isRegex) next.set("qmode", "regex"); else next.delete("qmode");
      return next;
    }, { replace: true });
    const regex = text ? (isRegex ? text : escapeRegex(text)) : null;
    await api.setFilter(regex, column);
  }, [setParams]);

  return { url, setDrawer, setSession, setViewMode, setRaw, setGroupBy, setFilter };
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

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const url = readUrl(params);
    (async () => {
      if (url.path && url.path !== v.dataset_path) {
        await api.openDataset(url.path);
      }
      const wantedRegex = url.filterText
        ? (url.filterIsRegex ? url.filterText : escapeRegex(url.filterText))
        : null;
      // Always issue the call so the API's persistent state matches the URL.
      await api.setFilter(wantedRegex, url.filterColumn);
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
    })();
  // Mount-only by design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror server-driven state back into the URL.
  useEffect(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const setOrDel = (k: string, val: string | number | null | undefined) => {
        if (val == null || val === "") next.delete(k);
        else next.set(k, String(val));
      };
      setOrDel("path", v.dataset_path);
      setOrDel("idx", v.row_idx || null);
      setOrDel("shuffle", v.shuffle_seed);
      setOrDel("sort", v.sort_column);
      setOrDel("sortdir", v.sort_column && v.sort_desc ? "desc" : null);
      setOrDel("sql", v.sql_mode !== "off" ? v.sql_query : null);
      setOrDel("sqlmode", v.sql_mode !== "off" ? v.sql_mode : null);

      // Filter: state only carries the compiled `filter_regex`, while the URL
      // keeps the user's original text + literal/regex mode. So only rewrite the
      // filter params when the URL doesn't already compile to the active filter
      // — that preserves a user-typed literal (which would otherwise leak its
      // escaped form into `q` and flip `qmode` to regex), while still mirroring
      // an agent-set filter (no prior `q`) as a regex.
      const urlText = next.get("q");
      const urlCol = next.get("qcol") || null;
      const urlRegex = urlText ? (next.get("qmode") === "regex" ? urlText : escapeRegex(urlText)) : null;
      const stateRegex = v.filter_regex || null;
      const stateCol = v.filter_column || null;
      if (urlRegex !== stateRegex || urlCol !== stateCol) {
        if (stateRegex) {
          next.set("q", stateRegex);
          next.set("qmode", "regex");
        } else {
          next.delete("q");
          next.delete("qmode");
        }
        setOrDel("qcol", stateCol);
      }

      if (next.toString() !== prev.toString()) return next;
      return prev;
    }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.dataset_path, v.row_idx, v.shuffle_seed, v.sort_column, v.sort_desc, v.sql_query, v.sql_mode, v.filter_regex, v.filter_column]);

  return null;
}
