import { useEffect, useState } from "react";
import { usePref } from "../lib/prefs";
import DatasetTree from "./DatasetTree";
import DatasetHeader from "./DatasetHeader";
import ChatRowView from "./views/ChatRowView";
import TableRowView from "./views/TableRowView";
import MetricsView from "./views/MetricsView";
import EvalLogView from "./views/EvalLogView";
import JsonTreeView from "./views/JsonTreeView";
import MarkdownView from "./views/MarkdownView";
import StatsView from "./views/StatsView";
import SqlView from "./views/SqlView";
import ChatDrawer from "./ChatDrawer";
import SqlPad from "./SqlPad";
import MarkPanel from "./MarkPanel";
import JudgePanel from "./JudgePanel";
import HighlightsPanel from "./HighlightsPanel";
import HelpPanel from "./HelpPanel";
import PlotPanel from "./PlotPanel";
import ThemeToggle from "./ThemeToggle";
import { useViewerState } from "../lib/state";
import { useUrlSync, type RenderView } from "../lib/url";
import { api } from "../lib/api";
import { nextIdx, prevIdx, nextMember, prevMember } from "../lib/nav";
import { MessageSquare, Database, Star, Scale, Terminal, HelpCircle, Highlighter, Image as ImageIcon, ChevronDown, ChevronUp, LineChart as LineChartIcon, Table as TableIcon, PieChart } from "lucide-react";
import { cn } from "../lib/utils";

