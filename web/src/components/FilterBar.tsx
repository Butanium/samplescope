// Filter controls built from the open dataset's own columns, so the common
// filters are a dropdown away instead of typed: a value picker per low-
// cardinality column, a ≥ / ≤ pair per numeric one, a "has" picker per list
// column. Every control reads and writes the same `[column, text, mode]`
// triples as the header's filter box and the stats view's clicks (URL
// `filters=`), so the three stay in step and a filtered view is a link.

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import { useViewerState } from "../lib/state";
import { parseComparison, useUrlSync, type FilterTriple } from "../lib/url";
import { usePref } from "../lib/prefs";
import { cn } from "../lib/utils";

type Option = { value: string; count: number };
type Dim =
  | { col: string; kind: "cat" | "list"; options: Option[] }
  | { col: string; kind: "num"; options: Option[] }
  | { col: string; kind: "range"; min: number | null; max: number | null };
/** Which filter of a column a control owns. */
type Slot = "eq" | "has" | "ge" | "le";

const MAX_OPTIONS = 12;
const pretty = (s: string) => s.replace(/_/g, " ");
const SELECT =
  "max-w-[11rem] rounded border bg-transparent px-1 py-px text-[12px] text-zinc-800 dark:text-zinc-200";
const idle = "border-zinc-300 dark:border-zinc-700";
const active = "border-emerald-500 bg-emerald-500/10";

function slotOf([, text, mode]: FilterTriple): Slot | null {
  if (mode === "exact") return "eq";
  if (mode === "text") return "has";
  if (mode === "cmp") {
    const op = parseComparison(text)?.op;
    return op === ">=" ? "ge" : op === "<=" ? "le" : null;
  }
  return null;
}

