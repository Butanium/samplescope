// Tiny helper for shift+click → pin to active chat tab.
//
// Usage: `const pin = usePinHandler(); ... onClick={(e) => pin(e, item)}`.
// The handler short-circuits when the user wasn't holding shift.

import { useCallback } from "react";
import { useChatTabs, type ContextItem } from "./chatTabs";
import { useUrlSync } from "./url";

// Plain `Omit<ContextItem, "id">` collapses the union; the distributive form
// keeps each variant intact so TS can narrow off `kind`.
type DistributedOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
type PinPayload = DistributedOmit<ContextItem, "id">;

export function usePinHandler() {
  const { addToActiveContext } = useChatTabs();
  const { setDrawer } = useUrlSync();
  return useCallback(
    (e: React.MouseEvent | React.KeyboardEvent, item: PinPayload): boolean => {
      if (!("shiftKey" in e) || !e.shiftKey) return false;
      e.preventDefault();
      e.stopPropagation();
      addToActiveContext(item, () => setDrawer("chat"));
      return true;
    },
    [addToActiveContext, setDrawer],
  );
}
