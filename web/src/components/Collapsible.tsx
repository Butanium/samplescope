import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { usePref } from "../lib/prefs";

/** True iff the user is in the middle of a (mouse) text-selection. We treat a
 *  click that lands at the end of a selection as "the user was selecting" and
 *  short-circuit the toggle — otherwise selecting text inside a collapsible
 *  collapses it on release. */
function hasActiveSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && sel.toString().length > 0 && !sel.isCollapsed;
}

interface CollapsibleProps {
  children: ReactNode;
  /** Maximum source-line count before auto-collapse. */
  lines?: number;
  /** Maximum character count before auto-collapse. */
  chars?: number;
  /** Initial state for THIS instance. Beats the global pref. */
  defaultExpanded?: boolean;
}

/**
 * Auto-collapses long content. The clickable zone IS the content area —
 * there is no separate button. When clipped, a soft fade hints at more
 * material; the cursor flips to pointer; click toggles expanded.
 *
 * String children are sliced exactly so clipped text doesn't waste line
 * height. Node children are clipped via `max-height: <lines * 1.5rem>`
 * with a measured `textContent` overflow check.
 */
export default function Collapsible({
  children,
  lines = 8,
  chars = 480,
  defaultExpanded,
}: CollapsibleProps) {
  const [defaultExpandPref] = usePref<boolean>("defaultExpand", false);
  const [expanded, setExpanded] = useState(defaultExpanded ?? defaultExpandPref);
  const ref = useRef<HTMLDivElement>(null);
  const [nodeOverflows, setNodeOverflows] = useState(false);
  const isString = typeof children === "string";

  useLayoutEffect(() => {
    if (isString || !ref.current) return;
    const t = ref.current.textContent ?? "";
    const lineCount = t.split("\n").length;
    setNodeOverflows(lineCount > lines || t.length > chars);
  }, [children, lines, chars, isString]);

  // Short content: render bare. No click target, no cursor change.
  if (isString) {
    const text = children as string;
    const splitLines = text.split("\n");
    const lineCount = splitLines.length;
    const overflows = lineCount > lines || text.length > chars;
    if (!overflows) return <>{text}</>;

    if (expanded) {
      return (
        <span
          onClick={(e) => {
            if (hasActiveSelection()) return;
            e.stopPropagation();
            setExpanded(false);
          }}
          role="button"
          tabIndex={0}
          className="block cursor-zoom-out"
          title="click to collapse"
        >
          {text}
        </span>
      );
    }
    const preview = splitLines.slice(0, lines).join("\n").slice(0, chars);
    const remainingLines = lineCount - Math.min(lineCount, lines);
    // Char-based suffix when the overflow is just length, not line count
    // (typical for SQL table cells: a single long line that needs an
    // "+N chars" hint rather than "+0 lines").
    const remainingChars = text.length - preview.length;
    const tail = remainingLines > 0
      ? `… +${remainingLines} lines`
      : `… +${remainingChars} chars`;
    return (
      <span
        onClick={(e) => {
          if (hasActiveSelection()) return;
          e.stopPropagation();
          setExpanded(true);
        }}
        role="button"
        tabIndex={0}
        className="relative cursor-zoom-in group"
        title={`click to expand (${remainingLines > 0 ? `${remainingLines} more lines` : `${remainingChars} more chars`})`}
      >
        {preview}
        <span className="text-zinc-400 dark:text-zinc-600 group-hover:text-zinc-600 dark:group-hover:text-zinc-400 italic ml-1 select-none">
          {tail}
        </span>
      </span>
    );
  }

  // Node children: clip via max-height, fade the bottom edge, click anywhere to toggle.
  if (!nodeOverflows) {
    return <div ref={ref}>{children}</div>;
  }

  const collapsed = !expanded;
  const maxHeight = `${lines * 1.5}rem`;

  return (
    <div
      onClick={(e) => {
        if (hasActiveSelection()) return;
        e.stopPropagation();
        setExpanded(!expanded);
      }}
      role="button"
      tabIndex={0}
      className={cn(
        "relative block",
        collapsed ? "cursor-zoom-in" : "cursor-zoom-out",
      )}
      title={collapsed ? "click to expand" : "click to collapse"}
    >
      <div
        ref={ref}
        style={collapsed ? { maxHeight, overflow: "hidden" } : undefined}
      >
        {children}
      </div>
      {collapsed && (
        <>
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-zinc-50 dark:from-zinc-950 to-transparent"
          />
          <div className="pointer-events-none absolute bottom-0 right-0 px-2 py-0.5 text-[10px] italic text-zinc-500">
            click to read more
          </div>
        </>
      )}
    </div>
  );
}
