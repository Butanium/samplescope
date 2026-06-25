// Group-by overlay. Fetches the buckets for the chosen column (over the current
// filter/sort/shuffle), publishes them into the nav cursor so j/k step between
// groups, and exposes a locator so the cycler UI can show "member m / M · group
// g / G" for the current row. Purely a navigation overlay — it never changes
// which rows are visible, only how you step through them.

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useViewerState } from "./state";
import { useUrlSync } from "./url";
import { setNavGroups } from "./nav";
import type { GroupBucket } from "./types";

export interface GroupPos {
  gi: number;
  mi: number;
  value: string | null;
  memberCount: number;
}

export function useGroups() {
  const v = useViewerState();
  const { url } = useUrlSync();
  const groupBy = url.groupBy;

  const q = useQuery({
    queryKey: [
      "groups", v.dataset_path, groupBy,
      v.filter_regex, v.filter_column, v.shuffle_seed, v.sort_column, v.sort_desc,
    ],
    queryFn: () =>
      api.groups({
        path: v.dataset_path!,
        column: groupBy!,
        filter_regex: v.filter_regex,
        filter_column: v.filter_column,
        shuffle_seed: v.shuffle_seed ?? null,
        sort_column: v.sort_column,
        sort_desc: v.sort_desc,
      }),
    enabled: !!v.dataset_path && !!groupBy,
  });

  const groups: GroupBucket[] | null = (groupBy && q.data?.groups) || null;

  // Publish to the nav cursor (and tear down when grouping clears / unmounts).
  useEffect(() => {
    setNavGroups(groups ? groups.map((g) => g.indices) : null);
    return () => setNavGroups(null);
  }, [groups]);

  const locator = useMemo(() => {
    const m = new Map<number, GroupPos>();
    groups?.forEach((g, gi) =>
      g.indices.forEach((idx, mi) =>
        m.set(idx, { gi, mi, value: g.value, memberCount: g.indices.length }),
      ),
    );
    return m;
  }, [groups]);

  return {
    groupBy,
    groups,
    groupCount: groups?.length ?? 0,
    truncated: q.data?.truncated ?? false,
    posOf: (idx: number): GroupPos | null => locator.get(idx) ?? null,
  };
}
