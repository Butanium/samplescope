import { useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { useRowPage, usePublishNav } from "../../lib/rowPage";
import { truncate, cn } from "../../lib/utils";

const PAGE = 200;

export default function TableRowView() {
  const v = useViewerState();
  const parentRef = useRef<HTMLDivElement>(null);

  const { data: page } = useRowPage("table", { limit: PAGE });

  const rows = page?.rows ?? [];
  const indices = page?.indices ?? [];

  // Step arrow / j / k through the visible order (matters under filter/shuffle).
  usePublishNav(indices);
  const cols = useMemo(() => {
    if (!rows[0]) return v.columns.filter((c) => c !== "__idx");
    return Object.keys(rows[0]);
  }, [rows, v.columns]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 12,
  });

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-1 border-b border-zinc-200 dark:border-zinc-800 flex items-center text-[11px] text-zinc-500">
        showing {rows.length} of {page?.total_filtered ?? 0} rows · click a row to expand
      </div>
      <div ref={parentRef} className="flex-1 overflow-auto font-mono text-[11px]">
        <div className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800 flex">
          <div className="w-14 shrink-0 px-2 py-1 text-zinc-500">idx</div>
          {cols.map((c) => (
            <div key={c} className="px-2 py-1 text-zinc-600 dark:text-zinc-400 truncate" style={{ width: 220 }}>{c}</div>
          ))}
        </div>
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const r = rows[vi.index];
            const idx = indices[vi.index];
            const active = v.row_idx === idx;
            return (
              <div
                key={vi.key}
                onClick={() => api.goto(idx)}
                style={{
                  position: "absolute", top: 0, left: 0, width: "100%",
                  transform: `translateY(${vi.start}px)`, height: vi.size,
                }}
                className={cn(
                  "flex border-b border-zinc-100 dark:border-zinc-900 hover:bg-white dark:bg-zinc-900/60 cursor-pointer",
                  active && "bg-emerald-950/30",
                )}
              >
                <div className="w-14 shrink-0 px-2 py-1 text-zinc-400 dark:text-zinc-600">{idx}</div>
                {cols.map((c) => (
                  <div key={c} className="px-2 py-1 truncate text-zinc-700 dark:text-zinc-300" style={{ width: 220 }}>
                    {fmtCell(r[c])}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {indices.includes(v.row_idx) && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 max-h-[40vh] overflow-y-auto p-3 text-xs">
          <div className="text-zinc-500 mb-2 font-mono">row {v.row_idx}</div>
          <pre className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(rows[indices.indexOf(v.row_idx)], null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function fmtCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return truncate(v, 80);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return truncate(JSON.stringify(v), 80);
}
