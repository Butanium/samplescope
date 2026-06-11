import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useViewerState } from "../lib/state";
import { usePref } from "../lib/prefs";
import { fmtBytes, cn } from "../lib/utils";
import type { DatasetEntry } from "../lib/types";
import { ChevronRight, ChevronDown, FileText, FileBox, FileJson, FileCode, FileSpreadsheet, Image as ImageIcon, FileType } from "lucide-react";
import { usePinHandler } from "../lib/pin";
import { useUrlSync } from "../lib/url";

type Node = { name: string; path: string; children: Map<string, Node>; files: DatasetEntry[] };

function buildTree(entries: DatasetEntry[]): Node {
  const root: Node = { name: "", path: "", children: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.parent.split("/").filter(Boolean);
    let cur = root;
    for (const part of parts) {
      let next = cur.children.get(part);
      if (!next) {
        next = {
          name: part,
          path: cur.path ? `${cur.path}/${part}` : part,
          children: new Map(),
          files: [],
        };
        cur.children.set(part, next);
      }
      cur = next;
    }
    cur.files.push(e);
  }
  return root;
}

export default function DatasetTree() {
  const v = useViewerState();
  const [filter, setFilter] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["datasets"],
    queryFn: () => api.listDatasets(),
    staleTime: 30_000,
  });

  // Persisted per-folder open/closed map. Absence means "use the depth-based
  // default" (depth<2 starts open) so first-time users see a sensible tree
  // without us pre-seeding entries for every directory.
  const [openMap, setOpenMap] = usePref<Record<string, boolean>>("tree.openFolders", {});
  const isOpen = useCallback(
    (path: string, depth: number) => {
      const saved = openMap[path];
      return saved == null ? depth < 2 : saved;
    },
    [openMap],
  );
  const toggle = useCallback(
    (path: string, depth: number) => {
      const current = openMap[path];
      const next = current == null ? !(depth < 2) : !current;
      setOpenMap({ ...openMap, [path]: next });
    },
    [openMap, setOpenMap],
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!filter) return data;
    const f = filter.toLowerCase();
    return data.filter((d) => d.path.toLowerCase().includes(f));
  }, [data, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="text-xs text-zinc-500 mb-1 uppercase tracking-wide">datasets</div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded text-xs outline-none focus:border-emerald-600"
        />
        {data && (
          <div className="text-[11px] text-zinc-400 dark:text-zinc-600 mt-1">
            {filtered.length} / {data.length} files
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-2 text-sm">
        {isLoading && <div className="text-zinc-500 text-xs px-2">loading…</div>}
        {error && <div className="text-red-400 text-xs px-2">{String(error)}</div>}
        {!isLoading && !error && (
          <TreeNode node={tree} depth={0} activePath={v.dataset_path} isOpen={isOpen} toggle={toggle} />
        )}
      </div>
    </div>
  );
}

interface TreeNodeProps {
  node: Node;
  depth: number;
  activePath: string | null;
  isOpen: (path: string, depth: number) => boolean;
  toggle: (path: string, depth: number) => void;
}

function TreeNode({ node, depth, activePath, isOpen, toggle }: TreeNodeProps) {
  const hasContent = node.children.size > 0 || node.files.length > 0;
  if (!hasContent) return null;
  if (!node.name) {
    return (
      <div>
        {[...node.children.values()].map((c) => (
          <TreeNode key={c.path} node={c} depth={depth} activePath={activePath} isOpen={isOpen} toggle={toggle} />
        ))}
        {node.files.map((f) => (
          <FileRow key={f.path} entry={f} depth={depth} active={activePath === f.path} />
        ))}
      </div>
    );
  }
  const open = isOpen(node.path, depth);
  return (
    <div>
      <button
        onClick={() => toggle(node.path, depth)}
        className="flex items-center gap-1 px-1 py-0.5 hover:bg-white dark:bg-zinc-900 w-full text-left text-zinc-700 dark:text-zinc-300"
        style={{ paddingLeft: depth * 10 + 4 }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="truncate">{node.name}</span>
      </button>
      {open && (
        <>
          {[...node.children.values()].map((c) => (
            <TreeNode key={c.path} node={c} depth={depth + 1} activePath={activePath} isOpen={isOpen} toggle={toggle} />
          ))}
          {node.files.map((f) => (
            <FileRow key={f.path} entry={f} depth={depth + 1} active={activePath === f.path} />
          ))}
        </>
      )}
    </div>
  );
}

function FileRow({ entry, depth, active }: { entry: DatasetEntry; depth: number; active: boolean }) {
  const Icon =
    entry.kind === "eval" ? FileBox
    : entry.kind === "json" ? FileJson
    : entry.kind === "jsonl" ? FileText
    : entry.kind === "csv" ? FileSpreadsheet
    : entry.kind === "image" ? ImageIcon
    : entry.kind === "pdf" ? FileType
    : FileCode;
  const pin = usePinHandler();
  const { setDrawer } = useUrlSync();
  const isPlot = entry.kind === "image" || entry.kind === "pdf";
  return (
    <button
      onClick={(e) => {
        if (pin(e, { kind: "dataset", path: entry.path })) return;
        if (isPlot) {
          // Add (or focus, server-side dedupe) the tab and reveal the panel.
          api.addPlot({
            kind: entry.kind as "image" | "pdf",
            source_path: entry.path,
            title: entry.name,
          });
          setDrawer("plots");
          return;
        }
        api.openDataset(entry.path);
      }}
      title={`${entry.path}${isPlot ? " — opens in plot panel" : " — shift+click to pin"}`}
      style={{ paddingLeft: depth * 10 + 18 }}
      className={cn(
        "flex items-center gap-2 px-1 py-0.5 hover:bg-white dark:bg-zinc-900 w-full text-left text-sm",
        active && "bg-emerald-900/40 text-emerald-300",
      )}
    >
      <Icon size={12} className="shrink-0 opacity-70" />
      <span className="truncate flex-1">{entry.name}</span>
      <span className="text-[10px] text-zinc-400 dark:text-zinc-600 ml-auto shrink-0">{fmtBytes(entry.size_bytes)}</span>
    </button>
  );
}