export default function FilterBar({ primary }: { primary?: (column: string) => boolean }) {
  const v = useViewerState();
  const { url, setFilters } = useUrlSync();
  const [open, setOpen] = usePref<boolean>("filterBar.open", true);
  const [more, setMore] = usePref<boolean>("filterBar.more", false);
  const path = v.dataset_path;

  // Cross-filtered: each column's counts ignore the filters on that column.
  const statsQ = useQuery({
    queryKey: ["filterbar-stats", path, v.filters, v.sql_mode, v.sql_query],
    queryFn: () => api.stats({ path: path!, filters: v.filters }),
    enabled: !!path && open,
    placeholderData: keepPreviousData,
  });
  const listCols = useMemo(
    () => (statsQ.data?.columns ?? []).filter((c) => c.dtype === "list").map((c) => c.name),
    [statsQ.data],
  );
  // The distinct string elements of each list column (over the whole file).
  const listsQ = useQuery({
    queryKey: ["filterbar-lists", path, listCols.join("\n")],
    queryFn: async () => {
      const out: Record<string, Option[]> = {};
      for (const c of listCols) {
        const col = `"${c.replace(/"/g, '""')}"`;
        try {
          const r = await api.sql(
            `SELECT x AS value, count(*) AS n FROM (SELECT unnest(${col}) AS x FROM t) ` +
            `WHERE typeof(x) = 'VARCHAR' GROUP BY 1 ORDER BY 2 DESC LIMIT 40`,
            path!,
          );
          out[c] = r.rows.map(([value, n]) => ({ value: String(value), count: Number(n) }));
        } catch {
          out[c] = [];
        }
      }
      return out;
    },
    enabled: !!path && open && listCols.length > 0,
    staleTime: 60_000,
  });

  const filters = url.filters;
  const current = (col: string, slot: Slot): string => {
    const f = filters.find((t) => t[0] === col && slotOf(t) === slot);
    if (!f) return "";
    return slot === "ge" || slot === "le" ? String(parseComparison(f[1])?.value ?? "") : f[1];
  };
  const set = (col: string, slot: Slot, value: string) => {
    const keep = filters.filter((t) => !(t[0] === col && slotOf(t) === slot));
    const add: FilterTriple[] = value === "" ? []
      : slot === "eq" ? [[col, value, "exact"]]
      : slot === "has" ? [[col, value, "text"]]
      : [[col, `${slot === "ge" ? ">=" : "<="} ${value}`, "cmp"]];
    setFilters([...keep, ...add]);
  };

  const dims: Dim[] = useMemo(() => {
    const out: Dim[] = [];
    const filtered = new Set(filters.map((t) => t[0]));
    for (const c of statsQ.data?.columns ?? []) {
      if (c.index_like) continue;
      if (c.dtype === "list") {
        const options = listsQ.data?.[c.name] ?? [];
        if (options.length >= 2) out.push({ col: c.name, kind: "list", options });
        continue;
      }
      // A column with one value filters nothing (unless a filter is already on it).
      if ((c.distinct ?? 0) < 2 && !filtered.has(c.name)) continue;
      const top = c.top_values ?? null;
      if (c.dtype === "numeric") {
        if (top && top.length <= MAX_OPTIONS && !c.other_count) {
          out.push({ col: c.name, kind: "num", options: [...top].sort((a, b) => Number(a.value) - Number(b.value)) });
        } else {
          out.push({ col: c.name, kind: "range", min: c.min ?? null, max: c.max ?? null });
        }
      } else if ((c.dtype === "categorical" || c.dtype === "boolean") && top && top.length <= MAX_OPTIONS && !c.other_count) {
        out.push({ col: c.name, kind: "cat", options: top });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsQ.data, listsQ.data, JSON.stringify(filters)]);

  if (!path) return null;
  const isPrimary = (d: Dim) => !primary || primary(d.col);
  const first = dims.filter(isPrimary);
  const rest = dims.filter((d) => !isPrimary(d));
  // A filter you cannot see is worse than one behind a fold.
  const restActive = rest.some((d) => filters.some((t) => t[0] === d.col));
  const showRest = more || restActive;

  return (
    <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-800 px-3 py-1 text-[12px]" data-filter-bar>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 font-semibold uppercase tracking-wider text-[10.5px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
          filters
        </button>
        {statsQ.data && (
          <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
            <b className="text-zinc-900 dark:text-zinc-100">{statsQ.data.total_rows}</b> of {v.row_count} rows
            {v.sql_mode === "selection" && " (inside the row selection)"}
          </span>
        )}
        {filters.length > 0 && (
          <button onClick={() => setFilters([])} className="rounded px-1 text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-800 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200">
            clear {filters.length} filter{filters.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 pb-0.5">
          {first.map((d) => <Control key={d.col} d={d} current={current} set={set} />)}
          {rest.length > 0 && (
            <button
              onClick={() => setMore(!showRest)}
              disabled={restActive}
              className="flex items-center gap-1 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-60"
            >
              <ChevronRight size={12} className={cn("transition-transform", showRest && "rotate-90")} />
              {rest.length} more column{rest.length === 1 ? "" : "s"}
            </button>
          )}
          {showRest && rest.map((d) => <Control key={d.col} d={d} current={current} set={set} />)}
          {!statsQ.data && <span className="text-zinc-500">loading…</span>}
        </div>
      )}
    </div>
  );
}

function Control({ d, current, set }: {
  d: Dim;
  current: (col: string, slot: Slot) => string;
  set: (col: string, slot: Slot, value: string) => void;
}) {
  const label = <span className="text-zinc-600 dark:text-zinc-400" title={d.col}>{pretty(d.col)}</span>;
  if (d.kind === "cat" || d.kind === "list") {
    const slot: Slot = d.kind === "cat" ? "eq" : "has";
    const val = current(d.col, slot);
    return (
      <label className="flex items-center gap-1">
        {label}{d.kind === "list" && <span className="text-zinc-500">has</span>}
        <select value={val} onChange={(e) => set(d.col, slot, e.target.value)} className={cn(SELECT, val ? active : idle)}>
          <option value="">any</option>
          {val && !d.options.some((o) => o.value === val) && <option value={val}>{val}</option>}
          {d.options.map((o) => <option key={o.value} value={o.value}>{pretty(o.value)} ({o.count})</option>)}
        </select>
      </label>
    );
  }
  if (d.kind === "num") {
    const total = (keep: (x: number) => boolean) =>
      d.options.reduce((n, o) => n + (keep(Number(o.value)) ? o.count : 0), 0);
    const pick = (slot: "ge" | "le", sign: string) => {
      const val = current(d.col, slot);
      return (
        <select value={val} onChange={(e) => set(d.col, slot, e.target.value)} className={cn(SELECT, val ? active : idle)} title={`${d.col} ${sign} …`}>
          <option value="">{sign} any</option>
          {val && !d.options.some((o) => String(Number(o.value)) === val) && <option value={val}>{sign} {val}</option>}
          {d.options.map((o) => {
            const x = Number(o.value);
            return (
              <option key={o.value} value={String(x)}>
                {sign} {x} ({total((y) => (slot === "ge" ? y >= x : y <= x))})
              </option>
            );
          })}
        </select>
      );
    };
    return <span className="flex items-center gap-1">{label}{pick("ge", "≥")}{pick("le", "≤")}</span>;
  }
  if (!("min" in d)) return null;
  const box = (slot: "ge" | "le", sign: string, bound: number | null) => {
    const val = current(d.col, slot);
    return (
      <input
        key={`${slot}:${val}`}
        type="number"
        defaultValue={val}
        placeholder={`${sign} ${bound != null ? Number(bound.toPrecision(4)) : ""}`}
        title={`${d.col} ${sign} … (Enter to apply)`}
        onBlur={(e) => { if (e.target.value !== val) set(d.col, slot, e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={cn("w-20 rounded border bg-transparent px-1 py-px text-[12px]", val ? active : idle)}
      />
    );
  };
  return <span className="flex items-center gap-1">{label}{box("ge", "≥", d.min)}{box("le", "≤", d.max)}</span>;
}
