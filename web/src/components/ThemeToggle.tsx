import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../lib/theme";

const CYCLE = ["system", "light", "dark"] as const;
const ICON = { system: Monitor, light: Sun, dark: Moon };

/** One button cycling system → light → dark (one rail slot wide). */
export default function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const next = CYCLE[(CYCLE.indexOf(choice) + 1) % CYCLE.length];
  const Icon = ICON[choice];
  return (
    <button
      onClick={() => setChoice(next)}
      title={`theme: ${choice} (click for ${next})`}
      className="w-7 h-7 rounded-full border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800 transition"
    >
      <Icon size={13} />
    </button>
  );
}
