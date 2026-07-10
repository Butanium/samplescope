import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { truncate, cn } from "../../lib/utils";
import type { ColumnStats } from "../../lib/types";

// Per-column diagnostic breakdown of the *active* slice (composes with
// filter/sort/shuffle/SQL-selection, exactly like the group-by endpoint). Each
// column becomes a card whose body is chosen by shape: a donut for a few
// categories, a horizontal bar for many, a histogram for numerics/lengths.

const COLORS = [
  "#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#a855f7",
];
const NULL_COLOR = "#a1a1aa"; // zinc-400 — the muted "(null)" slice.

const TOOLTIP_STYLE = { background: "#18181b", border: "1px solid #3f3f46", fontSize: 11, borderRadius: 6 };

/** Compact numeric formatting: integers as-is, tiny/huge in exponential. */
function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return n.toExponential(2);
  return Number(n.toFixed(abs < 1 ? 4 : 2)).toString();
}

export default function StatsView() {
  const v = useViewerState();
  const { data, isLoading, error } = useQuery({
    queryKey: [
      "stats", v.dataset_path,
      v.filter_regex, v.filter_column, v.shuffle_seed, v.sort_column, v.sort_desc,
      // SQL selection composes server-side; key on it so the slice refetches.
      v.sql_query, v.sql_mode, v.sql_selection_count,
    ],
    queryFn: () =>
      api.stats({
        path: v.dataset_path!,
        filter_regex: v.filter_regex,
        filter_column: v.filter_column,
        shuffle_seed: v.shuffle_seed ?? null,
        sort_column: v.sort_column,
        sort_desc: v.sort_desc,
      }),
    enabled: !!v.dataset_path,
  });

  const [showIndex, setShowIndex] = useState(false);

  if (isLoading || !data) return <div className="p-6 text-zinc-500 text-sm">computing stats…</div>;
  if (error) return <div className="p-6 text-red-500 text-sm">stats failed: {String(error)}</div>;

  const filtered = v.filter_regex != null || v.sql_mode === "selection";
  const indexCols = data.columns.filter((c) => c.index_like);
  const gridCols = showIndex ? data.columns : data.columns.filter((c) => !c.index_like);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 text-xs text-zinc-500 dark:text-zinc-400 font-mono">
        <span className="tabular-nums">{data.total_rows.toLocaleString()}</span> rows
        {filtered && <span className="text-emerald-700 dark:text-emerald-400"> (filtered)</span>}
        {" · "}
        <span className="tabular-nums">{data.columns.length}</span> columns
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {gridCols.map((c) => (
          <ColumnCard key={c.name} col={c} />
        ))}
      </div>
      {indexCols.length > 0 && (
        <div className="mt-4 text-[11px] text-zinc-400 dark:text-zinc-600">
          skipped index-like: {indexCols.map((c) => c.name).join(", ")}
          <button
            onClick={() => setShowIndex((s) => !s)}
            className="ml-2 underline decoration-dotted underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            {showIndex ? "hide" : "show"}
          </button>
        </div>
      )}
    </div>
  );
}

function ColumnCard({ col }: { col: ColumnStats }) {
  const pctNull = col.count + col.nulls > 0 ? Math.round((col.nulls / (col.count + col.nulls)) * 100) : 0;
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-3 min-w-0">
      <div className="flex items-center gap-1.5 mb-2 min-w-0">
        <span className="truncate font-medium text-[13px] text-zinc-700 dark:text-zinc-200" title={col.name}>
          {col.name}
        </span>
        <span className="shrink-0 text-[9px] uppercase tracking-wider rounded px-1 py-px bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
          {col.dtype}
        </span>
        {col.nulls > 0 && (
          <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">{pctNull}% null</span>
        )}
        {col.distinct != null && (
          <span className="shrink-0 ml-auto text-[10px] text-zinc-400 dark:text-zinc-600 tabular-nums">
            {col.distinct.toLocaleString()} distinct
          </span>
        )}
      </div>
      <CardBody col={col} />
    </div>
  );
}

function CardBody({ col }: { col: ColumnStats }) {
  const tv = col.top_values;
  // Prefer categorical breakdown when present, even if a histogram also exists.
  if (tv && tv.length > 0) {
    return tv.length <= 8 ? <DonutBody col={col} /> : <TopBarsBody col={col} />;
  }
  if (col.histogram) return <HistogramBody col={col} />;
  return (
    <div className="text-[11px] text-zinc-400 dark:text-zinc-600 tabular-nums">
      {col.count.toLocaleString()} non-null · {col.nulls.toLocaleString()} null
    </div>
  );
}

