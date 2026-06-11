import { X, Database, FileText, Star, Scale, FileBox } from "lucide-react";
import { useChatTabs, shortLabel, type ContextItem } from "../lib/chatTabs";
import { cn } from "../lib/utils";

const ICON: Record<ContextItem["kind"], React.ReactNode> = {
  dataset: <Database size={10} />,
  row: <FileText size={10} />,
  mark: <Star size={10} />,
  judge_result: <Scale size={10} />,
  eval_sample: <FileBox size={10} />,
};

const TONE: Record<ContextItem["kind"], string> = {
  dataset: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  row: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  mark: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  judge_result: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  eval_sample: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30",
};

/** A horizontal chip strip above the chat input. Empty = renders nothing. */
export default function ContextTray({ tabId }: { tabId: string }) {
  const { trays, removeContextItem, clearTray } = useChatTabs();
  const items = trays[tabId] ?? [];
  if (items.length === 0) return null;
  return (
    <div className="px-2 pt-2 pb-1 border-t border-zinc-200 dark:border-zinc-800 flex items-center flex-wrap gap-1">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mr-1">pinned</span>
      {items.map((it) => (
        <span
          key={it.id}
          className={cn(
            "inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 text-[10px] font-mono rounded border",
            TONE[it.kind],
          )}
          title={JSON.stringify(it, null, 2)}
        >
          {ICON[it.kind]}
          <span>{shortLabel(it)}</span>
          <button
            onClick={() => removeContextItem(tabId, it.id)}
            className="ml-0.5 px-0.5 hover:opacity-70"
            aria-label="remove"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <button
        onClick={() => clearTray(tabId)}
        className="ml-auto text-[10px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
      >
        clear
      </button>
    </div>
  );
}
