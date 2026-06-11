import { useEffect, useRef, useState } from "react";
import Plot from "react-plotly.js";
import { api, sse } from "../lib/api";
import type { PlotTab } from "../lib/types";
import { PanelHeader } from "./MarkPanel";
import TabContextMenu, { type ContextMenuAnchor } from "./ui/TabContextMenu";
import { cn, truncate } from "../lib/utils";
import { X, Plus } from "lucide-react";

/**
 * Persistent gallery of images / PDFs / plotly figures. Tabs are
 * server-stored (see api/routes/plots.py) and pushed live over SSE so
 * `viewer plot add ...` from a chat session pops the new tab into the
 * already-open panel without a refresh.
 */
export default function PlotPanel({ onClose }: { onClose: () => void }) {
  const [tabs, setTabs] = useState<PlotTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menu, setMenu] = useState<(ContextMenuAnchor & { id: string }) | null>(null);

  // SSE subscription: backend pushes the full ordered tab list on every change.
  useEffect(() => {
    api.listPlots().then(setTabs);
    const unsub = sse("/api/plots/events", (event, data) => {
      if (event === "tabs" && Array.isArray(data?.tabs)) {
        setTabs(data.tabs);
      }
    });
    return () => unsub();
  }, []);

  // Keep activeId valid: if the active tab disappears, pick the last one.
  useEffect(() => {
    if (tabs.length === 0) { setActiveId(null); return; }
    if (!activeId || !tabs.find((t) => t.id === activeId)) {
      setActiveId(tabs[tabs.length - 1].id);
    }
  }, [tabs, activeId]);

  const active = tabs.find((t) => t.id === activeId) ?? null;

  return (
    <>
      <PanelHeader title="plots" onClose={onClose} />

      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onContextMenu={(e, id) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, id });
        }}
        onClose={(id) => api.deletePlot(id)}
      />

      <div className="flex-1 min-h-0 overflow-hidden bg-zinc-50 dark:bg-zinc-950">
        {active ? <TabBody tab={active} /> : (
          <div className="h-full flex items-center justify-center text-zinc-500 text-xs p-4 text-center">
            No plots yet.<br />
            Click a <code>.png</code> / <code>.pdf</code> in the tree, or have Claude run
            <code className="ml-1">viewer plot add</code>.
          </div>
        )}
      </div>

      {menu && (
        <TabContextMenu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: "Close", run: () => api.deletePlot(menu.id) },
            {
              label: "Close others",
              run: () => api.closePlots({ mode: "others", keep: menu.id }),
              disabled: tabs.length <= 1,
            },
            { label: "Close all", run: () => api.closePlots({ mode: "all" }) },
          ]}
        />
      )}
    </>
  );
}

function TabStrip({
  tabs, activeId, onSelect, onContextMenu, onClose,
}: {
  tabs: PlotTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <div className="flex items-stretch border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => onContextMenu(e, t.id)}
            title={`${t.kind} · ${t.source_path ?? t.title ?? t.id} (right-click for more)`}
            className={cn(
              "group flex items-center gap-1.5 pl-2.5 pr-1 py-1.5 text-[11px] border-r border-zinc-200 dark:border-zinc-800 max-w-[200px]",
              active
                ? "bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 border-b-2 border-b-emerald-500 -mb-px"
                : "bg-zinc-100/60 dark:bg-zinc-900/60 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
            )}
          >
            <KindBadge kind={t.kind} />
            <span className="truncate">{tabLabel(t)}</span>
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              className="opacity-30 group-hover:opacity-100 hover:bg-zinc-300 dark:hover:bg-zinc-700 rounded p-0.5 cursor-pointer"
            >
              <X size={10} />
            </span>
          </button>
        );
      })}
      {tabs.length === 0 && (
        <div className="px-3 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-600 flex items-center gap-1">
          <Plus size={12} /> click an image / PDF in the tree
        </div>
      )}
    </div>
  );
}


function TabBody({ tab }: { tab: PlotTab }) {
  if (tab.kind === "image" && tab.source_path) {
    return (
      <div className="h-full w-full overflow-auto flex items-start justify-center p-3 bg-white dark:bg-zinc-900">
        <img
          src={api.fileUrl(tab.source_path)}
          alt={tab.title || tab.source_path}
          className="max-w-full h-auto"
        />
      </div>
    );
  }
  if (tab.kind === "pdf" && tab.source_path) {
    return (
      <embed
        src={api.fileUrl(tab.source_path)}
        type="application/pdf"
        className="w-full h-full"
      />
    );
  }
  if (tab.kind === "plotly" && tab.payload) {
    return <PlotlyTab figure={tab.payload} />;
  }
  return <div className="p-4 text-xs text-red-500">Unknown / malformed tab.</div>;
}

function PlotlyTab({ figure }: { figure: any }) {
  // react-plotly expects { data, layout, config }. Accept a couple of common
  // shapes: a full figure dict, or {data, layout} at top level.
  const data = figure?.data ?? [];
  const layout = { autosize: true, ...(figure?.layout ?? {}) };
  const config = { responsive: true, ...(figure?.config ?? {}) };
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} className="h-full w-full">
      <Plot
        data={data}
        layout={layout}
        config={config}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler
      />
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const colors: Record<string, string> = {
    image: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    pdf: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
    plotly: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  };
  const label: Record<string, string> = { image: "img", pdf: "pdf", plotly: "ply" };
  return (
    <span className={cn("text-[9px] px-1 rounded font-mono uppercase shrink-0", colors[kind] || "bg-zinc-500/15")}>
      {label[kind] ?? kind}
    </span>
  );
}

function tabLabel(t: PlotTab): string {
  if (t.title) return t.title;
  if (t.source_path) return t.source_path.split("/").pop() || t.source_path;
  return `plot ${t.id.slice(0, 6)}`;
}
