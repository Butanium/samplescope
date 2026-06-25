import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { useViewerState } from "../lib/state";
import { useUrlSync } from "../lib/url";
import { nextIdx, prevIdx, setNavGroups } from "../lib/nav";
import { useGroups } from "../lib/groups";
import { cn, copyToClipboard } from "../lib/utils";
import { Shuffle, ChevronLeft, ChevronRight, X, Filter, ArrowUp, ArrowDown, Layers } from "lucide-react";

export default function DatasetHeader() {
  const v = useViewerState();
  const { url, setFilter, setGroupBy } = useUrlSync();
  // Always mounted, so it's the single place that publishes the grouping into
  // the nav cursor (single-mode j/k between groups, [ ] within). The per-card
  // cyclers in the grouped feed don't go through nav — they hold local state.
  const groups = useGroups();
  useEffect(() => {
    setNavGroups(groups.groups ? groups.groups.map((g) => g.indices) : null);
    return () => setNavGroups(null);
  }, [groups.groups]);
  const [textDraft, setTextDraft] = useState(url.filterText ?? "");
  const [columnDraft, setColumnDraft] = useState(url.filterColumn ?? "");
  const [isRegex, setIsRegex] = useState(url.filterIsRegex);
  const [pathCopied, setPathCopied] = useState(false);

  useEffect(() => { setTextDraft(url.filterText ?? ""); }, [url.filterText]);
  useEffect(() => { setColumnDraft(url.filterColumn ?? ""); }, [url.filterColumn]);
  useEffect(() => { setIsRegex(url.filterIsRegex); }, [url.filterIsRegex]);

  if (!v.dataset_path) {
    return <div className="h-12 border-b border-zinc-200 dark:border-zinc-800 flex items-center px-3 text-xs text-zinc-500">no dataset open</div>;
  }
  const total = v.row_count;
  const idx = v.row_idx;

  const apply = () => {
    setFilter(textDraft.trim() || null, columnDraft.trim() || null, isRegex);
  };
  const clear = () => {
    setTextDraft("");
    setColumnDraft("");
    setIsRegex(false);
    setFilter(null, null, false);
  };

  return (
    <header className="h-12 shrink-0 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2 px-3 text-xs">
      <div className="font-mono truncate flex-1 min-w-0 text-zinc-700 dark:text-zinc-300">
        <span
          role="button"
          tabIndex={0}
          onClick={async () => {
            if (await copyToClipboard(v.dataset_path!)) {
              setPathCopied(true);
              setTimeout(() => setPathCopied(false), 1100);
            }
          }}
          title={pathCopied ? "copied!" : "click to copy relative path"}
          className={cn(
            "cursor-pointer hover:underline decoration-dotted underline-offset-2",
            pathCopied
              ? "text-emerald-600 dark:text-emerald-400"
              : "hover:text-emerald-700 dark:hover:text-emerald-400",
          )}
        >
          {v.dataset_path}
        </span>
        <span className="ml-2 text-zinc-400 dark:text-zinc-600">· {v.view_kind} · {total} rows</span>
        {v.sql_mode === "selection" && v.sql_selection_count != null && (
          <span className="ml-2 text-emerald-700 dark:text-emerald-400">
            · SQL sel: {v.sql_selection_count}
          </span>
        )}
        {v.sql_mode === "view" && (
          <span className="ml-2 text-emerald-700 dark:text-emerald-400">· SQL view</span>
        )}
      </div>
      {pathCopied && (
        <span className="shrink-0 text-emerald-600 dark:text-emerald-400 font-mono">copied ✓</span>
      )}
      <button
        onClick={() => {
          const t = prevIdx(idx);
          api.goto(t != null ? t : Math.max(0, idx - 1));
        }}
        className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded" title="prev (k)">
        <ChevronLeft size={14} />
      </button>
      <input
        type="number"
        value={idx}
        onChange={(e) => api.goto(Number(e.target.value))}
        className="w-20 px-1 py-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded outline-none focus:border-emerald-600"
      />
      <span className="text-zinc-400 dark:text-zinc-600">/ {total}</span>
      <button
        onClick={() => {
          const t = nextIdx(idx);
          api.goto(t != null ? t : Math.min(total - 1, idx + 1));
        }}
        className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded"
        title={groups.groupBy ? "next group (j)" : "next (j)"}>
        <ChevronRight size={14} />
      </button>
      <button
        onClick={() => api.shuffle()}
        className={cn(
          "p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded flex items-center gap-1",
          v.shuffle_seed != null && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        )}
        title="shuffle (s) — clears sort"
      >
        <Shuffle size={14} />
        <span className="text-[11px]">{v.shuffle_seed != null ? `seed ${v.shuffle_seed}` : "shuffle"}</span>
      </button>
      <SortControl
        columns={v.columns}
        sortColumn={v.sort_column}
        sortDesc={v.sort_desc}
      />
      <GroupControl columns={v.columns} groupBy={groups.groupBy} onChange={setGroupBy} />
      <div className="flex items-center gap-1 border-l border-zinc-200 dark:border-zinc-800 pl-2 ml-1">
        <Filter size={14} className="opacity-60" />
        <div className="relative">
          <input
            id="filter-input"
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && apply()}
            placeholder={isRegex ? "regex…" : "search…"}
            className={cn(
              "w-52 pl-1.5 pr-7 py-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded outline-none focus:border-emerald-600",
              isRegex ? "font-mono" : "font-sans",
            )}
          />
          <button
            onClick={() => setIsRegex(!isRegex)}
            title={isRegex ? "regex (click for literal)" : "literal (click for regex)"}
            className={cn(
              "absolute right-0.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded grid place-items-center font-mono text-[10px] tracking-tight transition-colors",
              isRegex
                ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
                : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70",
            )}
          >
            .*
          </button>
        </div>
        <input
          value={columnDraft}
          onChange={(e) => setColumnDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
          placeholder="column"
          className="w-28 px-1.5 py-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono outline-none focus:border-emerald-600"
        />
        <button
          onClick={apply}
          className="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-600 text-zinc-50 rounded">apply</button>
        {(url.filterText || url.filterColumn) && (
          <button onClick={clear} className="p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded" title="clear">
            <X size={12} />
          </button>
        )}
      </div>
    </header>
  );
}

