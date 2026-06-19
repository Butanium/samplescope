/**
 * Highlight rules: render-time text coloring driven by user-defined patterns.
 *
 * Two consumers:
 *   - `applyHighlights(text, ctx, rules)` — used in `pre` mode and as a building
 *     block; returns a React.ReactNode (string or array of strings + <mark>).
 *   - `rehypeHighlights(rules, ctx)` — a unified plugin for ReactMarkdown's
 *     `rehypePlugins`. Walks every text node in the parsed hast tree and splits
 *     it into mark elements interspersed with text.
 *
 * Conditions are evaluated client-side via `new Function('row','msg','return (<expr>)')`
 * — single-user local app, no security boundary. Compiled functions are cached
 * by source string. A condition that throws drops the rule for that call.
 *
 * Overlap policy: rules are sorted by ascending `sort_order` upstream. When two
 * rule matches overlap, the earlier rule wins (the later range is dropped).
 */
import { useQuery } from "@tanstack/react-query";
import type React from "react";
import { createElement } from "react";
import type { HighlightRule } from "./types";
import { api } from "./api";

export type HighlightContext = {
  row: any;
  msg?: { role: string; content: string } | null;
  column?: string | null;
};

/** TanStack Query hook for the live rules list. Single source of truth. */
export function useHighlightRules() {
  return useQuery({
    queryKey: ["highlights"],
    queryFn: () => api.listHighlights(),
    // Highlights almost never change — refetch only on explicit invalidation.
    staleTime: Infinity,
  });
}

const FN_CACHE = new Map<string, ((row: any, msg: any) => unknown) | null>();
const REGEX_CACHE = new Map<string, RegExp | null>();

