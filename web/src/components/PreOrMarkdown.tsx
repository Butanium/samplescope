import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { useMemo } from "react";
import { cn } from "../lib/utils";
import {
  applyHighlights,
  rehypeHighlights,
  useHighlightRules,
  type HighlightContext,
} from "../lib/highlights";

interface PreOrMarkdownProps {
  text: string;
  /** "pre" preserves indentation/whitespace; "markdown" renders gfm. */
  mode?: "pre" | "markdown";
  /** Back-compat alias for `mode`. */
  defaultMode?: "pre" | "markdown";
  /** Visual font for `pre` mode: "prose" (sans, default) or "mono". */
  font?: "prose" | "mono";
  className?: string;
  /** When set, runs every text node through the active highlight rules. */
  highlightCtx?: HighlightContext;
}

/**
 * Render data text. Two modes:
 * - `pre` (default) keeps every byte intact; pick `font="mono"` for code.
 * - `markdown` runs the text through react-markdown with GFM tables and
 *   single-newline-as-`<br>` (remark-breaks). Raw HTML is **not** rendered —
 *   react-markdown escapes it by default and we don't enable rehype-raw.
 *
 * Highlights: when `highlightCtx` is set, the active rule list (from the
 * `useHighlightRules` query) drives a render-time text split. Markdown mode
 * plugs in a small rehype plugin so every text node in the parsed tree is
 * eligible (paragraph, list item, table cell, code block, …) without enumer-
 * ating every block component. Pre mode applies the same logic to the raw
 * string.
 *
 * Headless: there's no in-component toggle button.
 */
export default function PreOrMarkdown({
  text,
  mode,
  defaultMode,
  font = "prose",
  className,
  highlightCtx,
}: PreOrMarkdownProps) {
  const resolved = mode ?? defaultMode ?? "pre";
  const rulesQuery = useHighlightRules();
  const rules = highlightCtx ? (rulesQuery.data ?? []) : [];

  const rehypePlugins = useMemo(
    () => (highlightCtx && rules.length > 0 ? [rehypeHighlights(rules, highlightCtx)] : []),
    [rules, highlightCtx],
  );

  if (resolved === "pre") {
    const body =
      highlightCtx && rules.length > 0
        ? applyHighlights(text, highlightCtx, rules)
        : text;
    return (
      <pre
        className={cn(
          "whitespace-pre-wrap text-[13.5px] leading-relaxed text-zinc-800 dark:text-zinc-200",
          font === "mono"
            ? "font-mono"
            : "font-sans tracking-[-0.005em]",
          className,
        )}
      >
        {body}
      </pre>
    );
  }
  return (
    <div className={cn("markdown text-[13.5px] leading-relaxed text-zinc-800 dark:text-zinc-200", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={rehypePlugins as any}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