/** ≤ 8 categories → donut with a compact legend (+ a muted null slice). */
function DonutBody({ col }: { col: ColumnStats }) {
  const slices = [
    ...(col.top_values ?? []).map((t, i) => ({ name: t.value, count: t.count, color: COLORS[i % COLORS.length] })),
    ...(col.nulls > 0 ? [{ name: "(null)", count: col.nulls, color: NULL_COLOR }] : []),
  ];
  return (
    <div className="flex items-center gap-2">
      <div className="shrink-0" style={{ width: 120, height: 120 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="count" nameKey="name" innerRadius={30} outerRadius={55} paddingAngle={1} isAnimationActive={false}>
              {slices.map((s, i) => (
                <Cell key={i} fill={s.color} stroke="none" />
              ))}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(val: any, name: any) => [val, name]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="min-w-0 flex-1 space-y-0.5 text-[11px]">
        {slices.map((s, i) => (
          <li key={i} className="flex items-center gap-1.5 min-w-0">
            <span className="shrink-0 w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
            <span className="truncate text-zinc-600 dark:text-zinc-300" title={s.name}>
              {s.name === "" ? "(empty)" : s.name}
            </span>
            <span className="shrink-0 ml-auto tabular-nums text-zinc-400 dark:text-zinc-600">{s.count.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** > 8 categories → horizontal bars for the top 20, "+N other" footer. */
function TopBarsBody({ col }: { col: ColumnStats }) {
  const rows = (col.top_values ?? []).map((t) => ({
    label: truncate(t.value === "" ? "(empty)" : t.value, 24),
    full: t.value === "" ? "(empty)" : t.value,
    count: t.count,
  }));
  const height = Math.max(140, rows.length * 22);
  return (
    <div>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 12, top: 2, bottom: 2 }}>
            <XAxis type="number" stroke="#a1a1aa" fontSize={10} allowDecimals={false} />
            <YAxis type="category" dataKey="label" stroke="#a1a1aa" fontSize={10} width={130} tick={{ fontSize: 10 }} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(val: any) => [val, "count"]}
              labelFormatter={(_l: any, p: any) => p?.[0]?.payload?.full ?? ""}
            />
            <Bar dataKey="count" fill={COLORS[1]} isAnimationActive={false} radius={[0, 2, 2, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {col.other_count > 0 && (
        <div className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-600 tabular-nums">
          +{col.other_count.toLocaleString()} other
        </div>
      )}
    </div>
  );
}

/** Numeric / length histogram from bin_edges + counts. */
function HistogramBody({ col }: { col: ColumnStats }) {
  const h = col.histogram!;
  const bars = h.counts.map((count, i) => ({
    label: fmtNum(h.bin_edges[i]),
    range: `[${fmtNum(h.bin_edges[i])}, ${fmtNum(h.bin_edges[i + 1])})`,
    count,
  }));
  const xCaption = h.is_length
    ? col.dtype === "list" ? "length (items)" : "length (chars)"
    : null;
  return (
    <div>
      <div style={{ width: "100%", height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars} margin={{ left: 4, right: 8, top: 2, bottom: 2 }}>
            <CartesianGrid stroke="#71717a" strokeOpacity={0.15} vertical={false} />
            <XAxis dataKey="label" stroke="#a1a1aa" fontSize={9} interval="preserveStartEnd" />
            <YAxis stroke="#a1a1aa" fontSize={9} allowDecimals={false} width={28} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(val: any) => [val, "count"]}
              labelFormatter={(_l: any, p: any) => p?.[0]?.payload?.range ?? ""}
            />
            <Bar dataKey="count" fill={COLORS[0]} isAnimationActive={false} radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {xCaption && (
        <div className="text-center text-[9px] uppercase tracking-wider text-zinc-400 dark:text-zinc-600">{xCaption}</div>
      )}
      {col.dtype === "numeric" && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
          <Stat label="min" value={fmtNum(col.min)} />
          <Stat label="med" value={fmtNum(col.median)} />
          <Stat label="mean" value={fmtNum(col.mean)} />
          <Stat label="max" value={fmtNum(col.max)} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className={cn("tabular-nums")}>
      <span className="text-zinc-400 dark:text-zinc-600">{label} </span>
      <span className="text-zinc-600 dark:text-zinc-300">{value}</span>
    </span>
  );
}
