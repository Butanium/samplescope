// Shared view-data plumbing. Every multi-sample view fetches a window of rows
// the same way and (usually) publishes its visible order into the nav cursor.
// These two hooks are the single home for both contracts so a new view is cheap
// and correct-by-default, and so changing the filter/sort surface or the nav
// protocol is a one-place edit instead of an N-file hunt (where missing one copy
// silently desyncs caches or breaks j/k navigation).

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useViewerState } from "./state";
import { setNavIndices } from "./nav";

/**
 * A react-query over `api.rows`, keyed on the dataset plus every ViewerState
 * dimension that changes the result (filter / sort / shuffle / window). `name`
 * keeps each view's cache separate; `limit`, `offset`, and `enabled` are the
 * only per-view knobs. Centralizing the ViewerState→args mapping here is the
 * point: adding a new filter/sort dimension touches this one function, not the
 * six call sites that used to copy it (and a stale-cache bug if you missed one).
 */
export function useRowPage(
  name: string,
  { limit, offset = 0, enabled = true }: { limit: number; offset?: number; enabled?: boolean },
) {
  const v = useViewerState();
  return useQuery({
    queryKey: [
      name,
      v.dataset_path,
      v.shuffle_seed,
      v.filter_regex,
      v.filter_column,
      v.sort_column,
      v.sort_desc,
      offset,
      limit,
    ],
    queryFn: () =>
      api.rows({
        path: v.dataset_path!,
        offset,
        limit,
        filter_regex: v.filter_regex,
        filter_column: v.filter_column,
        shuffle_seed: v.shuffle_seed ?? null,
        sort_column: v.sort_column,
        sort_desc: v.sort_desc,
      }),
    enabled: !!v.dataset_path && enabled,
  });
}

/**
 * Publish a view's visible index order into the nav cursor (lib/nav) so Layout's
 * arrow / j / k step through what's on screen under filter/shuffle/sort, and
 * clear it on unmount. `active=false` publishes an empty list without dropping
 * the call (lets a view gate nav on, e.g., "only when reordered"). This contract
 * is easy to get subtly wrong when hand-copied into a new view — keep it here.
 */
export function usePublishNav(indices: number[] | undefined, active = true): void {
  useEffect(() => {
    setNavIndices(active ? (indices ?? []) : []);
    return () => setNavIndices([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, indices?.join(",")]);
}