export default function Layout() {
  const v = useViewerState();
  const { url, setDrawer } = useUrlSync();
  const [treeWidth, setTreeWidth] = useState(280);
  // Persist per browser/profile (synced cross-browser via the prefs backend).
  const [drawerWidth, setDrawerWidth] = usePref<number>("drawerWidth", 480);
  // The bubble stack can cover sample text on narrow viewports — let the user
  // fold it down to just the expander + theme toggle. Keyboard shortcuts keep
  // working while collapsed.
  const [bubblesCollapsed, setBubblesCollapsed] = usePref<boolean>("bubblesCollapsed", false);
  const drawer = url.drawer;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Modifier-bearing keystrokes belong to the browser / OS (Ctrl+C copy,
      // Cmd+L address bar, Alt+arrow history nav, …) — never hijack them.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const NEXT = ["j", "ArrowDown", "ArrowRight"];
      const PREV = ["k", "ArrowUp", "ArrowLeft"];
      if (NEXT.includes(e.key)) {
        e.preventDefault();
        const target = nextIdx(v.row_idx);
        api.goto(target != null ? target : Math.min(v.row_count - 1, v.row_idx + 1));
      } else if (PREV.includes(e.key)) {
        e.preventDefault();
        const target = prevIdx(v.row_idx);
        api.goto(target != null ? target : Math.max(0, v.row_idx - 1));
      } else if (e.key === "]") {
        // Cycle within the current group (no-op unless group-by is active).
        const t = nextMember(v.row_idx);
        if (t != null) { e.preventDefault(); api.goto(t); }
      } else if (e.key === "[") {
        const t = prevMember(v.row_idx);
        if (t != null) { e.preventDefault(); api.goto(t); }
      } else if (e.key === "s") api.shuffle();
      else if (e.key === "c") {
        const opening = drawer !== "chat";
        setDrawer(opening ? "chat" : "none");
        if (opening) {
          // Focus the textarea once it mounts. 50ms is well past React's
          // commit + the drawer's transition. The selector is scoped to
          // visible textareas (inactive tabs render with `display: none`,
          // so :not([hidden]) lets the active tab win).
          setTimeout(() => {
            document
              .querySelector<HTMLTextAreaElement>("[data-chat-input]")
              ?.focus();
          }, 50);
        }
      }
      else if (e.key === "m") setDrawer(drawer === "marks" ? "none" : "marks");
      else if (e.key === "g") setDrawer(drawer === "judges" ? "none" : "judges");
      else if (e.key === "h") setDrawer(drawer === "highlights" ? "none" : "highlights");
      else if (e.key === "p") setDrawer(drawer === "plots" ? "none" : "plots");
      else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("filter-input")?.focus();
      } else if (e.key === "\\") setDrawer(drawer === "sql" ? "none" : "sql");
      else if (e.key === "?") setDrawer(drawer === "help" ? "none" : "help");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [v.row_idx, v.row_count, drawer, setDrawer]);

  return (
    <div className="flex h-full w-full">
      <aside style={{ width: treeWidth }} className="shrink-0 border-r border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <DatasetTree />
      </aside>
      <div
        className="w-1 cursor-col-resize bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-400 dark:hover:bg-zinc-600"
        onMouseDown={(e) => {
          const start = e.clientX;
          const startW = treeWidth;
          const onMove = (ev: MouseEvent) => setTreeWidth(Math.max(180, Math.min(600, startW + ev.clientX - start)));
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />
      <main className="flex-1 flex flex-col min-w-0">
        <DatasetHeader />
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 overflow-hidden">
            <ViewSwitch />
          </div>
          {drawer !== "none" && (
            <>
              <div
                className="w-1 cursor-col-resize bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-400 dark:hover:bg-zinc-600 shrink-0"
                onMouseDown={(e) => {
                  const start = e.clientX;
                  const startW = drawerWidth;
                  const onMove = (ev: MouseEvent) =>
                    setDrawerWidth(Math.max(280, Math.min(1100, startW - (ev.clientX - start))));
                  const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                  };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
                title="drag to resize"
              />
              <aside
                style={{ width: drawerWidth }}
                className="shrink-0 border-l border-zinc-200 dark:border-zinc-800 overflow-hidden flex flex-col"
              >
                {drawer === "chat" && <ChatDrawer onClose={() => setDrawer("none")} />}
                {drawer === "marks" && <MarkPanel onClose={() => setDrawer("none")} />}
                {drawer === "judges" && <JudgePanel onClose={() => setDrawer("none")} />}
                {drawer === "highlights" && <HighlightsPanel onClose={() => setDrawer("none")} />}
                {drawer === "sql" && <SqlPad onClose={() => setDrawer("none")} />}
                {drawer === "help" && <HelpPanel onClose={() => setDrawer("none")} />}
                {drawer === "plots" && <PlotPanel onClose={() => setDrawer("none")} />}
              </aside>
            </>
          )}
        </div>
      </main>
      <div
        className="fixed bottom-3 flex flex-col gap-2 z-30 transition-[right] duration-150"
        style={{ right: drawer === "none" ? 12 : drawerWidth + 16 }}
      >
        {!bubblesCollapsed && (
          <>
            <DrawerToggle icon={<MessageSquare size={18} />} active={drawer === "chat"} title="Chat (c)" onClick={() => setDrawer(drawer === "chat" ? "none" : "chat")} />
            <DrawerToggle icon={<Star size={18} />} active={drawer === "marks"} title="Marks (m)" onClick={() => setDrawer(drawer === "marks" ? "none" : "marks")} />
            <DrawerToggle icon={<Scale size={18} />} active={drawer === "judges"} title="Judges (g)" onClick={() => setDrawer(drawer === "judges" ? "none" : "judges")} />
            <DrawerToggle icon={<Highlighter size={18} />} active={drawer === "highlights"} title="Highlights (h)" onClick={() => setDrawer(drawer === "highlights" ? "none" : "highlights")} />
            <DrawerToggle icon={<ImageIcon size={18} />} active={drawer === "plots"} title="Plots (p)" onClick={() => setDrawer(drawer === "plots" ? "none" : "plots")} />
            <DrawerToggle icon={<Terminal size={18} />} active={drawer === "sql"} title="SQL (\\)" onClick={() => setDrawer(drawer === "sql" ? "none" : "sql")} />
            <DrawerToggle icon={<HelpCircle size={18} />} active={drawer === "help"} title="Help (?)" onClick={() => setDrawer(drawer === "help" ? "none" : "help")} />
          </>
        )}
        <button
          onClick={() => setBubblesCollapsed(!bubblesCollapsed)}
          title={bubblesCollapsed ? "show panel buttons (shortcuts still work)" : "hide panel buttons"}
          className="w-7 h-7 self-center rounded-full border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-800 transition"
        >
          {bubblesCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <div className="self-center">
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

function DrawerToggle({ icon, active, title, onClick }: {
  icon: React.ReactNode; active: boolean; title: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={"w-10 h-10 rounded-full border flex items-center justify-center transition " +
        (active
          ? "bg-emerald-500 text-zinc-900 border-emerald-400"
          : "bg-zinc-100 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800")}
    >
      {icon}
    </button>
  );
}

function ViewSwitch() {
  const v = useViewerState();
  const { url, setView } = useUrlSync();
  // The render-mode override lives in the URL (`view=`), so it's deep-linkable
  // and survives navigation-driven re-renders. Clearing it on a dataset switch
  // is owned by UrlSyncBridge's mirror (single URL writer — see url.ts).

  if (!v.dataset_path) {
    return (
      <div className="h-full w-full flex items-center justify-center text-zinc-500 text-sm">
        <div className="text-center">
          <Database size={48} className="mx-auto mb-3 opacity-40" />
          <div>Pick a dataset on the left.</div>
          <div className="mt-2 text-xs opacity-70">
            j/k/↑/↓/←/→ navigate · s shuffle · / filter · m marks · g judges · h highlights · p plots · c chat · \\ SQL · ? help
          </div>
        </div>
      </div>
    );
  }
  // SQL view mode (C) overrides the dataset's native view kind.
  if (v.sql_mode === "view") return <SqlView />;

  // The same multi-sample dataset can be rendered several ways. Which are
  // offered depends on shape: a per-sample view always; a table when rows are
  // flat; a plot when there's a numeric `step` axis plus another numeric series;
  // a stats breakdown for anything but markdown. Stats is never the default.
  const canTable = v.tabular;
  const canPlot = v.numeric_cols.includes("step") && v.numeric_cols.length >= 2;
  const canStats = v.view_kind !== "markdown";
  const defaultMode: RenderView =
    v.view_kind === "metrics" ? "plot" : v.view_kind === "table" ? "table" : "samples";

  const modes = (["samples", "table", "plot", "stats"] as RenderView[]).filter(
    (m) =>
      m === "samples" ||
      (m === "table" && canTable) ||
      (m === "plot" && canPlot) ||
      (m === "stats" && canStats),
  );
  // A URL view no longer available (e.g. carried over from a sibling file) falls
  // back to the default — without rewriting the URL, so it re-applies if the
  // dataset later offers it.
  const active: RenderView = url.view && modes.includes(url.view) ? url.view : defaultMode;

  const samples = () => {
    switch (v.view_kind) {
      case "chat": return <ChatRowView />;
      case "eval_log": return <EvalLogView />;
      case "markdown": return <MarkdownView />;
      // "table"/"metrics" kinds, viewed as samples, render per-record cards.
      default: return <JsonTreeView />;
    }
  };

  const render = () =>
    active === "plot" ? <MetricsView />
    : active === "table" ? <TableRowView />
    : active === "stats" ? <StatsView />
    : samples();

  // Only one applicable mode → no toggle, just render it.
  if (modes.length <= 1) return render();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center gap-1 px-3 py-1 border-b border-zinc-200 dark:border-zinc-800">
        {modes.includes("samples") && (
          <ViewToggleButton active={active === "samples"} onClick={() => setView("samples")} icon={<Database size={12} />} label="samples" />
        )}
        {modes.includes("table") && (
          <ViewToggleButton active={active === "table"} onClick={() => setView("table")} icon={<TableIcon size={12} />} label="table" />
        )}
        {modes.includes("plot") && (
          <ViewToggleButton active={active === "plot"} onClick={() => setView("plot")} icon={<LineChartIcon size={12} />} label="plot" />
        )}
        {modes.includes("stats") && (
          <ViewToggleButton active={active === "stats"} onClick={() => setView("stats")} icon={<PieChart size={12} />} label="stats" />
        )}
      </div>
      <div className="flex-1 min-h-0">{render()}</div>
    </div>
  );
}

function ViewToggleButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] uppercase tracking-wide transition-colors",
        active
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
