import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { cn } from "../../lib/utils";

const COLORS = [
  "#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#a855f7",
];

export default function MetricsView() {
  const v = useViewerState();
  const { data } = useQuery({
    queryKey: ["metrics", v.dataset_path],
    queryFn: () => api.metrics(v.dataset_path!),
    enabled: !!v.dataset_path,
  });

  const numericCols = useMemo(() => {
    if (!data?.rows.length) return [];
    return Object.keys(data.rows[0]).filter((k) => {
      if (k === "step") return false;
      const v = data.rows[0][k];
      return typeof v === "number";
    });
  }, [data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // First render: pick a sane default subset.
  useMemo(() => {
    if (selected.size === 0 && numericCols.length > 0) {
      const defaults = numericCols
        .filter((c) => c.includes("nll") || c.includes("loss") || c.includes("learning_rate"))
        .slice(0, 6);
      setSelected(new Set(defaults.length ? defaults : numericCols.slice(0, 4)));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericCols.length]);

  if (!data) return <div className="p-6 text-zinc-500 text-sm">loading metrics…</div>;

  return (
    <div className="h-full flex">
      <div className="w-64 shrink-0 border-r border-zinc-200 dark:border-zinc-800 overflow-y-auto p-2 text-xs">
        <div className="text-zinc-500 px-1 py-1 uppercase tracking-wide">columns</div>
        {numericCols.map((c) => (
          <button
            key={c}
            onClick={() => {
              const next = new Set(selected);
              next.has(c) ? next.delete(c) : next.add(c);
              setSelected(next);
            }}
            className={cn(
              "w-full text-left px-2 py-1 rounded hover:bg-white dark:bg-zinc-900 truncate font-mono",
              selected.has(c) && "bg-emerald-900/40 text-emerald-200",
            )}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="flex-1 p-4 overflow-y-auto">
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={data.rows}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="step" stroke="#71717a" fontSize={10} />
            <YAxis stroke="#71717a" fontSize={10} />
            <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {[...selected].map((c, i) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div className="mt-4 text-xs text-zinc-500">
          {data.rows.length} steps · {numericCols.length} numeric columns · {selected.size} selected
        </div>
      </div>
    </div>
  );
}
