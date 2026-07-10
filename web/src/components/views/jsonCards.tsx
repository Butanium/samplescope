import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import PreOrMarkdown from "../PreOrMarkdown";
import Collapsible from "../Collapsible";
import CopyButton from "../CopyButton";
import RawJsonToggle from "../RawJsonToggle";

// Generic JSON → cards renderer: the engine the JSON sample view recurses on.
// `ValueNode` dispatches by type; containers become collapsible `Card`s, leaf
// objects render as compact `key: value` rows. The top-level field-layout
// system (fieldLayout.tsx) and the view shells (JsonTreeView.tsx) build on top.

export type Json = unknown;

/** True for the two recursable shapes — anything that becomes nested cards. */
export function isContainer(v: Json): v is object {
  return v !== null && typeof v === "object";
}

/** A plain object (not array): the shape that gets the top-level field layout. */
export function isPlainObject(v: Json): v is Record<string, Json> {
  return isContainer(v) && !Array.isArray(v);
}

function isNonEmptyContainer(v: Json): boolean {
  if (!isContainer(v)) return false;
  return Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0;
}

/** Short type/size hint shown on a container card's header. */
function containerLabel(v: Json): string | null {
  if (Array.isArray(v)) return `list · ${v.length}`;
  if (isContainer(v)) return `object · ${Object.keys(v).length}`;
  return null;
}

export interface NodeCtx {
  /** Render string leaves as markdown vs raw pre text. */
  markdown: boolean;
  /** The full row, passed to highlight rules. */
  ctxRow: any;
  /** Default open state for newly-mounted cards (driven by expand/collapse all). */
  defaultOpen: boolean;
  /** Bumped by expand/collapse all to force every card back to `defaultOpen`. */
  gen: number;
}

/** Render any JSON value: scalars inline, containers as a stack of cards. */
export function ValueNode({ value, ctx }: { value: Json; ctx: NodeCtx }) {
  if (value === null || value === undefined)
    return <span className="text-xs italic text-zinc-400 dark:text-zinc-600">null</span>;

  if (typeof value === "string") {
    if (value === "")
      return <span className="text-xs italic text-zinc-400 dark:text-zinc-600">(empty string)</span>;
    return <StringLeaf text={value} ctx={ctx} />;
  }

  if (typeof value === "number" || typeof value === "boolean")
    return (
      <span className="font-mono text-sm text-emerald-700 dark:text-emerald-400">{String(value)}</span>
    );

  if (Array.isArray(value)) {
    if (value.length === 0)
      return <span className="text-xs italic text-zinc-400 dark:text-zinc-600">(empty list)</span>;
    return (
      <div className="space-y-1.5">
        {value.map((item, i) => (
          <Card
            key={i}
            tone="item"
            label={<span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">#{i}</span>}
            value={item}
            ctx={ctx}
          />
        ))}
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, Json>);
  if (entries.length === 0)
    return <span className="text-xs italic text-zinc-400 dark:text-zinc-600">(empty object)</span>;
  return (
    <div className="space-y-1.5">
      {entries.map(([k, val]) =>
        // A leaf (scalar) field renders compactly as `key: value` on one line;
        // only containers earn the full collapsible card with a header.
        isContainer(val) ? (
          <Card
            key={k}
            tone="field"
            label={
              <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200 break-words leading-snug">
                {k}
              </span>
            }
            value={val}
            ctx={ctx}
          />
        ) : (
          <ScalarField key={k} name={k} value={val} ctx={ctx} />
        ),
      )}
    </div>
  );
}

/**
 * A string leaf. When the string holds an embedded JSON object/array, render
 * the parsed structure (marked with a muted "json" badge) instead of flat text
 * — copy still yields the ORIGINAL string, and the parse is memoized so
 * scrolling doesn't re-parse. Otherwise the usual collapsible text render.
 */
function StringLeaf({ text, ctx }: { text: string; ctx: NodeCtx }) {
  const parsed = useMemo(() => tryParseJsonContainer(text), [text]);
  if (parsed !== undefined) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <span className="text-[9px] uppercase tracking-wider rounded px-1 py-px border border-zinc-200 dark:border-zinc-800 text-zinc-400 dark:text-zinc-600">
            json
          </span>
          <CopyButton variant="plain" value={text} title="copy the original JSON string" />
        </div>
        <ValueNode value={parsed} ctx={ctx} />
      </div>
    );
  }
  return (
    <Collapsible lines={14}>
      <PreOrMarkdown
        text={text}
        mode={ctx.markdown ? "markdown" : "pre"}
        highlightCtx={{ row: ctx.ctxRow }}
      />
    </Collapsible>
  );
}

