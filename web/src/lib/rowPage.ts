// Shared view-data plumbing. Every multi-sample view fetches a window of rows
// the same way and (usually) publishes its visible order into the nav cursor.
// These two hooks are the single home for both contracts so a new view is cheap
// and correct-by-default, and so changing the filter/sort surface or the nav
// protocol is a one-place edit instead of an N-file hunt (where missing one copy
// silently desyncs caches or breaks j/k navigation).

import { useEffect } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
    // Keep the previous window on screen while the next one fetches (e.g.
    // j/k or group-cycling changes `offset`) — a "loading…" flash on every
    // step is pure flicker for a localhost fetch.
    placeholderData: keepPreviousData,
  });
}

/**
 * Infinite-scroll variant of `useRowPage`: pages of `pageSize` rows fetched on
 * demand and concatenated, so a feed view loads more as the user scrolls toward
 * the bottom instead of capping at one fixed window. Same ViewerState→args
 * mapping as `useRowPage` (so filter/sort/shuffle compose), keyed identically
 * minus the offset (the offset is the page cursor here). Returns the flattened
 * rows + indices plus the `fetchNextPage`/`hasNextPage` knobs the virtualizer
 * wires to its scroll position.
 */
export function useRowFeed(name: string, pageSize: number, enabled = true) {
  const v = useViewerState();
  const q = useInfiniteQuery({
    queryKey: [
      name,
      "feed",
      v.dataset_path,
      v.shuffle_seed,
      v.filter_regex,
      v.filter_column,
      v.sort_column,
      v.sort_desc,
      pageSize,
    ],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.rows({
        path: v.dataset_path!,
        offset: pageParam,
        limit: pageSize,
        filter_regex: v.filter_regex,
        filter_column: v.filter_column,
        shuffle_seed: v.shuffle_seed ?? null,
        sort_column: v.sort_column,
        sort_desc: v.sort_desc,
      }),
    // Next cursor = how many rows we've loaded so far, until we've seen them all.
    getNextPageParam: (_last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      const total = all[0]?.total_filtered ?? 0;
      return loaded < total ? loaded : undefined;
    },
    enabled: !!v.dataset_path && enabled,
  });

  const pages = q.data?.pages ?? [];
  return {
    rows: pages.flatMap((p) => p.rows),
    indices: pages.flatMap((p) => p.indices),
    totalFiltered: pages[0]?.total_filtered ?? 0,
    fetchNextPage: q.fetchNextPage,
    hasNextPage: q.hasNextPage,
    isFetchingNextPage: q.isFetchingNextPage,
  };
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
