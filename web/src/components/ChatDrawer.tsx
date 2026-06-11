import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useChatTabs } from "../lib/chatTabs";
import { PanelHeader } from "./MarkPanel";
import ChatTab from "./ChatTab";
import TabContextMenu, { type ContextMenuAnchor } from "./ui/TabContextMenu";
import { History, Plus, X } from "lucide-react";
import { cn, truncate } from "../lib/utils";

/**
 * Drawer chrome for multiple Claude-Code chat tabs.
 *
 * State distribution:
 * - List of tabs + active id live in `useChatTabs()` (app-root provider) so
 *   shift-click pins from anywhere route to the active tab.
 * - Per-tab message timeline / draft / busy lives inside <ChatTab>; tabs are
 *   kept mounted when inactive so SSE keeps streaming and switching is
 *   instant.
 * - Sessions persist on the backend across reloads — clicking one in the
 *   history list opens it as a (read-only) tab.
 */
export default function ChatDrawer({ onClose }: { onClose: () => void }) {
  const { tabs, activeTabId, addTab, closeTab, switchTo } = useChatTabs();
  const [historyOpen, setHistoryOpen] = useState(false);
  // Track sessions opened from the history list that the SDK couldn't resume
  // (no captured `sdk_session_id`, e.g. pre-dating the column). Those tabs
  // stay read-only; everything else is fully interactive.
  const [unresumable, setUnresumable] = useState<Set<string>>(new Set());
  const initRef = useRef(false);

  // First mount:
  //   - If we restored tabs from disk: re-attach each one server-side so the
  //     SDK clients exist by the time the user sends. SSE inside ChatTab
  //     opens after we've done this (mount races are handled by send's
  //     404-retry path as a safety net).
  //   - If we restored nothing: spin a fresh tab so the user never sees an
  //     empty drawer.
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    (async () => {
      if (tabs.length === 0) {
        const s = await api.createSession();
        addTab({ id: s.session_id, createdAt: Date.now() });
      } else {
        // Best-effort silent re-attach for each restored tab. Failures
        // bubble up at send time as unresumable; that's the only spot we
        // need to flag for the UI.
        await Promise.all(tabs.map(async (t) => {
          try {
            const r = await api.resumeSession(t.id);
            if (!r.resumed) setUnresumable((p) => new Set(p).add(t.id));
          } catch {
            setUnresumable((p) => new Set(p).add(t.id));
          }
        }));
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function newTab() {
    const s = await api.createSession();
    addTab({ id: s.session_id, createdAt: Date.now() });
  }

  const [resuming, setResuming] = useState<string | null>(null);
  const [menu, setMenu] = useState<(ContextMenuAnchor & { id: string }) | null>(null);

  async function openHistorical(id: string) {
    if (tabs.find((t) => t.id === id)) {
      switchTo(id);
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(false);
    setResuming(id);
    // Resolve resumability BEFORE mounting the tab. Mounting too early lets
    // ChatTab open SSE / accept sends against a session that isn't live yet
    // (the server then 404s). The await is typically ~1s; the strip shows a
    // "resuming…" placeholder during that window.
    let resumed = false;
    try {
      const r = await api.resumeSession(id);
      resumed = r.resumed;
    } catch {
      resumed = false;
    }
    if (!resumed) {
      setUnresumable((prev) => new Set(prev).add(id));
    }
    setResuming(null);
    addTab({ id, createdAt: Date.now() });
  }

  async function handleClose(id: string) {
    closeTab(id);
    // Closing the tab also tears down the live SDK client. Old sessions stay
    // persisted in DuckDB and can be reopened from history again.
    api.closeSession(id).catch(() => {});
  }

  return (
    <>
      <PanelHeader title="claude code" onClose={onClose}>
        <button
          onClick={() => setHistoryOpen(!historyOpen)}
          title="session history"
          className={cn(
            "ml-auto text-[10px] p-1 rounded",
            historyOpen ? "bg-emerald-500/30 text-emerald-700 dark:text-emerald-300"
              : "bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700",
          )}
        >
          <History size={12} />
        </button>
      </PanelHeader>

      {historyOpen && (
        <SessionList activeId={activeTabId} openTabIds={tabs.map((t) => t.id)} onPick={openHistorical} />
      )}

      <TabStrip
        tabs={tabs}
        activeId={activeTabId}
        onSelect={switchTo}
        onClose={handleClose}
        onNew={newTab}
        onContextMenu={(e, id) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, id });
        }}
      />

      {menu && (
        <TabContextMenu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: "Close", run: () => handleClose(menu.id) },
            {
              label: "Close others",
              run: () => {
                tabs.filter((t) => t.id !== menu.id).forEach((t) => handleClose(t.id));
              },
              disabled: tabs.length <= 1,
            },
            {
              label: "Close all",
              run: () => tabs.forEach((t) => handleClose(t.id)),
              disabled: tabs.length === 0,
            },
          ]}
        />
      )}

      {resuming && (
        <div className="px-3 py-2 text-[11px] text-zinc-500 border-b border-zinc-200 dark:border-zinc-800 animate-pulse">
          resuming session <code className="font-mono">{resuming.slice(0, 8)}</code>…
        </div>
      )}

      {tabs.length === 0 && !resuming ? (
        <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">
          starting session…
        </div>
      ) : tabs.length === 0 ? null : (
        tabs.map((t) => (
          <ChatTab
            key={t.id}
            id={t.id}
            active={t.id === activeTabId}
            readOnlyHistorical={unresumable.has(t.id)}
          />
        ))
      )}
    </>
  );
}

