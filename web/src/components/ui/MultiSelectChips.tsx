import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { X } from "lucide-react";

/** Tag-input combobox: type to filter `options`, pick to add as a chip,
 *  backspace at empty input pops the last chip. Selection is `value`
 *  (uncontrolled would be wrong here — we want react state to drive). */
interface MultiSelectChipsProps {
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
}

export default function MultiSelectChips({
  options, value, onChange, placeholder, emptyMessage, className,
}: MultiSelectChipsProps) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = input.toLowerCase();
    const valueSet = new Set(value);
    return options
      .filter((o) => !valueSet.has(o))
      .filter((o) => !q || o.toLowerCase().includes(q));
  }, [options, value, input]);

  useEffect(() => { setHighlight(0); }, [input, filtered.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  function add(item: string) {
    if (!options.includes(item)) return;
    if (value.includes(item)) return;
    onChange([...value, item]);
    setInput("");
  }

  function remove(item: string) {
    onChange(value.filter((v) => v !== item));
    inputRef.current?.focus();
  }

  // Drag-to-reorder via the native HTML5 API — no dep, no portal. The chip
  // being dragged stays visible (browser handles the ghost); we only repaint
  // the array on drop. `dragOverIdx` drives a left-edge indicator on the
  // current drop target so the landing slot is obvious.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = value.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && input === "" && value.length > 0) {
      e.preventDefault();
      remove(value[value.length - 1]);
      return;
    }
    if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      add(filtered[highlight] ?? filtered[0]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
      setOpen(true);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setInput("");
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div
        onClick={() => { setOpen(true); inputRef.current?.focus(); }}
        className="flex flex-wrap items-center gap-1 px-1.5 py-1 min-h-[28px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded text-[11px] cursor-text focus-within:border-emerald-600"
      >
        {value.map((v, i) => (
          <span
            key={v}
            draggable
            onDragStart={(e) => {
              setDragIdx(i);
              // Required for Firefox to start the drag; the actual payload
              // doesn't matter because we use state to track which chip is
              // moving.
              e.dataTransfer.setData("text/plain", v);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (dragIdx == null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverIdx !== i) setDragOverIdx(i);
            }}
            onDragLeave={() => {
              if (dragOverIdx === i) setDragOverIdx(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx != null) reorder(dragIdx, i);
              setDragIdx(null);
              setDragOverIdx(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setDragOverIdx(null);
            }}
            title="drag to reorder · click × to remove"
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 select-none cursor-grab active:cursor-grabbing transition",
              dragIdx === i && "opacity-40",
              dragOverIdx === i && dragIdx !== i && "ring-2 ring-emerald-500 ring-offset-1 ring-offset-white dark:ring-offset-zinc-900",
            )}
          >
            {v}
            <button
              onClick={(e) => { e.stopPropagation(); remove(v); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="opacity-60 hover:opacity-100"
              title="remove"
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder={value.length === 0 ? (placeholder ?? "pick…") : ""}
          className="flex-1 min-w-[60px] bg-transparent outline-none font-mono"
        />
      </div>
      {open && (
        <div className="absolute z-40 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded shadow-lg text-[11px]">
          {filtered.length === 0 ? (
            <div className="px-2 py-1.5 text-zinc-500">{emptyMessage ?? "no matches"}</div>
          ) : filtered.map((opt, i) => (
            <button
              key={opt}
              onClick={() => add(opt)}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "block w-full text-left px-2 py-1 font-mono",
                i === highlight
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
