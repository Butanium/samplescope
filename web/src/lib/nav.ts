// Frontend-only nav cursor. The currently-visible view publishes its ordered
// index array (filtered + shuffled, in render order) into this module; Layout
// reads from it when arrow / j / k fire so navigation steps through the SAME
// order the user sees rather than naively doing `row_idx + 1` (which is wrong
// under filter/shuffle and breaks past the first fetched page).
//
// Group-by overlay: when a grouping is published (lib/groups), nextIdx/prevIdx
// step between GROUPS (landing on each group's first member), and nextMember/
// prevMember cycle within the current group. Grouping takes precedence over the
// flat index list — it IS the visible order while active.
//
// No React state — Layout reads the latest pointer on each keypress, so a
// stale capture from a long-lived effect doesn't matter.

let _indices: number[] = [];
let _groups: number[][] | null = null;
let _groupOf: Map<number, number> | null = null;

export function setNavIndices(next: number[]): void {
  _indices = next;
}

/** Publish the group buckets (each an ordered member-idx list), or null to
 *  drop the overlay and fall back to the flat index list. */
export function setNavGroups(groups: number[][] | null): void {
  _groups = groups && groups.length ? groups : null;
  _groupOf = _groups
    ? new Map(_groups.flatMap((g, gi) => g.map((idx) => [idx, gi] as const)))
    : null;
}

export function isGrouped(): boolean {
  return _groups != null;
}

export function nextIdx(current: number): number | null {
  if (_groups && _groupOf) {
    const gi = _groupOf.get(current);
    if (gi == null) return _groups[0][0]; // outside the grouping → first group
    return _groups[Math.min(gi + 1, _groups.length - 1)][0];
  }
  if (_indices.length === 0) return null;
  const i = _indices.indexOf(current);
  if (i < 0) return _indices[0];                               // jumped outside; land on the first visible
  if (i + 1 >= _indices.length) return _indices[i];            // clamp at end
  return _indices[i + 1];
}

export function prevIdx(current: number): number | null {
  if (_groups && _groupOf) {
    const gi = _groupOf.get(current);
    if (gi == null) return _groups[0][0];
    return _groups[Math.max(gi - 1, 0)][0];
  }
  if (_indices.length === 0) return null;
  const i = _indices.indexOf(current);
  if (i < 0) return _indices[0];
  if (i === 0) return _indices[0];
  return _indices[i - 1];
}

/** Next sample sharing the current group's value (null if none / not grouped /
 *  already at the last member). */
export function nextMember(current: number): number | null {
  if (!_groups || !_groupOf) return null;
  const gi = _groupOf.get(current);
  if (gi == null) return null;
  const g = _groups[gi];
  const mi = g.indexOf(current);
  return mi >= 0 && mi + 1 < g.length ? g[mi + 1] : null;
}

export function prevMember(current: number): number | null {
  if (!_groups || !_groupOf) return null;
  const gi = _groupOf.get(current);
  if (gi == null) return null;
  const g = _groups[gi];
  const mi = g.indexOf(current);
  return mi > 0 ? g[mi - 1] : null;
}
