// In-memory map of "this row/message is raw" overrides. Module-level so
// virtualized RowBlock unmount/remount doesn't lose user clicks. Keyed by
// stable id (e.g. "row::<path>::<idx>" or "msg::<path>::<idx>::<msgIdx>").
//
// Resolution: if a key has an override, the override wins. Otherwise the
// caller's `def` (typically the parent's resolved value, ultimately the
// global URL `&raw=1` flag) is used.

import { useCallback, useSyncExternalStore } from "react";

const overrides: Map<string, boolean> = new Map();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * @param key   stable unique id for this row or message.
 * @param def   default value when no override exists (parent-derived).
 * @returns     [resolvedValue, toggle] — clicking once stores the inverse of
 *              `def` as the override; clicking again clears it.
 */
export function useRawOverride(key: string, def: boolean): [boolean, () => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => (overrides.has(key) ? (overrides.get(key) as boolean) : def),
    () => def,
  );
  const toggle = useCallback(() => {
    if (overrides.has(key)) {
      // Already overridden — toggle the override instead of clearing, so
      // each click flips the value (most natural for a button).
      const cur = overrides.get(key) as boolean;
      // If toggling brings us back to `def`, clear the override so future
      // changes to the default propagate naturally.
      if (cur === def) overrides.delete(key);
      else overrides.set(key, !cur);
    } else {
      overrides.set(key, !def);
    }
    notify();
  }, [key, def]);
  return [value, toggle];
}
