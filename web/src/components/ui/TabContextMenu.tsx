import { useEffect } from "react";
import { cn } from "../../lib/utils";

/** Bottom-of-the-stack click-outside-to-dismiss context menu used by every
 *  tabstrip that wants close/close-others/close-all behavior. Keep the items
 *  list small (≤5) — it's a context menu, not a settings panel. */
export type ContextMenuItem = {
  label: string;
  run: () => void;
  disabled?: boolean;
};

export type ContextMenuAnchor = { x: number; y: number };

interface TabContextMenuProps {
  anchor: ContextMenuAnchor;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function TabContextMenu({ anchor, items, onClose }: TabContextMenuProps) {
  // Any click anywhere (or Escape) tears it down. The menu's own clicks
  // stopPropagation so the close fires AFTER the item's `run`.
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("click", handler);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("click", handler);
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  return (
    <div
      style={{ left: anchor.x, top: anchor.y }}
      className="fixed z-50 min-w-[160px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded shadow-lg py-1 text-xs"
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          disabled={it.disabled}
          onClick={() => {
            if (it.disabled) return;
            it.run();
            onClose();
          }}
          className={cn(
            "w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800",
            it.disabled && "opacity-40 cursor-not-allowed",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
