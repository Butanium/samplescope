import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FoldVertical, UnfoldVertical } from "lucide-react";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { useUrlSync } from "../../lib/url";
import { usePref } from "../../lib/prefs";
import { useRowPage, useRowFeed, usePublishNav } from "../../lib/rowPage";
import { useGroups } from "../../lib/groups";
import { nextIdx, prevIdx, nextMember, prevMember } from "../../lib/nav";
import { cn } from "../../lib/utils";
import CopyButton from "../CopyButton";
import RawJsonToggle from "../RawJsonToggle";
import { GroupedFeed, GroupCycler } from "../GroupedFeed";
import { ValueNode, isPlainObject, type Json, type NodeCtx } from "./jsonCards";
import {
  TopLevelObject,
  FieldHeaderChips,
  FieldLayoutReset,
  fieldSchemaKey,
} from "./fieldLayout";

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
    // Keep the previous row rendered while the next fetches (j/k, group
    // cycling) instead of flashing "loading…" on every step.
    placeholderData: keepPreviousData,
  });

  // Single-sample view: j/k over the *natural* order is handled by Layout's
  // idx±1 fallback. Only publish a visible-order list when filter/shuffle/sort
  // reorders the dataset — and only then pay for the page fetch.
  const navActive = (v.filters?.length ?? 0) > 0 || v.shuffle_seed != null || v.sort_column != null;
  const { data: navPage } = useRowPage("json-nav", { limit: 2000, enabled: navActive });
  usePublishNav(navPage?.indices, navActive);

  const setAll = (openAll: boolean) => { setDefaultOpen(openAll); setGen((g) => g + 1); };
  const schemaKey = isPlainObject(data) ? fieldSchemaKey(Object.keys(data)) : null;

  // Grouped single view: one group at a time. A cycler walks the members of the
  // current row's group (via nav, which also drives [ ] / j-k); j/k step groups.
  const groups = useGroups();
  const pos = groups.groupBy ? groups.posOf(v.row_idx) : null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 text-xs">
        <ExpandMdControls markdown={markdown} setMarkdown={setMarkdown} setAll={setAll} />
        <FieldLayoutReset schemaKey={schemaKey} />
        <div className="ml-auto flex items-center gap-1.5">
          {data && <CopyButton variant="json" value={() => JSON.stringify(data, null, 2)} title="copy the whole row as JSON" />}
          <RawJsonToggle value={raw} onChange={setRaw} title={raw ? "show card view" : "show raw JSON"} />
          <JsonModeToggle />
        </div>
      </div>
      {pos && (
        <GroupCycler
          label={pos.value === null ? "∅ null" : pos.value === "" ? "∅ empty" : pos.value}
          mi={pos.mi}
          count={pos.memberCount}
          groupIdx={pos.gi}
          groupCount={groups.groupCount}
          rowIdx={v.row_idx}
          onPrev={() => { const t = prevMember(v.row_idx); if (t != null) api.goto(t); }}
          onNext={() => { const t = nextMember(v.row_idx); if (t != null) api.goto(t); }}
          onPrevGroup={() => { const t = prevIdx(v.row_idx); if (t != null) api.goto(t); }}
          onNextGroup={() => { const t = nextIdx(v.row_idx); if (t != null) api.goto(t); }}
        />
      )}
      <div className="flex-1 overflow-y-auto p-3">
        {!data ? (
          <div className="text-zinc-500 text-sm">loading…</div>
        ) : raw ? (
          <pre className="text-xs font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-3 rounded whitespace-pre-wrap">
            {JSON.stringify(data, null, 2)}
          </pre>
        ) : isPlainObject(data) && schemaKey ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-1.5 empty:hidden">
              <FieldHeaderChips value={data} schemaKey={schemaKey} />
            </div>
            <TopLevelObject value={data} schemaKey={schemaKey} ctx={{ markdown, ctxRow: data, defaultOpen, gen }} />
          </>
        ) : (
          <ValueNode value={data} ctx={{ markdown, ctxRow: data, defaultOpen, gen }} />
        )}
      </div>
    </div>
  );
}

/** One group member in the grouped feed: fetches the row by idx and renders
 *  just the card body (the GroupCard supplies the value + cycler header). */