/** Column dropdown + asc/desc toggle. Setting a column clears shuffle (mutex,
 *  enforced server-side). Picking "—" clears sort and lets shuffle/natural
 *  order take over. */
function SortControl({
  columns, sortColumn, sortDesc,
}: { columns: string[]; sortColumn: string | null; sortDesc: boolean }) {
  // __idx is the synthetic row-index column we tack on in `_build_rows_query`
  // — exposing it for sort doesn't make sense (it's literally the natural
  // order); strip from the dropdown.
  const choices = columns.filter((c) => c !== "__idx");
  return (
    <div className="flex items-center gap-1 border-l border-zinc-200 dark:border-zinc-800 pl-2 ml-1">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">sort</span>
      <select
        value={sortColumn ?? ""}
        onChange={(e) => api.setSort(e.target.value || null, sortDesc)}
        className={cn(
          "max-w-[140px] px-1 py-0.5 bg-white dark:bg-zinc-900 border rounded font-mono text-[11px] outline-none focus:border-emerald-600",
          sortColumn
            ? "border-emerald-500/60"
            : "border-zinc-200 dark:border-zinc-800",
        )}
        title="sort by column (clears shuffle)"
      >
        <option value="">—</option>
        {choices.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <button
        onClick={() => sortColumn && api.setSort(sortColumn, !sortDesc)}
        disabled={!sortColumn}
        title={sortDesc ? "descending (click for ascending)" : "ascending (click for descending)"}
        className={cn(
          "p-1 rounded transition-colors",
          sortColumn
            ? "hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
            : "text-zinc-300 dark:text-zinc-700 cursor-not-allowed",
        )}
      >
        {sortDesc ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
      </button>
    </div>
  );
}

/** Pick a column to bucket samples by. The header arrows / j / k then step
 *  between groups; the Cycler walks the samples inside one group. */
function GroupControl({
  columns, groupBy, onChange,
}: { columns: string[]; groupBy: string | null; onChange: (c: string | null) => void }) {
  const choices = columns.filter((c) => c !== "__idx");
  // Chat-format rows expose synthetic keys for the first two turns' content, so
  // you can bucket conversations by their opening user/assistant message.
  const messageKeys = columns.includes("messages") ? ["message_1", "message_2"] : [];
  return (
    <div className="flex items-center gap-1 border-l border-zinc-200 dark:border-zinc-800 pl-2 ml-1">
      <Layers size={13} className={cn(groupBy ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500")} />
      <select
        value={groupBy ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={cn(
          "max-w-[140px] px-1 py-0.5 bg-white dark:bg-zinc-900 border rounded font-mono text-[11px] outline-none focus:border-emerald-600",
          groupBy ? "border-emerald-500/60" : "border-zinc-200 dark:border-zinc-800",
        )}
        title="group samples by a column's value (navigation overlay)"
      >
        <option value="">group: —</option>
        {messageKeys.length > 0 && (
          <optgroup label="messages[].content">
            {messageKeys.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </optgroup>
        )}
        {choices.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}
