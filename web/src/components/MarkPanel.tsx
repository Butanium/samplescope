import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useViewerState } from "../lib/state";
import { X } from "lucide-react";
import { useState } from "react";
import { truncate } from "../lib/utils";
import { usePinHandler } from "../lib/pin";

export default function MarkPanel({ onClose }: { onClose: () => void }) {
  const v = useViewerState();
  const pin = usePinHandler();
  const [scope, setScope] = useState<"current" | "all">("current");
  const { data } = useQuery({
    queryKey: ["all-marks", scope, v.dataset_path],
    queryFn: () => api.listMarks(scope === "current" ? v.dataset_path ?? undefined : undefined),
  });

  return (
    <>
      <PanelHeader title="marks" onClose={onClose}>
        <div className="flex gap-1 text-[10px]">
          <button
            onClick={() => setScope("current")}
            className={"px-2 py-0.5 rounded " + (scope === "current" ? "bg-emerald-700" : "bg-zinc-200 dark:bg-zinc-800")}
          >current</button>
          <button
            onClick={() => setScope("all")}
            className={"px-2 py-0.5 rounded " + (scope === "all" ? "bg-emerald-700" : "bg-zinc-200 dark:bg-zinc-800")}
          >all</button>
        </div>
      </PanelHeader>
      <div className="flex-1 overflow-y-auto text-xs">
        {!data || data.length === 0 ? (
          <div className="p-3 text-zinc-500">no marks yet</div>
        ) : data.map((m) => (
          <button
            key={`${m.dataset_path}::${m.row_idx}`}
            onClick={(e) => {
              if (pin(e, { kind: "mark", path: m.dataset_path, idx: m.row_idx, tags: m.tags, note: m.note })) return;
              if (m.dataset_path !== v.dataset_path) api.openDataset(m.dataset_path).then(() => api.goto(m.row_idx));
              else api.goto(m.row_idx);
            }}
            title="shift+click to pin to chat"
            className="w-full text-left px-3 py-2 border-b border-zinc-100 dark:border-zinc-900 hover:bg-white dark:bg-zinc-900"
          >
            <div className="font-mono text-zinc-700 dark:text-zinc-300">#{m.row_idx} · {m.tags.join(", ") || <span className="text-zinc-400 dark:text-zinc-600">(no tags)</span>}</div>
            <div className="text-[10px] text-zinc-500 truncate">{truncate(m.dataset_path, 60)}</div>
            {m.note && <div className="text-[10px] text-zinc-600 dark:text-zinc-400 mt-0.5">{truncate(m.note, 100)}</div>}
          </button>
        ))}
      </div>
    </>
  );
}

export function PanelHeader({ title, onClose, children }: { title: string; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="h-10 shrink-0 px-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-zinc-600 dark:text-zinc-400">{title}</span>
      {children}
      <button onClick={onClose} className="ml-auto p-1 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded">
        <X size={14} />
      </button>
    </div>
  );
}
