import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { setNavIndices } from "../../lib/nav";
import { cn } from "../../lib/utils";
import Collapsible from "../Collapsible";

/**
 * Mode C of the SQL pad: the main viewport renders the SQL result as a
 * table. Activated by clicking "apply as view" in the SQL drawer (or via
 * `?sqlmode=view` in the URL).
 *
 * Rows with an `__idx` column are clickable → goto, and that __idx list is
 * also published to the nav cursor so j/k step through the SQL result order.
 * Rows without __idx (aggregations, computed shapes) render as a plain
 * read-only table.
 */
export default function SqlView() {
  const v = useViewerState();
  const { data, isLoading, error } = useQuery({
    queryKey: ["sql-view", v.dataset_path, v.sql_query],
    queryFn: () => api.sql(v.sql_query!, v.dataset_path ?? undefined),
    enabled: !!v.sql_query && !!v.dataset_path,
  });

  const idxCol = data?.columns.indexOf("__idx") ?? -1;
  const navigable = idxCol >= 0;

  useEffect(() => {
    if (!data || !navigable) {
      setNavIndices([]);
      return;
    }
    const idxs = data.rows
      .map((r) => Number(r[idxCol]))
      .filter((n) => Number.isFinite(n));
    setNavIndices(idxs);
    return () => setNavIndices([]);
  }, [data, idxCol, navigable]);

  if (!v.sql_query) {
    return (
      <div className="h-full grid place-items-center text-zinc-500 text-sm p-6 text-center">
        <div>
          <div>SQL view active but no query stored.</div>
          <div className="text-xs mt-2 opacity-70">Open the SQL drawer (\\) and apply a query.</div>
        </div>
      </div>
    );
  }
  if (isLoading) return <div className="p-6 text-zinc-500 text-sm">running SQL…</div>;
  if (error) {
    return (
      <div className="p-4">
        <pre className="text-xs text-red-400 whitespace-pre-wrap font-mono bg-red-950/30 border border-red-900 p-3 rounded">
          {String((error as any)?.message ?? error)}
        </pre>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="h-full overflow-auto font-mono text-xs">
      <div className="px-3 py-1 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2 text-[11px] text-zinc-500">
        SQL view · {data.rows.length} rows
        {navigable
          ? <span className="text-emerald-600 dark:text-emerald-400">· rows clickable → goto · j/k navigate this order</span>
          : <span className="text-zinc-400">· no __idx column · read-only</span>}
      </div>
      <table className="border-collapse w-full">
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th key={c} className={cn(
                "text-left px-3 py-1.5 sticky top-7 bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400",
                c === "__idx" && "text-emerald-700 dark:text-emerald-400",
              )}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => {
            const rowIdx = navigable ? Number(r[idxCol]) : null;
            const active = rowIdx != null && rowIdx === v.row_idx;
            return (
              <tr
                key={i}
                onClick={navigable && rowIdx != null ? () => api.goto(rowIdx) : undefined}
                className={cn(
                  "border-b border-zinc-100 dark:border-zinc-900",
                  navigable
                    ? "hover:bg-emerald-500/10 cursor-pointer"
                    : "hover:bg-white dark:bg-zinc-900/40",
                  active && "bg-emerald-500/15",
                )}
              >
                {r.map((cell, j) => (
                  <td key={j} className="px-3 py-1 text-zinc-700 dark:text-zinc-300 align-top max-w-lg">
                    <Collapsible chars={200} lines={2}>
                      {typeof cell === "string" ? cell : JSON.stringify(cell)}
                    </Collapsible>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
