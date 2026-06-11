import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../lib/theme";
import { cn } from "../lib/utils";

export default function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const opts: { v: typeof choice; icon: React.ReactNode; title: string }[] = [
    { v: "system", icon: <Monitor size={12} />, title: "system" },
    { v: "light", icon: <Sun size={12} />, title: "light" },
    { v: "dark", icon: <Moon size={12} />, title: "dark" },
  ];
  return (
    <div className="flex border border-zinc-300 dark:border-zinc-800 rounded overflow-hidden">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => setChoice(o.v)}
          title={`theme: ${o.title}`}
          className={cn(
            "px-1.5 py-1",
            choice === o.v
              ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
              : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800",
          )}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
