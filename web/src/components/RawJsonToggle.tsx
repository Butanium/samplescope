import { Braces } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  value: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}

/**
 * Controlled inline toggle. Active state means "render this thing as raw
 * JSON instead of its parsed presentation." The parent owns the state and
 * is responsible for swapping the content; this component is just the switch.
 */
export default function RawJsonToggle({ value, onChange, title }: Props) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange(!value);
      }}
      title={title ?? (value ? "show parsed" : "show raw JSON")}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded-sm transition-colors",
        value
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60",
      )}
    >
      <Braces size={10} />
      raw
    </button>
  );
}
