import { useMemo, useRef, useState, type DragEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  GripVertical,
  Pin,
  PinOff,
  RotateCcw,
} from "lucide-react";
import { readPref, usePref } from "../../lib/prefs";
import { cn } from "../../lib/utils";
import { Card, ScalarField, isContainer, type Json, type NodeCtx } from "./jsonCards";

// ───────────────────────── top-level field layout ─────────────────────────
//
// The outermost object of each row gets special treatment the nested cards
// don't: the user picks, per field, one of three states — body (the default
// card stack), drawer (folded into "more fields"), or header (a compact chip
// next to the row index) — and drags to reorder the body fields. All of it is
// persisted per *schema* (a `usePref` key, see `fieldSchemaKey`) so the choice
// applies to every sample in the file and survives reloads.
//
// A field the user has never placed follows `defaultHidden` — the layout's
// policy for unplaced fields, flipped by the toolbar's "default: show | hide".
// So `hidden` / `shown` are *exceptions* to that policy, not the whole truth:
// resolution is header → shown → hidden → defaultHidden. That policy is also
// what makes cross-schema inheritance well-defined (`findInheritable`): a
// donor layout that doesn't mention every field of the borrowing schema leaves
// the rest to `defaultHidden`.

type FieldLayout = {
  order: string[];
  hidden: string[];
  /** Explicit "keep in the body" exceptions — what carries weight once
   *  `defaultHidden` is on (cherry-picking fields back out of the drawer). */
  shown: string[];
  header: string[];
  /** Where a field nobody placed goes: body (false / absent) or drawer. */
  defaultHidden?: boolean;
  /** Stamped by every save, reset included, so a deliberately-reset schema
   *  stays natural instead of silently re-inheriting a neighbour's layout. */
  self?: boolean;
};
const EMPTY_LAYOUT: FieldLayout = { order: [], hidden: [], shown: [], header: [] };

/**
 * schemaKey → that schema's field names, so a *new* schema can find layouts
 * worth borrowing (the pref key alone is a hash — it can't be un-hashed back
 * into field names). Written by every save.
 */
type SchemaRegistry = Record<string, string[]>;
const REGISTRY_PREF = "json.fieldSchemas";
const EMPTY_REGISTRY: SchemaRegistry = {};

const lists = (l: FieldLayout) => [l.order ?? [], l.hidden ?? [], l.shown ?? [], l.header ?? []];

/** Nothing to apply: natural order, nothing diverted, unplaced fields shown. */
function isDefaultLayout(l: FieldLayout): boolean {
  return !l.defaultHidden && lists(l).every((a) => a.length === 0);
}

/** Has this schema been arranged (or explicitly reset) by the user? Layouts
 *  saved before `self` existed are non-default, so they still count. */
function isOwnLayout(l: FieldLayout): boolean {
  return l.self === true || !isDefaultLayout(l);
}

/** Field-wise tuple compare. (`a < b` on arrays stringifies — which would rank
 *  a size gap of 10 ahead of 2.) */