function compileCondition(expr: string): ((row: any, msg: any) => unknown) | null {
  if (FN_CACHE.has(expr)) return FN_CACHE.get(expr) ?? null;
  let fn: ((row: any, msg: any) => unknown) | null = null;
  try {
    fn = new Function("row", "msg", `return (${expr})`) as (
      row: any,
      msg: any,
    ) => unknown;
  } catch {
    fn = null;
  }
  FN_CACHE.set(expr, fn);
  return fn;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The rule's pattern list, tolerating the legacy single-`pattern` shape. */
function rulePatterns(rule: HighlightRule): string[] {
  const ps = (rule.patterns ?? []).filter((p) => p.length > 0);
  if (ps.length) return ps;
  return rule.pattern ? [rule.pattern] : [];
}

function compileOne(src: string, isRegex: boolean, caseSensitive: boolean): RegExp | null {
  const key = `${isRegex ? "r" : "l"}|${caseSensitive ? "c" : "i"}|${src}`;
  if (REGEX_CACHE.has(key)) return REGEX_CACHE.get(key) ?? null;
  let re: RegExp | null = null;
  try {
    const flags = caseSensitive ? "g" : "gi";
    re = new RegExp(isRegex ? src : escapeRegex(src), flags);
  } catch {
    re = null;
  }
  REGEX_CACHE.set(key, re);
  return re;
}

/** Every compilable pattern of a rule as a fresh-lastIndex regex. */
function ruleRegexes(rule: HighlightRule): RegExp[] {
  const out: RegExp[] = [];
  for (const p of rulePatterns(rule)) {
    const re = compileOne(p, rule.is_regex, rule.case_sensitive);
    if (re) out.push(re);
  }
  return out;
}

/** AND gate: with combinator "and", paint only if EVERY pattern is present in
 *  the (full, scope-level) text. "or" always passes. */
function combinatorSatisfied(rule: HighlightRule, fullText: string): boolean {
  if ((rule.combinator ?? "or") !== "and") return true;
  const res = ruleRegexes(rule);
  return res.length > 0 && res.every((re) => { re.lastIndex = 0; return re.test(fullText); });
}

function ruleApplies(rule: HighlightRule, ctx: HighlightContext): boolean {
  if (!rule.enabled) return false;
  if (rule.scope_role && (!ctx.msg || ctx.msg.role !== rule.scope_role)) return false;
  if (rule.scope_column && ctx.column !== rule.scope_column) return false;
  if (rule.condition) {
    const fn = compileCondition(rule.condition);
    if (!fn) return false;
    try {
      if (!fn(ctx.row, ctx.msg ?? null)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

type Range = { start: number; end: number; color: string };

/** Non-overlapping match ranges over `text` for already-filtered rules (scope
 *  + combinator gating done by the caller). Paints every pattern of each rule. */
function paintRanges(text: string, rules: HighlightRule[]): Range[] {
  const ranges: Range[] = [];
  for (const rule of rules) {
    for (const re of ruleRegexes(rule)) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        ranges.push({ start: m.index, end: m.index + m[0].length, color: rule.color });
      }
    }
  }
  if (ranges.length === 0) return ranges;
  // Earlier rules win on overlap. Rules already arrive in sort_order order, so
  // the iteration order above is the priority order.
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start < lastEnd) continue;
    merged.push(r);
    lastEnd = r.end;
  }
  return merged;
}

/** Convert a hex color to an `rgba(...)` background with controlled alpha. */
function tint(color: string): string {
  const hex = color.replace("#", "").trim();
  if (hex.length !== 6 && hex.length !== 3) return color;
  const norm =
    hex.length === 3
      ? hex.split("").map((c) => c + c).join("")
      : hex;
  const r = parseInt(norm.slice(0, 2), 16);
  const g = parseInt(norm.slice(2, 4), 16);
  const b = parseInt(norm.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return color;
  return `rgba(${r}, ${g}, ${b}, 0.42)`;
}

/**
 * Split `text` by the active rules and return either the original string (no
 * matches) or an array of strings and `<mark>` elements ready to render.
 */
export function applyHighlights(
  text: string,
  ctx: HighlightContext,
  rules: HighlightRule[],
): React.ReactNode {
  // `pre` mode: the whole string is the scope, so AND can gate on `text`.
  const painting = rules.filter((r) => ruleApplies(r, ctx) && combinatorSatisfied(r, text));
  const ranges = paintRanges(text, painting);
  if (ranges.length === 0) return text;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.start > cursor) out.push(text.slice(cursor, r.start));
    out.push(
      createElement(
        "mark",
        {
          key: `hl-${i}-${r.start}`,
          className: "viewer-hl",
          style: { ["--hl-bg" as any]: tint(r.color) },
        },
        text.slice(r.start, r.end),
      ),
    );
    cursor = r.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

// ---------- rehype plugin ----------

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChild[];
};
type HastChild = HastText | HastElement | { type: string; [k: string]: unknown };
type HastRoot = { type: "root"; children: HastChild[] };

function makeMarkNode(value: string, color: string): HastElement {
  return {
    type: "element",
    tagName: "mark",
    properties: {
      className: ["viewer-hl"],
      style: `--hl-bg: ${tint(color)}`,
    },
    children: [{ type: "text", value }],
  };
}

/**
 * Build a unified/rehype plugin that splits text nodes by active rules.
 *
 * Returns a plugin factory ready to drop into `rehypePlugins=[plugin]`. When
 * no rules survive scoping, the transformer is a no-op.
 */
export function rehypeHighlights(
  rules: HighlightRule[],
  ctx: HighlightContext,
): () => (tree: HastRoot) => void {
  // Pre-filter to the surviving rules so we don't re-run scoping per text node.
  const active = rules.filter((r) => ruleApplies(r, ctx));
  return () => (tree: HastRoot) => {
    if (active.length === 0) return;
    // AND rules gate on the WHOLE rendered text (markdown splits a message into
    // many text nodes, so a per-node check would miss cross-paragraph matches).
    const fullText = collectText(tree as unknown as HastElement);
    const painting = active.filter((r) => combinatorSatisfied(r, fullText));
    if (painting.length === 0) return;
    walk(tree as unknown as HastElement, painting);
  };

  function collectText(node: HastElement | HastRoot, acc: string[] = []): string {
    if (!("children" in node) || !Array.isArray(node.children)) return acc.join("");
    for (const child of node.children) {
      if ((child as HastText).type === "text") acc.push((child as HastText).value);
      else if ((child as HastElement).children) collectText(child as HastElement, acc);
    }
    return acc.join("");
  }

  function walk(node: HastElement | HastRoot, painting: HighlightRule[]): void {
    if (!("children" in node) || !Array.isArray(node.children)) return;
    const out: HastChild[] = [];
    for (const child of node.children) {
      if ((child as HastText).type === "text") {
        const text = (child as HastText).value;
        const ranges = paintRanges(text, painting);
        if (ranges.length === 0) {
          out.push(child);
          continue;
        }
        let cursor = 0;
        for (const r of ranges) {
          if (r.start > cursor) {
            out.push({ type: "text", value: text.slice(cursor, r.start) });
          }
          out.push(makeMarkNode(text.slice(r.start, r.end), r.color));
          cursor = r.end;
        }
        if (cursor < text.length) {
          out.push({ type: "text", value: text.slice(cursor) });
        }
      } else {
        if ((child as HastElement).children) {
          walk(child as HastElement, painting);
        }
        out.push(child);
      }
    }
    node.children = out;
  }
}