function TabStrip({
  tabs, activeId, onSelect, onClose, onNew, onContextMenu,
}: {
  tabs: { id: string; label?: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
}) {
  return (
    <div className="flex items-stretch border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto">
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            onContextMenu={(e) => onContextMenu?.(e, t.id)}
            className={cn(
              "group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 text-[11px] border-r border-zinc-200 dark:border-zinc-800 max-w-[180px]",
              active
                ? "bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 border-b-2 border-b-emerald-500 -mb-px"
                : "bg-zinc-100/60 dark:bg-zinc-900/60 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
            )}
            title={`${t.id} — right-click for more`}
          >
            <span className="truncate">{t.label || `tab ${t.id.slice(0, 6)}`}</span>
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
      <button
        onClick={onNew}
        title="new tab"
        className="px-2 py-1.5 text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

function SessionList({
  activeId, openTabIds, onPick,
}: {
  activeId: string | null;
  openTabIds: string[];
  onPick: (sid: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ["chat-sessions"],
    queryFn: () => api.listSessions(),
    refetchInterval: 5000,
  });
  return (
    <div className="border-b border-zinc-200 dark:border-zinc-800 max-h-60 overflow-y-auto text-xs">
      {!data || data.length === 0 ? (
        <div className="p-2 text-zinc-500">no sessions yet</div>
      ) : data.map((s) => (
        <button
          key={s.id}
          onClick={() => onPick(s.id)}
          className={cn(
            "w-full text-left px-3 py-1.5 border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-900 flex items-center gap-2 font-mono",
            activeId === s.id && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          )}
        >
          <span className={cn("w-1.5 h-1.5 rounded-full", s.live ? "bg-emerald-500" : "bg-zinc-500")} />
          <span className="truncate">{truncate(s.label || s.id, 30)}</span>
          {openTabIds.includes(s.id) && (
            <span className="ml-auto text-[10px] text-emerald-600 dark:text-emerald-400">open</span>
          )}
          <span className={cn("text-[10px] text-zinc-500", openTabIds.includes(s.id) ? "ml-2" : "ml-auto")}>
            {s.created_at.slice(5, 16).replace("T", " ")}
          </span>
        </button>
      ))}
    </div>
  );
}
