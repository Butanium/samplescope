// Group-by data. Fetches the buckets for the chosen column (over the current
// filter/sort/shuffle) and exposes a locator so the cycler UI can show
// "member m / M · group g / G" for a given row. Read-only — publishing the
// buckets into the nav cursor (for single-mode j/k between groups) is done once
// in DatasetHeader, which is always mounted; doing it here would double-publish
// from every caller and desync when GroupedFeed unmounts.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useViewerState } from "./state";
import { useUrlSync } from "./url";
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
      v.filters, v.shuffle_seed, v.sort_column, v.sort_desc,
    ],
    queryFn: () =>
      api.groups({
        path: v.dataset_path!,
        column: groupBy!,
        filters: v.filters,
        shuffle_seed: v.shuffle_seed ?? null,
        sort_column: v.sort_column,
        sort_desc: v.sort_desc,
      }),
    enabled: !!v.dataset_path && !!groupBy,
    // A 400 means the column isn't in this dataset (e.g. the group carried over
    // from a sibling file that had it). Don't retry-spam — just degrade to
    // ungrouped until the user picks a valid column.
    retry: false,
  });

  const groups: GroupBucket[] | null = (groupBy && q.data?.groups) || null;

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