function rankBefore(a: [number, number, string], b: [number, number, string]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

/**
 * Borrow a layout for a schema the user has never arranged. A donor qualifies
 * when its field set is a **superset** of ours (every field we show is placed
 * by it) or a **subset** (it places some of ours; the rest fall to
 * `defaultHidden`). Supersets win, then the closest size — a donor differing
 * by one field is a better guess than one differing by six. Ties break on the
 * schema key so the choice is stable across reloads.
 */
function findInheritable(
  schemaKey: string,
  present: string[],
  registry: SchemaRegistry,
): { keys: string[]; layout: FieldLayout } | null {
  const mine = new Set(present);
  let best: { keys: string[]; layout: FieldLayout } | null = null;
  let bestRank: [number, number, string] | null = null;
  for (const [key, keys] of Object.entries(registry)) {
    if (key === schemaKey || !Array.isArray(keys)) continue;
    const donorKeys = new Set(keys);
    const superset = present.every((k) => donorKeys.has(k));
    const subset = keys.every((k) => mine.has(k));
    if (!superset && !subset) continue;
    const layout = readPref<FieldLayout>(`json.fields:${key}`, EMPTY_LAYOUT);
    if (isDefaultLayout(layout)) continue; // nothing to borrow
    const rank: [number, number, string] = [superset ? 0 : 1, Math.abs(keys.length - present.length), key];
    if (!bestRank || rankBefore(rank, bestRank)) {
      best = { keys, layout };
      bestRank = rank;
    }
  }
  return best;
}

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

/**
 * The layout is keyed by *schema*, not by file path: a stable hash of the
 * sorted top-level field names. So arranging one `{prompt, response, score}`
 * JSONL carries over to every other file with that same field set — sibling
 * result dumps, reruns, the next experiment. Order-independent (sorted) and
 * FNV-1a-hashed so the pref key stays short and path-safe. Names are joined
 * on NUL — no field name can contain one, so {"a b"} and {"a", "b"} can't
 * collide. `cli.py:_field_schema_key` mirrors this byte for byte.
 */
export function fieldSchemaKey(keys: string[]): string {
  const s = [...keys].sort().join("\u0000");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * @param fallbackHidden default for schemas that have never been arranged —
 * false for JSON cards (show everything), true for the chat view, where the
 * transcript is the content and metadata is opt-in.
 */
function useFieldLayout(schemaKey: string, present: string[], fallbackHidden = false) {
  const [saved, setLayout] = usePref<FieldLayout>(`json.fields:${schemaKey}`, EMPTY_LAYOUT);
  const [registry, setRegistry] = usePref<SchemaRegistry>(REGISTRY_PREF, EMPTY_REGISTRY);
  const presentKey = present.join("\u0000");

  // An untouched schema borrows the closest compatible layout; the first edit
  // materializes that borrowed layout under our own key (`save` spreads the
  // *effective* one), which is also what stops the borrowing.
  const inherited = useMemo(
    () => (isOwnLayout(saved) ? null : findInheritable(schemaKey, present, registry)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- presentKey stands in for `present`
    [saved, registry, schemaKey, presentKey],
  );
  const layout = inherited?.layout ?? saved;

  // `?? []` keeps us tolerant of older prefs that predate `header` / `shown`.
  const keep = (arr: string[] | undefined, drop?: string) =>
    (arr ?? []).filter((k) => present.includes(k) && k !== drop);
  const headerSet = new Set(layout.header ?? []);
  const shownSet = new Set(layout.shown ?? []);
  const hiddenSet = new Set(layout.hidden ?? []);
  const defaultHidden = layout.defaultHidden ?? fallbackHidden;
  const isHidden = (k: string) => (shownSet.has(k) ? false : hiddenSet.has(k) ? true : defaultHidden);

  // Lists are pruned to the present keys on write: a borrowed layout can name
  // fields this schema doesn't have, and once materialized they'd never resolve.
  const save = (next: Partial<FieldLayout>) => {
    setLayout({
      order: normalizeOrder(layout.order, present),
      hidden: keep(layout.hidden),
      shown: keep(layout.shown),
      header: keep(layout.header),
      // Only an explicit policy is stored: the view's own fallback must not
      // travel to a borrower whose fallback differs (JSON cards ↔ chat metadata).
      defaultHidden: layout.defaultHidden,
      ...next,
      self: true,
    });
    const sorted = [...present].sort();
    const known = registry[schemaKey];
    if (!known || known.length !== sorted.length || known.some((k, i) => k !== sorted[i])) {
      setRegistry({ ...registry, [schemaKey]: sorted });
    }
  };

  const partition = () => {
    const full = normalizeOrder(layout.order, present);
    return {
      // header wins over everything; the rest split on the resolved visibility.
      header: full.filter((k) => headerSet.has(k)),
      hidden: full.filter((k) => !headerSet.has(k) && isHidden(k)),
      shown: full.filter((k) => !headerSet.has(k) && !isHidden(k)),
    };
  };

  /** Move `dragKey` next to `targetKey` (before, or after when `below`). */
  const reorder = (dragKey: string, targetKey: string, below: boolean) => {
    const arr = normalizeOrder(layout.order, present).filter((k) => k !== dragKey);
    let ti = arr.indexOf(targetKey);
    if (ti < 0) ti = arr.length;
    arr.splice(below ? ti + 1 : ti, 0, dragKey);
    save({ order: arr });
  };

  // Hiding / showing records an *exception* to `defaultHidden`, so the same eye
  // works in both modes (and a cherry-picked field survives a policy flip only
  // if the flip didn't clear its side — see `setDefaultHidden`).
  const toggleHidden = (key: string) =>
    save(
      isHidden(key)
        ? { shown: [...keep(layout.shown, key), key], hidden: keep(layout.hidden, key) }
        : { hidden: [...keep(layout.hidden, key), key], shown: keep(layout.shown, key) },
    );

  // Header is an orthogonal axis: pinning doesn't disturb the hidden/shown
  // exception, so unpinning drops the field back where it was.
  const toggleHeader = (key: string) =>
    save({
      header: headerSet.has(key) ? keep(layout.header, key) : [...keep(layout.header, key), key],
    });

  // The policy flip doubles as the bulk action: switching to hide-by-default
  // drops the "keep showing" exceptions (so everything folds *now*), and back
  // to show-by-default drops the "keep hidden" ones. Header pins survive both.
  const setDefaultHidden = (v: boolean) =>
    save(v ? { defaultHidden: true, shown: [] } : { defaultHidden: false, hidden: [] });

  return {
    partition,
    reorder,
    toggleHidden,
    toggleHeader,
    defaultHidden,
    setDefaultHidden,
    inheritedFrom: inherited?.keys ?? null,
    isDefault: isDefaultLayout(layout),
    reset: () => setLayout({ ...EMPTY_LAYOUT, self: true }),
  };
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
 * pin-to-header button and a hide/show eye. `dnd` is null in the folded drawer
 * (no reordering there); there the controls stay visible (you're already in a
 * settings context), vs. hover-revealed in the body.
 */
function TopLevelField({
  fieldKey, value, ctx, hidden, onToggleHidden, onToggleHeader, dnd,
}: {
  fieldKey: string;
  value: Json;
  ctx: NodeCtx;
  hidden: boolean;
  onToggleHidden: () => void;
  onToggleHeader: () => void;
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
      <div
        className={cn(
          "shrink-0 self-start mt-1 flex items-center gap-0.5 transition-opacity",
          !hidden && "opacity-0 group-hover/rec:opacity-100",
        )}
      >
        <button
          type="button"
          title="pin to the header — shown next to the row index"
          onClick={onToggleHeader}
          className="rounded-sm p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
        >
          <Pin size={13} />
        </button>
        <button
          type="button"
          title={hidden ? "show this field" : "hide — fold into ‘more fields’"}
          onClick={onToggleHidden}
          className="rounded-sm p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
        >
          {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </div>
    </div>
  );
}

/** Compact one-line rendering of a value for a header chip. */
function compactValue(v: Json): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v === "" ? "(empty)" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  return `{${Object.keys(v as object).length}}`;
}

/**
 * The header-pinned fields, rendered as compact `key value` chips. Lives next
 * to the row index (scroll feed) or in a strip atop the cards (single view).
 * Each chip's hover reveals an unpin button that returns it to the body.
 */
export function FieldHeaderChips({
  value, schemaKey, fallbackHidden,
}: {
  value: Record<string, Json>;
  schemaKey: string;
  fallbackHidden?: boolean;
}) {
  const present = Object.keys(value);
  const { partition, toggleHeader } = useFieldLayout(schemaKey, present, fallbackHidden);
  const { header } = partition();
  return (
    <>
      {header.map((k) => (
        <span
          key={k}
          title={`${k}: ${compactValue(value[k])}`}
          className="group/chip inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-100/80 dark:bg-zinc-800/60 px-2 py-0.5 text-[11px]"
        >
          <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{k}</span>
          <span className="truncate font-medium text-zinc-700 dark:text-zinc-200">{compactValue(value[k])}</span>
          <button
            type="button"
            title="unpin from header"
            onClick={(e) => { e.stopPropagation(); toggleHeader(k); }}
            className="shrink-0 opacity-0 group-hover/chip:opacity-100 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            <PinOff size={11} />
          </button>
        </span>
      ))}
    </>
  );
}

/** The folded-by-default drawer of hidden top-level fields. */
function HiddenSection({
  keys, value, ctx, onToggleHidden, onToggleHeader,
}: {
  keys: string[];
  value: Record<string, Json>;
  ctx: NodeCtx;
  onToggleHidden: (k: string) => void;
  onToggleHeader: (k: string) => void;
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
              onToggleHeader={() => onToggleHeader(k)}
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
 * draggable visible fields on top, the rest folded into `HiddenSection`
 * (header-pinned fields render separately, via `FieldHeaderChips`).
 * `group/rec` scopes the hover that reveals each field's controls.
 */
export function TopLevelObject({
  value, schemaKey, ctx, fallbackHidden,
}: {
  value: Record<string, Json>;
  schemaKey: string;
  ctx: NodeCtx;
  fallbackHidden?: boolean;
}) {
  const present = Object.keys(value);
  const { partition, reorder, toggleHidden, toggleHeader } = useFieldLayout(
    schemaKey, present, fallbackHidden,
  );
  const { shown, hidden } = partition();

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
      if (src && src !== k) reorder(src, k, b);
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
          onToggleHidden={() => toggleHidden(k)}
          onToggleHeader={() => toggleHeader(k)}
          dnd={dnd}
        />
      ))}
      {hidden.length > 0 && (
        <HiddenSection
          keys={hidden}
          value={value}
          ctx={ctx}
          onToggleHidden={toggleHidden}
          onToggleHeader={toggleHeader}
        />
      )}
    </div>
  );
}

const TOOL_BTN =
  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60";

/**
 * Toolbar controls: the show/hide default policy (which doubles as show-all /
 * hide-all), an "inherited" marker when this schema is borrowing a neighbour's
 * layout, and the reset. `present` = the sample's top-level keys.
 */
export function FieldLayoutTools({
  schemaKey, present, fallbackHidden,
}: {
  schemaKey: string | null;
  present: string[] | null;
  fallbackHidden?: boolean;
}) {
  const { defaultHidden, setDefaultHidden, inheritedFrom, isDefault, reset } = useFieldLayout(
    schemaKey ?? "",
    present ?? [],
    fallbackHidden,
  );
  if (!schemaKey || !present) return null;
  const side = (hide: boolean) =>
    cn(
      "px-1.5 py-0.5 rounded-sm",
      defaultHidden === hide
        ? "bg-zinc-200/80 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 font-medium"
        : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
    );
  return (
    <>
      <span className="mx-1 text-zinc-300 dark:text-zinc-700">·</span>
      <span className="inline-flex items-center gap-1">
        <span className="text-zinc-400 dark:text-zinc-500">fields:</span>
        <button
          onClick={() => setDefaultHidden(false)}
          title="show every field, and keep showing fields you never placed (incl. ones a borrowed layout doesn’t mention)"
          className={side(false)}
        >
          <Eye size={12} className="mr-1 inline align-[-2px]" />show
        </button>
        <button
          onClick={() => setDefaultHidden(true)}
          title="fold every field into ‘more fields’, and keep new/unplaced fields folded — then pick back the ones you want"
          className={side(true)}
        >
          <EyeOff size={12} className="mr-1 inline align-[-2px]" />hide
        </button>
      </span>
      {inheritedFrom && (
        <span
          title={`no layout saved for these fields — borrowing the one saved for: ${inheritedFrom.join(", ")}. Any edit makes it this schema’s own.`}
          className="ml-1 rounded-sm border border-dashed border-zinc-300 dark:border-zinc-700 px-1 text-[10px] text-zinc-400 dark:text-zinc-500"
        >
          inherited
        </span>
      )}
      {!isDefault && (
        <button
          onClick={reset}
          title="reset field order, header pins & visibility for this schema (and stop borrowing another schema’s layout)"
          className={cn(TOOL_BTN, "ml-1")}
        >
          <RotateCcw size={12} /> fields
        </button>
      )}
    </>
  );
}
