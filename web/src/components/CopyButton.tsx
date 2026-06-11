import { useState } from "react";
import { Check, Copy, Braces, FileText } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  /** The content to copy when clicked. Lazy in case it's expensive. */
  value: string | (() => string);
  /** Visual style: plain copy / explicit JSON / explicit markdown. */
  variant?: "plain" | "json" | "markdown";
  title?: string;
  className?: string;
}

const ICON: Record<NonNullable<Props["variant"]>, React.ReactNode> = {
  plain: <Copy size={11} />,
  json: <Braces size={11} />,
  markdown: <FileText size={11} />,
};

const LABEL: Record<NonNullable<Props["variant"]>, string> = {
  plain: "copy",
  json: "json",
  markdown: "md",
};

export default function CopyButton({ value, variant = "plain", title, className }: Props) {
  const [copied, setCopied] = useState(false);
  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    const text = typeof value === "function" ? value() : value;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1100);
    } catch {
      /* clipboard API blocked — silently fail; nothing meaningful to recover. */
    }
  }
  return (
    <button
      onClick={copy}
      title={title ?? `copy ${variant}`}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded-sm transition-colors",
        copied
          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
          : "text-zinc-400 dark:text-zinc-600 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60",
        className,
      )}
    >
      {copied ? <Check size={11} /> : ICON[variant]}
      <span>{copied ? "ok" : LABEL[variant]}</span>
    </button>
  );
}
