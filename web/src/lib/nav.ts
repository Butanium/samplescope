// Frontend-only nav cursor. The currently-visible view publishes its ordered
// index array (filtered + shuffled, in render order) into this module; Layout
// reads from it when arrow / j / k fire so navigation steps through the SAME
// order the user sees rather than naively doing `row_idx + 1` (which is wrong
// under filter/shuffle and breaks past the first fetched page).
//
// No React state — Layout reads the latest pointer on each keypress, so a
// stale capture from a long-lived effect doesn't matter.

let _indices: number[] = [];

export function setNavIndices(next: number[]): void {
  _indices = next;
}

export function nextIdx(current: number): number | null {
  if (_indices.length === 0) return null;
  const i = _indices.indexOf(current);
  if (i < 0) return _indices[0];                               // jumped outside; land on the first visible
  if (i + 1 >= _indices.length) return _indices[i];            // clamp at end
  return _indices[i + 1];
}

export function prevIdx(current: number): number | null {
  if (_indices.length === 0) return null;
  const i = _indices.indexOf(current);
  if (i < 0) return _indices[0];
  if (i === 0) return _indices[0];
  return _indices[i - 1];
}
