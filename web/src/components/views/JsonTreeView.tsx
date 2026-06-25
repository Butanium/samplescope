import { useEffect, useRef, useState, type ReactNode, type DragEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FoldVertical,
  GripVertical,
  RotateCcw,
  UnfoldVertical,
} from "lucide-react";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { useUrlSync } from "../../lib/url";
import { usePref } from "../../lib/prefs";
import { useRowPage, usePublishNav } from "../../lib/rowPage";
import { cn } from "../../lib/utils";
import PreOrMarkdown from "../PreOrMarkdown";
import Collapsible from "../Collapsible";
import CopyButton from "../CopyButton";
import RawJsonToggle from "../RawJsonToggle";

type Json = unknown;

/** True for the two recursable shapes — anything that becomes nested cards. */
function isContainer(v: Json): v is object {
  return v !== null && typeof v === "object";
}

/** A plain object (not array): the shape that gets the top-level field layout. */
function isPlainObject(v: Json): v is Record<string, Json> {
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

interface NodeCtx {
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
function ValueNode({ value, ctx }: { value: Json; ctx: NodeCtx }) {
  if (value === null || value === undefined)
    return <span className="text-xs italic text-zinc-400 dark:text-zinc-600">null</span>;

  if (typeof value === "string") {
    if (value === "")
      return <span className="text-xs italic text-zinc-400 dark:text-zinc-600">(empty string)</span>;
    return (
      <Collapsible lines={14}>
        <PreOrMarkdown
          text={value}
          mode={ctx.markdown ? "markdown" : "pre"}
          highlightCtx={{ row: ctx.ctxRow }}
        />
      </Collapsible>
    );
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
 * A leaf object field: `key: value` on one line (key wraps left, value flows in
 * its own column). Far more compact than a card-with-header for simple scalars.
 */
function ScalarField({ name, value, ctx }: { name: string; value: Json; ctx: NodeCtx }) {
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
function Card({
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

// ───────────────────────── top-level field layout ─────────────────────────
//
// The outermost object of each row gets special treatment the nested cards
// don't: the user picks which top-level fields stay visible vs. fold away, and
// drags to reorder them. Both the order and the hidden set are persisted per
// dataset (a `usePref` key) so the choice applies to *every* sample in the file
// and survives reloads. `order` is the global ordering of all known keys;
// `hidden` is which of them fold into the "more fields" drawer.

type FieldLayout = { order: string[]; hidden: string[] };
const EMPTY_LAYOUT: FieldLayout = { order: [], hidden: [] };

/**
 * The persisted `order` only lists keys the user has touched. Fold in any keys
 * actually present-but-unseen by appending them in natural order, and drop any
 * stale keys no longer present — so a new field never silently disappears and a
 * removed one doesn't haunt the order.
 */
function normalizeOrder(order: string[], present: string[]): string[] {
  const presentSet = new Set(present);
  const seen = new Set<string>();
  const known: string[] = [];
  for (const k of order) {
    if (presentSet.has(k) && !seen.has(k)) {
      known.push(k);
      seen.add(k);
    }
  }
  for (const k of present) if (!seen.has(k)) known.push(k);
  return known;
}

function useFieldLayout(datasetPath: string) {
  const [layout, setLayout] = usePref<FieldLayout>(`json.fields:${datasetPath}`, EMPTY_LAYOUT);
  const hiddenSet = new Set(layout.hidden);

  const partition = (present: string[]) => {
    const full = normalizeOrder(layout.order, present);
    return {
      shown: full.filter((k) => !hiddenSet.has(k)),
      hidden: full.filter((k) => hiddenSet.has(k)),
    };
  };

  /** Move `dragKey` next to `targetKey` (before, or after when `below`). */
  const reorder = (present: string[], dragKey: string, targetKey: string, below: boolean) => {
    const arr = normalizeOrder(layout.order, present).filter((k) => k !== dragKey);
    let ti = arr.indexOf(targetKey);
    if (ti < 0) ti = arr.length;
    arr.splice(below ? ti + 1 : ti, 0, dragKey);
    setLayout({ order: arr, hidden: layout.hidden });
  };

  const toggleHidden = (present: string[], key: string) => {
    const nextHidden = hiddenSet.has(key)
      ? layout.hidden.filter((k) => k !== key)
      : [...layout.hidden.filter((k) => k !== key), key];
    // Persist the resolved order too, so a hide doesn't drop the ordering the
    // user already arranged (and newly-present keys get pinned into `order`).
    setLayout({ order: normalizeOrder(layout.order, present), hidden: nextHidden });
  };

  const isDefault = layout.order.length === 0 && layout.hidden.length === 0;
  return { partition, reorder, toggleHidden, isDefault, reset: () => setLayout(EMPTY_LAYOUT) };
}

/** Drag-and-drop coordination shared by the shown fields of one record. */
interface Dnd {
  dragKey: string | null;
  over: { key: string; below: boolean } | null;
  start: (k: string) => void;
  move: (k: string, below: boolean) => void;
  end: () => void;
  drop: (k: string, below: boolean) => void;
}

/** Half-of-row hit test: are we in the bottom half of the dragged-over field? */
function inBottomHalf(e: DragEvent<HTMLDivElement>): boolean {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
}

/**
 * One top-level field: a drag handle + the usual scalar/card rendering + a
 * hide/show eye. `dnd` is null in the folded drawer (no reordering there).
 */
function TopLevelField({
  fieldKey, value, ctx, hidden, onToggleHidden, dnd,
}: {
  fieldKey: string;
  value: Json;
  ctx: NodeCtx;
  hidden: boolean;
  onToggleHidden: () => void;
  dnd: Dnd | null;
}) {
  // Native DnD drags whatever element under the pointer is `draggable`. We only
  // want a drag that starts on the grip, so arm `draggable` on the handle's
  // mousedown and disarm on drag end — leaving header clicks (card collapse)
  // untouched.
  const [armed, setArmed] = useState(false);
  const isDragging = dnd?.dragKey === fieldKey;
  const isOver = !!dnd && dnd.over?.key === fieldKey && dnd.dragKey != null && dnd.dragKey !== fieldKey;
  const below = dnd?.over?.below ?? false;

  const dragProps = dnd
    ? {
        draggable: armed,
        onDragStart: (e: DragEvent<HTMLDivElement>) => {
          dnd.start(fieldKey);
          e.dataTransfer.effectAllowed = "move";
        },
        onDragEnd: () => { setArmed(false); dnd.end(); },
        onDragOver: (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); dnd.move(fieldKey, inBottomHalf(e)); },
        onDrop: (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); dnd.drop(fieldKey, inBottomHalf(e)); },
      }
    : {};

  return (
    <div
      {...dragProps}
      className={cn(
        "flex items-stretch gap-1 rounded-md",
        isDragging && "opacity-40",
        isOver && (below ? "shadow-[inset_0_-2px_0_0_#34d399]" : "shadow-[inset_0_2px_0_0_#34d399]"),
      )}
    >
      {dnd && (
        <button
          type="button"
          title="drag to reorder — applies to every sample"
          onMouseDown={() => setArmed(true)}
          onMouseUp={() => setArmed(false)}
          className="shrink-0 flex items-start pt-1.5 cursor-grab active:cursor-grabbing text-zinc-300 hover:text-zinc-500 dark:text-zinc-700 dark:hover:text-zinc-400"
        >
          <GripVertical size={14} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        {isContainer(value) ? (
          <Card
            tone="field"
            label={
              <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200 break-words leading-snug">
                {fieldKey}
              </span>
            }
            value={value}
            ctx={ctx}
          />
        ) : (
          <ScalarField name={fieldKey} value={value} ctx={ctx} />
        )}
      </div>
      <button
        type="button"
        title={hidden ? "show this field" : "hide — fold into ‘more fields’"}
        onClick={onToggleHidden}
        className={cn(
          "shrink-0 self-start mt-1 rounded-sm p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 transition-opacity",
          !hidden && "opacity-0 group-hover/rec:opacity-100",
        )}
      >
        {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
    </div>
  );
}

/** The folded-by-default drawer of hidden top-level fields. */
function HiddenSection({
  keys, value, ctx, onToggleHidden,
}: {
  keys: string[];
  value: Record<string, Json>;
  ctx: NodeCtx;
  onToggleHidden: (k: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50/40 dark:bg-zinc-900/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-zinc-400" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-zinc-400" />
        )}
        <span className="shrink-0 font-medium">
          {keys.length} more field{keys.length === 1 ? "" : "s"}
        </span>
        {!open && (
          <span className="min-w-0 truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-600">
            {keys.join(" · ")}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-1.5 px-2 pb-2 pt-0.5">
          {keys.map((k) => (
            <TopLevelField
              key={k}
              fieldKey={k}
              value={value[k]}
              ctx={ctx}
              hidden
              onToggleHidden={() => onToggleHidden(k)}
              dnd={null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renders a row's outermost object with the user's field layout: ordered,
 * draggable visible fields on top, the rest folded into `HiddenSection`.
 * `group/rec` scopes the hover that reveals each field's hide eye.
 */
function TopLevelObject({
  value, datasetPath, ctx,
}: {
  value: Record<string, Json>;
  datasetPath: string;
  ctx: NodeCtx;
}) {
  const present = Object.keys(value);
  const { partition, reorder, toggleHidden } = useFieldLayout(datasetPath);
  const { shown, hidden } = partition(present);

  // `dragKey` state drives the drag visuals; `dragKeyRef` carries the source key
  // so `drop` reads it synchronously (the drop event can fire before React has
  // committed the dragstart's setState).
  const dragKeyRef = useRef<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; below: boolean } | null>(null);
  const clear = () => { dragKeyRef.current = null; setDragKey(null); setOver(null); };
  const dnd: Dnd = {
    dragKey,
    over,
    start: (k) => { dragKeyRef.current = k; setDragKey(k); },
    move: (k, b) => setOver((o) => (o && o.key === k && o.below === b ? o : { key: k, below: b })),
    end: clear,
    drop: (k, b) => {
      const src = dragKeyRef.current;
      if (src && src !== k) reorder(present, src, k, b);
      clear();
    },
  };

  return (
    <div className="group/rec space-y-1.5">
      {shown.map((k) => (
        <TopLevelField
          key={k}
          fieldKey={k}
          value={value[k]}
          ctx={ctx}
          hidden={false}
          onToggleHidden={() => toggleHidden(present, k)}
          dnd={dnd}
        />
      ))}
      {hidden.length > 0 && (
        <HiddenSection
          keys={hidden}
          value={value}
          ctx={ctx}
          onToggleHidden={(k) => toggleHidden(present, k)}
        />
      )}
    </div>
  );
}

/** Toolbar control: clear a customized field layout back to natural order. */
function FieldLayoutReset({ datasetPath }: { datasetPath: string }) {
  const { isDefault, reset } = useFieldLayout(datasetPath);
  if (isDefault) return null;
  return (
    <>
      <span className="mx-1 text-zinc-300 dark:text-zinc-700">·</span>
      <button
        onClick={reset}
        title="reset field order & visibility for this dataset"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
      >
        <RotateCcw size={12} /> fields
      </button>
    </>
  );
}

const LIST_PAGE = 100;

/** Shared toolbar bits: expand-all / collapse-all / markdown toggle. */
function ExpandMdControls({
  markdown, setMarkdown, setAll,
}: {
  markdown: boolean;
  setMarkdown: (b: boolean) => void;
  setAll: (open: boolean) => void;
}) {
  return (
    <>
      <button
        onClick={() => setAll(true)}
        title="expand all"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
      >
        <UnfoldVertical size={12} /> expand
      </button>
      <button
        onClick={() => setAll(false)}
        title="collapse all"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
      >
        <FoldVertical size={12} /> collapse
      </button>
      <span className="mx-1 text-zinc-300 dark:text-zinc-700">·</span>
      <button
        onClick={() => setMarkdown(!markdown)}
        title={markdown ? "string leaves: markdown (click for raw text)" : "string leaves: raw text (click for markdown)"}
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm transition-colors",
          markdown
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60",
        )}
      >
        md
      </button>
    </>
  );
}

/** single (one sample, navigate with j/k) vs scroll (a feed of all samples). */
function JsonModeToggle() {
  const { url, setViewMode } = useUrlSync();
  return (
    <div className="inline-flex text-[10px] font-mono uppercase tracking-wider border border-zinc-200 dark:border-zinc-800 rounded-sm overflow-hidden">
      {([["single", "single"], ["list", "scroll"]] as const).map(([val, label]) => (
        <button
          key={val}
          onClick={() => setViewMode(val)}
          className={cn(
            "px-2 py-0.5 transition-colors",
            url.viewMode === val
              ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** One sample at a time; j/k steps through the dataset. */
function SingleMode() {
  const v = useViewerState();
  const [markdown, setMarkdown] = usePref<boolean>("json.markdown", true);
  const [raw, setRaw] = usePref<boolean>("json.raw", false);
  const [defaultOpen, setDefaultOpen] = useState(true);
  const [gen, setGen] = useState(0);

  const { data } = useQuery({
    queryKey: ["row-json", v.dataset_path, v.row_idx],
    queryFn: () => api.row(v.dataset_path!, v.row_idx),
    enabled: !!v.dataset_path,
  });

  // Single-sample view: j/k over the *natural* order is handled by Layout's
  // idx±1 fallback. Only publish a visible-order list when filter/shuffle/sort
  // reorders the dataset — and only then pay for the page fetch.
  const navActive = v.filter_regex != null || v.shuffle_seed != null || v.sort_column != null;
  const { data: navPage } = useRowPage("json-nav", { limit: 2000, enabled: navActive });
  usePublishNav(navPage?.indices, navActive);

  const setAll = (openAll: boolean) => { setDefaultOpen(openAll); setGen((g) => g + 1); };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 text-xs">
        <ExpandMdControls markdown={markdown} setMarkdown={setMarkdown} setAll={setAll} />
        {v.dataset_path && <FieldLayoutReset datasetPath={v.dataset_path} />}
        <div className="ml-auto flex items-center gap-1.5">
          {data && <CopyButton variant="json" value={() => JSON.stringify(data, null, 2)} title="copy the whole row as JSON" />}
          <RawJsonToggle value={raw} onChange={setRaw} title={raw ? "show card view" : "show raw JSON"} />
          <JsonModeToggle />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {!data ? (
          <div className="text-zinc-500 text-sm">loading…</div>
        ) : raw ? (
          <pre className="text-xs font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-3 rounded whitespace-pre-wrap">
            {JSON.stringify(data, null, 2)}
          </pre>
        ) : isPlainObject(data) && v.dataset_path ? (
          <TopLevelObject value={data} datasetPath={v.dataset_path} ctx={{ markdown, ctxRow: data, defaultOpen, gen }} />
        ) : (
          <ValueNode value={data} ctx={{ markdown, ctxRow: data, defaultOpen, gen }} />
        )}
      </div>
    </div>
  );
}

/** A scrollable feed of samples, each rendered as its own card stack. */
function ListMode() {
  const v = useViewerState();
  const [markdown, setMarkdown] = usePref<boolean>("json.markdown", true);
  const [defaultOpen, setDefaultOpen] = useState(true);
  const [gen, setGen] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);

  const { data: page } = useRowPage("json-list", { limit: LIST_PAGE });
  const rows = page?.rows ?? [];
  const indices = page?.indices ?? [];

  usePublishNav(indices);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 280,
    overscan: 4,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const setAll = (openAll: boolean) => { setDefaultOpen(openAll); setGen((g) => g + 1); };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 text-xs">
        <ExpandMdControls markdown={markdown} setMarkdown={setMarkdown} setAll={setAll} />
        {v.dataset_path && <FieldLayoutReset datasetPath={v.dataset_path} />}
        <span className="ml-2 text-[11px] text-zinc-400 dark:text-zinc-600">
          showing {rows.length} of {page?.total_filtered ?? 0}
        </span>
        <div className="ml-auto">
          <JsonModeToggle />
        </div>
      </div>
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const r = rows[vi.index];
            const idx = indices[vi.index];
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
              >
                <RecordBlock
                  row={r}
                  idx={idx}
                  active={idx === v.row_idx}
                  onSelect={() => api.goto(idx)}
                  datasetPath={v.dataset_path}
                  ctx={{ markdown, ctxRow: r, defaultOpen, gen }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** One sample in the scroll feed: an index caption over its card stack. */
function RecordBlock({
  row, idx, active, onSelect, ctx, datasetPath,
}: {
  row: Json;
  idx: number;
  active: boolean;
  onSelect: () => void;
  ctx: NodeCtx;
  datasetPath: string | null;
}) {
  return (
    <article
      onClick={onSelect}
      className={cn(
        "px-4 py-3 border-t border-zinc-200/60 dark:border-zinc-800/70 cursor-default",
        active && "bg-emerald-50/40 dark:bg-emerald-500/[0.04]",
      )}
    >
      <header className="flex items-center mb-2 text-[11px] font-mono">
        <span className={cn("tracking-wider", active ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500")}>
          row {idx}
        </span>
        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <CopyButton variant="json" value={() => JSON.stringify(row, null, 2)} title="copy row JSON" />
        </div>
      </header>
      {isPlainObject(row) && datasetPath ? (
        <TopLevelObject value={row} datasetPath={datasetPath} ctx={ctx} />
      ) : (
        <ValueNode value={row} ctx={ctx} />
      )}
    </article>
  );
}

export default function JsonTreeView() {
  const { url } = useUrlSync();
  return url.viewMode === "list" ? <ListMode /> : <SingleMode />;
}
