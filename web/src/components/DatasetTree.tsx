import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useViewerState } from "../lib/state";
import { usePref } from "../lib/prefs";
import { fmtBytes, cn, copyToClipboard, joinPath } from "../lib/utils";
import type { DatasetEntry } from "../lib/types";
import { ChevronRight, ChevronDown, FileText, FileBox, FileJson, FileCode, FileSpreadsheet, Image as ImageIcon, FileType, BookText, Plus, X, EyeOff, RefreshCw } from "lucide-react";
import { usePinHandler } from "../lib/pin";
import { useUrlSync } from "../lib/url";
import TabContextMenu from "./ui/TabContextMenu";

type FileMenu = { x: number; y: number; entry: DatasetEntry };
type FileContextHandler = (pos: { x: number; y: number }, entry: DatasetEntry) => void;

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
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["datasets"],
    queryFn: () => api.listDatasets(),
    staleTime: 30_000,
  });

  // Ignore list: regex patterns matched against each file's path, with a master
  // on/off toggle. Persisted like the rest of the tree state so it survives
  // restarts and follows the user across browsers.
  const [ignoreEnabled, setIgnoreEnabled] = usePref<boolean>("tree.ignoreEnabled", true);
  const [ignorePatterns, setIgnorePatterns] = usePref<string[]>("tree.ignorePatterns", []);
  const [ignoreOpen, setIgnoreOpen] = usePref<boolean>("tree.ignoreOpen", false);
  const [draft, setDraft] = useState("");

  // `.md`/`.markdown` files are served by the backend but hidden from the tree
  // by default (research repos are full of READMEs / CLAUDE.md noise). The
  // toggle next to the refresh button flips this; persisted like the rest.
  const [showMarkdown, setShowMarkdown] = usePref<boolean>("tree.showMarkdown", false);

  // Compile each pattern once; an invalid regex is surfaced in the editor (red
  // border + the engine's message) and skipped when filtering rather than
  // breaking the whole tree.
  const compiled = useMemo(
    () =>
      ignorePatterns.map((p) => {
        try {
          return { pattern: p, re: p ? new RegExp(p) : null, error: null as string | null };
        } catch (e) {
          return { pattern: p, re: null, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    [ignorePatterns],
  );

  const addPattern = useCallback(() => {
    const t = draft.trim();
    setDraft("");
    if (!t || ignorePatterns.includes(t)) return;
    setIgnorePatterns([...ignorePatterns, t]);
  }, [draft, ignorePatterns, setIgnorePatterns]);
  const editPattern = useCallback(
    (i: number, val: string) => setIgnorePatterns(ignorePatterns.map((p, j) => (j === i ? val : p))),
    [ignorePatterns, setIgnorePatterns],
  );
  const removePattern = useCallback(
    (i: number) => setIgnorePatterns(ignorePatterns.filter((_, j) => j !== i)),
    [ignorePatterns, setIgnorePatterns],
  );

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

  const { filtered, ignoredCount } = useMemo(() => {
    if (!data) return { filtered: [] as DatasetEntry[], ignoredCount: 0 };
    const f = filter.toLowerCase();
    let textPass = f ? data.filter((d) => d.path.toLowerCase().includes(f)) : data;
    if (!showMarkdown) textPass = textPass.filter((d) => d.kind !== "markdown");
    const res = ignoreEnabled ? (compiled.map((c) => c.re).filter(Boolean) as RegExp[]) : [];
    if (res.length === 0) return { filtered: textPass, ignoredCount: 0 };
    const kept = textPass.filter((d) => !res.some((re) => re.test(d.path)));
    return { filtered: kept, ignoredCount: textPass.length - kept.length };
  }, [data, filter, ignoreEnabled, compiled, showMarkdown]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  // Auto-rescan when the filter text matches nothing in the cached list: the
  // user likely pasted a path to a file created since the last scan. Debounced,
  // gated on the *text* hit (not the ignore/markdown-filtered result — a
  // re-scan can't reveal a present-but-ignored file), and fired at most once
  // per distinct query so a genuinely-absent path doesn't spin the backend.
  const lastAutoRefetched = useRef<string | null>(null);
  useEffect(() => {
    const f = filter.trim().toLowerCase();
    if (!f || !data || isFetching) return;
    if (data.some((d) => d.path.toLowerCase().includes(f))) {
      lastAutoRefetched.current = null; // matched → re-arm for a future miss
      return;
    }
    if (lastAutoRefetched.current === f) return; // already rescanned for this, still nothing
    const t = setTimeout(() => {
      lastAutoRefetched.current = f;
      refetch();
    }, 350);
    return () => clearTimeout(t);
  }, [filter, data, isFetching, refetch]);

  // Server root, for resolving absolute paths in the right-click menu.
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: Infinity });
  const [menu, setMenu] = useState<FileMenu | null>(null);
  const onFileContext = useCallback<FileContextHandler>(
    (pos, entry) => setMenu({ x: pos.x, y: pos.y, entry }),
    [],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs text-zinc-500 uppercase tracking-wide">datasets</div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowMarkdown(!showMarkdown)}
              title={showMarkdown ? "hide .md files" : "show .md files"}
              className={cn(
                "p-0.5 rounded hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60",
                showMarkdown
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200",
              )}
            >
              <BookText size={12} />
            </button>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              title="refresh file list"
              className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 disabled:opacity-60"
            >
              <RefreshCw size={12} className={cn(isFetching && "animate-spin")} />
            </button>
          </div>
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded text-xs outline-none focus:border-emerald-600"
        />
        {data && (
          <div className="text-[11px] text-zinc-400 dark:text-zinc-600 mt-1">
            {filtered.length} / {data.length} files
            {ignoreEnabled && ignoredCount > 0 && ` · ${ignoredCount} ignored`}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-2 text-sm">
        {isLoading && <div className="text-zinc-500 text-xs px-2">loading…</div>}
        {error && <div className="text-red-400 text-xs px-2">{String(error)}</div>}
        {!isLoading && !error && filter.trim() && filtered.length === 0 && (
          <div className="text-zinc-500 text-xs px-2 py-1">
            {isFetching ? "rescanning…" : "no match"}
          </div>
        )}
        {!isLoading && !error && (
          <TreeNode node={tree} depth={0} activePath={v.dataset_path} isOpen={isOpen} toggle={toggle} onFileContext={onFileContext} />
        )}
      </div>
      <div className="border-t border-zinc-200 dark:border-zinc-800 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <label
            className="flex items-center gap-1.5 cursor-pointer select-none shrink-0"
            title={ignoreEnabled ? "ignore list is on — uncheck to show everything" : "ignore list is off"}
          >
            <input
              type="checkbox"
              checked={ignoreEnabled}
              onChange={(e) => setIgnoreEnabled(e.target.checked)}
              className="accent-emerald-600"
            />
            <EyeOff size={12} className="opacity-70" />
          </label>
          <button
            onClick={() => setIgnoreOpen(!ignoreOpen)}
            className="flex-1 flex items-center gap-1 text-left text-zinc-500 uppercase tracking-wide hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            {ignoreOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>ignore</span>
            <span className="ml-auto normal-case tracking-normal text-[11px] text-zinc-400 dark:text-zinc-600">
              {ignorePatterns.length === 0
                ? "no patterns"
                : !ignoreEnabled
                  ? `${ignorePatterns.length} off`
                  : `${ignoredCount} hidden`}
            </span>
          </button>
        </div>
        {ignoreOpen && (
          <div className="mt-2 space-y-1">
            {compiled.map((c, i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  value={c.pattern}
                  onChange={(e) => editPattern(i, e.target.value)}
                  spellCheck={false}
                  title={c.error ?? "regex matched against the full file path"}
                  className={cn(
                    "flex-1 min-w-0 px-1.5 py-0.5 bg-white dark:bg-zinc-900 border rounded text-xs outline-none font-mono",
                    c.error
                      ? "border-red-500 text-red-500"
                      : "border-zinc-200 dark:border-zinc-800 focus:border-emerald-600",
                  )}
                />
                <button
                  onClick={() => removePattern(i)}
                  title="remove pattern"
                  className="shrink-0 p-1 text-zinc-400 hover:text-red-500"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-1">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPattern();
                }}
                placeholder="add regex pattern…"
                spellCheck={false}
                className="flex-1 min-w-0 px-1.5 py-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded text-xs outline-none focus:border-emerald-600 font-mono"
              />
              <button
                onClick={addPattern}
                title="add pattern"
                className="shrink-0 p-1 text-zinc-400 hover:text-emerald-500"
              >
                <Plus size={12} />
              </button>
            </div>
            <div className="text-[10px] text-zinc-400 dark:text-zinc-600">
              regex matched against each file's path; matches are hidden from the tree
            </div>
          </div>
        )}
      </div>
      {menu && (
        <TabContextMenu
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={[
            { label: "copy relative path", run: () => copyToClipboard(menu.entry.path) },
            {
              label: "copy absolute path",
              run: () => { if (health?.root) copyToClipboard(joinPath(health.root, menu.entry.path)); },
              disabled: !health?.root,
            },
          ]}
        />
      )}
    </div>
  );
}

interface TreeNodeProps {
  node: Node;
  depth: number;
  activePath: string | null;
  isOpen: (path: string, depth: number) => boolean;
  toggle: (path: string, depth: number) => void;
  onFileContext: FileContextHandler;
}

function TreeNode({ node, depth, activePath, isOpen, toggle, onFileContext }: TreeNodeProps) {
  const hasContent = node.children.size > 0 || node.files.length > 0;
  if (!hasContent) return null;
  if (!node.name) {
    return (
      <div>
        {[...node.children.values()].map((c) => (
          <TreeNode key={c.path} node={c} depth={depth} activePath={activePath} isOpen={isOpen} toggle={toggle} onFileContext={onFileContext} />
        ))}
        {node.files.map((f) => (
          <FileRow key={f.path} entry={f} depth={depth} active={activePath === f.path} onContext={onFileContext} />
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
            <TreeNode key={c.path} node={c} depth={depth + 1} activePath={activePath} isOpen={isOpen} toggle={toggle} onFileContext={onFileContext} />
          ))}
          {node.files.map((f) => (
            <FileRow key={f.path} entry={f} depth={depth + 1} active={activePath === f.path} onContext={onFileContext} />
          ))}
        </>
      )}
    </div>
  );
}

function FileRow({ entry, depth, active, onContext }: { entry: DatasetEntry; depth: number; active: boolean; onContext: FileContextHandler }) {
  const Icon =
    entry.kind === "eval" ? FileBox
    : entry.kind === "json" ? FileJson
    : entry.kind === "jsonl" ? FileText
    : entry.kind === "markdown" ? BookText
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
      onContextMenu={(e) => {
        e.preventDefault();
        onContext({ x: e.clientX, y: e.clientY }, entry);
      }}
      title={`${entry.path}${isPlot ? " — opens in plot panel" : " — shift+click to pin"} — right-click to copy path`}
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