/** Parse a string that *looks* like embedded JSON; `undefined` unless it yields
 *  an object/array (so the caller silently falls back to plain-string render). */
function tryParseJsonContainer(s: string): Json | undefined {
  if (s.length > 512_000) return undefined;
  const t = s.trim();
  const c = t[0];
  if (c !== "{" && c !== "[") return undefined;
  try {
    const parsed = JSON.parse(t);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // Not valid JSON — render as an ordinary string.
  }
  return undefined;
}

/**
 * A leaf object field: `key: value` on one line (key wraps left, value flows in
 * its own column). Far more compact than a card-with-header for simple scalars.
 */
export function ScalarField({ name, value, ctx }: { name: string; value: Json; ctx: NodeCtx }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 px-2 py-1">
      <span className="shrink-0 text-[13px] font-medium text-zinc-600 dark:text-zinc-300 break-words">{name}:</span>
      <div className="min-w-0 flex-1">
        <ValueNode value={value} ctx={ctx} />
      </div>
    </div>
  );
}

/**
 * One card: a header (label + type hint + copy) over a body that recurses.
 * Container cards collapse on header click; scalar cards just show their value.
 */
export function Card({
  label,
  value,
  ctx,
  tone,
}: {
  label: ReactNode;
  value: Json;
  ctx: NodeCtx;
  tone: "field" | "item";
}) {
  const collapsible = isNonEmptyContainer(value);
  const [open, setOpen] = useState(ctx.defaultOpen);
  // Per-card raw view: show this subtree's value as raw JSON instead of the
  // recursive card rendering, scoped to just this cell.
  const [raw, setRaw] = useState(false);
  // Expand/collapse-all bumps `gen`; snap every card back to the new default.
  useEffect(() => setOpen(ctx.defaultOpen), [ctx.gen]); // eslint-disable-line react-hooks/exhaustive-deps
  const typeHint = containerLabel(value);

  return (
    <div
      className={cn(
        "rounded-md border overflow-hidden",
        tone === "field"
          ? "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40"
          : "border-zinc-200/70 dark:border-zinc-800/60 bg-zinc-50/60 dark:bg-zinc-900/20",
      )}
    >
      <div
        className={cn(
          "flex items-start gap-1.5 px-2 py-1.5 group",
          collapsible && "cursor-pointer hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40",
        )}
        onClick={collapsible ? () => setOpen((o) => !o) : undefined}
      >
        {collapsible ? (
          open ? (
            <ChevronDown size={13} className="mt-0.5 shrink-0 text-zinc-400" />
          ) : (
            <ChevronRight size={13} className="mt-0.5 shrink-0 text-zinc-400" />
          )
        ) : (
          <span className="w-[13px] shrink-0" />
        )}
        <div className="flex-1 min-w-0">{label}</div>
        {typeHint && (
          <span className="shrink-0 self-start mt-0.5 text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-600">
            {typeHint}
          </span>
        )}
        <CopyButton
          variant="json"
          value={() => JSON.stringify(value, null, 2)}
          title="copy this subtree as JSON"
          className="shrink-0"
        />
        <RawJsonToggle
          value={raw}
          onChange={(next) => {
            setRaw(next);
            if (next) setOpen(true); // raw implies showing the body
          }}
          title={raw ? "show parsed view for this field" : "show raw JSON for this field"}
        />
      </div>
      {(open || !collapsible) && (
        <div className="px-2 pb-2">
          {raw ? (
            <pre className="text-xs font-mono whitespace-pre-wrap text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded p-2 overflow-x-auto">
              {JSON.stringify(value, null, 2)}
            </pre>
          ) : isContainer(value) ? (
            <div className="border-l-2 border-zinc-100 dark:border-zinc-800 pl-2">
              <ValueNode value={value} ctx={ctx} />
            </div>
          ) : (
            <ValueNode value={value} ctx={ctx} />
          )}
        </div>
      )}
    </div>
  );
}