function JsonMember({
  idx, markdown, defaultOpen, gen,
}: { idx: number; markdown: boolean; defaultOpen: boolean; gen: number }) {
  const v = useViewerState();
  const { data } = useQuery({
    queryKey: ["row-json", v.dataset_path, idx],
    queryFn: () => api.row(v.dataset_path!, idx),
    enabled: !!v.dataset_path,
    // Cycling members swaps `idx`: show the previous member until the next
    // one lands rather than flashing a "loading…" placeholder.
    placeholderData: keepPreviousData,
  });
  if (!data) return <div className="px-3 py-4 text-zinc-500 text-sm">loading…</div>;
  const ctx: NodeCtx = { markdown, ctxRow: data, defaultOpen, gen };
  const schemaKey = isPlainObject(data) ? fieldSchemaKey(Object.keys(data)) : null;
  return (
    <div className="px-2 py-2">
      {isPlainObject(data) && schemaKey ? (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden">
            <FieldHeaderChips value={data} schemaKey={schemaKey} />
          </div>
          <TopLevelObject value={data} schemaKey={schemaKey} ctx={ctx} />
        </>
      ) : (
        <ValueNode value={data} ctx={ctx} />
      )}
    </div>
  );
}

/** A scrollable feed of samples, each rendered as its own card stack. When a
 *  group-by column is active, the feed collapses to one card per group (each
 *  with a member cycler) via `GroupedFeed`. */
function ListMode() {
  const v = useViewerState();
  const { url } = useUrlSync();
  const [markdown, setMarkdown] = usePref<boolean>("json.markdown", true);
  const [defaultOpen, setDefaultOpen] = useState(true);
  const [gen, setGen] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const grouped = !!url.groupBy;

  const { rows, indices, totalFiltered, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useRowFeed("json-list", LIST_PAGE, !grouped);

  usePublishNav(indices, !grouped);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 280,
    overscan: 4,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Infinite scroll: pull the next page once the last rendered card is in view.
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (last && last.index >= rows.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualItems, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const setAll = (openAll: boolean) => { setDefaultOpen(openAll); setGen((g) => g + 1); };
  const schemaKey = isPlainObject(rows[0]) ? fieldSchemaKey(Object.keys(rows[0])) : null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 text-xs">
        <ExpandMdControls markdown={markdown} setMarkdown={setMarkdown} setAll={setAll} />
        <FieldLayoutReset schemaKey={schemaKey} />
        {!grouped && (
          <span className="ml-2 text-[11px] text-zinc-400 dark:text-zinc-600">
            showing {rows.length} of {totalFiltered}
          </span>
        )}
        <div className="ml-auto">
          <JsonModeToggle />
        </div>
      </div>
      {grouped ? (
        <div className="flex-1 min-h-0">
          <GroupedFeed
            renderMember={(idx) => (
              <JsonMember idx={idx} markdown={markdown} defaultOpen={defaultOpen} gen={gen} />
            )}
          />
        </div>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-y-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((vi) => {
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
                    ctx={{ markdown, ctxRow: r, defaultOpen, gen }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** One sample in the scroll feed: an index caption over its card stack. */
function RecordBlock({
  row, idx, active, onSelect, ctx,
}: {
  row: Json;
  idx: number;
  active: boolean;
  onSelect: () => void;
  ctx: NodeCtx;
}) {
  const schemaKey = isPlainObject(row) ? fieldSchemaKey(Object.keys(row)) : null;
  return (
    <article
      onClick={onSelect}
      className={cn(
        "px-4 py-3 border-t border-zinc-200/60 dark:border-zinc-800/70 cursor-default",
        active && "bg-emerald-50/40 dark:bg-emerald-500/[0.04]",
      )}
    >
      <header className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px] font-mono">
        <span className={cn("tracking-wider", active ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500")}>
          row {idx}
        </span>
        {isPlainObject(row) && schemaKey && <FieldHeaderChips value={row} schemaKey={schemaKey} />}
        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <CopyButton variant="json" value={() => JSON.stringify(row, null, 2)} title="copy row JSON" />
        </div>
      </header>
      {isPlainObject(row) && schemaKey ? (
        <TopLevelObject value={row} schemaKey={schemaKey} ctx={ctx} />
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
