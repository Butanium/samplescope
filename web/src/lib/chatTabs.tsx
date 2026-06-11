// Multi-tab chat orchestration. Lives at the app root so shift+click handlers
// from anywhere in the UI can dispatch a context-pin into the *active* chat
// tab without prop-drilling.
//
// Each tab corresponds to one /api/chat/sessions/{id} on the backend. A tab's
// own message timeline + busy/readOnly/permission state lives inside the
// <ChatTab> component (kept mounted while hidden so the SSE stream and
// scrollback survive tab switches). The tray lives up here so external
// clicks can append to it.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { usePref } from "./prefs";

export type ContextItem =
  | { id: string; kind: "dataset"; path: string }
  | { id: string; kind: "row"; path: string; idx: number; snapshot?: string }
  | { id: string; kind: "mark"; path: string; idx: number; tags: string[]; note: string }
  | {
      id: string; kind: "judge_result";
      path: string; idx: number; preset: string; score: number | null; reasoning?: string | null;
    }
  | { id: string; kind: "eval_sample"; path: string; idx: number };

type DistributedOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export type Tab = {
  id: string;                // matches the live session id from POST /api/chat/sessions
  label?: string;
  createdAt: number;
};

type Ctx = {
  tabs: Tab[];
  activeTabId: string | null;
  trays: Record<string, ContextItem[]>;
  addTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  switchTo: (id: string) => void;
  setLabel: (id: string, label: string) => void;
  /** Append to active tab. Drawer auto-opens if not already on `chat`. */
  addToActiveContext: (item: DistributedOmit<ContextItem, "id">, openDrawer?: () => void) => void;
  removeContextItem: (tabId: string, itemId: string) => void;
  clearTray: (tabId: string) => void;
};

const ChatTabsContext = createContext<Ctx | null>(null);

let _seq = 0;
const newItemId = () => `c${Date.now().toString(36)}-${(_seq++).toString(36)}`;

/** Persisted shape per tab — what we need to rehydrate it on reload. The
 *  full `Tab` shape (label + createdAt) is reconstructed by ChatTab itself
 *  from the backend's session history; here we only need the id list. */
type StoredTab = { id: string; label?: string };

export function ChatTabsProvider({ children }: { children: ReactNode }) {
  // Cross-browser persistent list of open tabs. Stores just the id (+ a
  // cached label so the strip shows readable text before the first SSE
  // message lands). Rehydrated on mount from localStorage + backend via
  // the usePref hook.
  const [storedTabs, setStoredTabs] = usePref<StoredTab[]>("chatOpenTabs", []);
  const [storedActiveId, setStoredActiveId] = usePref<string | null>("chatActiveTab", null);

  const [tabs, setTabs] = useState<Tab[]>(() =>
    storedTabs.map((s) => ({ id: s.id, label: s.label, createdAt: 0 })),
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(storedActiveId);
  const [trays, setTrays] = useState<Record<string, ContextItem[]>>({});

  // Push tab-state changes back to disk. Debounced via the pref layer.
  // Skip the very first render so we don't overwrite the just-restored
  // value with the same content (harmless but wastes a network round-trip).
  const initRef = useRef(true);
  useEffect(() => {
    if (initRef.current) { initRef.current = false; return; }
    setStoredTabs(tabs.map((t) => ({ id: t.id, label: t.label })));
  // setStoredTabs is stable via usePref; we intentionally watch only `tabs`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);
  useEffect(() => {
    setStoredActiveId(activeTabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  const addTab = useCallback((tab: Tab) => {
    setTabs((prev) => (prev.find((t) => t.id === tab.id) ? prev : [...prev, tab]));
    setActiveTabId(tab.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur));
      return next;
    });
    setTrays((prev) => {
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  const switchTo = useCallback((id: string) => setActiveTabId(id), []);

  const setLabel = useCallback((id: string, label: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
  }, []);

  const addToActiveContext = useCallback((
    item: Omit<ContextItem, "id">,
    openDrawer?: () => void,
  ) => {
    setActiveTabId((cur) => {
      if (!cur) {
        // No tab yet — caller should open the drawer; the chat drawer creates
        // a tab on first mount and we pin once it exists.
        openDrawer?.();
        return cur;
      }
      setTrays((prev) => {
        const list = prev[cur] ?? [];
        const full = { ...item, id: newItemId() } as ContextItem;
        // Dedupe: same kind+path+idx replaces the prior entry instead of stacking.
        const dedup = list.filter((x) => !sameRef(x, full));
        return { ...prev, [cur]: [...dedup, full] };
      });
      openDrawer?.();
      return cur;
    });
  }, []);

  const removeContextItem = useCallback((tabId: string, itemId: string) => {
    setTrays((prev) => ({
      ...prev,
      [tabId]: (prev[tabId] ?? []).filter((x) => x.id !== itemId),
    }));
  }, []);

  const clearTray = useCallback((tabId: string) => {
    setTrays((prev) => ({ ...prev, [tabId]: [] }));
  }, []);

  const value = useMemo<Ctx>(
    () => ({ tabs, activeTabId, trays, addTab, closeTab, switchTo, setLabel,
             addToActiveContext, removeContextItem, clearTray }),
    [tabs, activeTabId, trays, addTab, closeTab, switchTo, setLabel,
     addToActiveContext, removeContextItem, clearTray],
  );

  return <ChatTabsContext.Provider value={value}>{children}</ChatTabsContext.Provider>;
}

function sameRef(a: ContextItem, b: ContextItem): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "dataset" && b.kind === "dataset") return a.path === b.path;
  if (a.kind === "row" && b.kind === "row") return a.path === b.path && a.idx === b.idx;
  if (a.kind === "mark" && b.kind === "mark") return a.path === b.path && a.idx === b.idx;
  if (a.kind === "eval_sample" && b.kind === "eval_sample") return a.path === b.path && a.idx === b.idx;
  if (a.kind === "judge_result" && b.kind === "judge_result")
    return a.path === b.path && a.idx === b.idx && a.preset === b.preset;
  return false;
}

export function useChatTabs() {
  const v = useContext(ChatTabsContext);
  if (!v) throw new Error("useChatTabs outside provider");
  return v;
}

/** Format the active tray as a single XML-ish block to prepend to a message. */
export function serializeTray(items: ContextItem[]): string {
  if (items.length === 0) return "";
  const parts: string[] = ["<context>"];
  for (const it of items) {
    if (it.kind === "dataset") {
      parts.push(`  <dataset path="${esc(it.path)}" />`);
    } else if (it.kind === "row") {
      const inner = it.snapshot ? `\n${indent(it.snapshot, 4)}\n  ` : "";
      parts.push(`  <row path="${esc(it.path)}" idx="${it.idx}">${inner}</row>`);
    } else if (it.kind === "mark") {
      parts.push(`  <mark path="${esc(it.path)}" idx="${it.idx}" tags="${esc(it.tags.join(","))}" note="${esc(it.note)}" />`);
    } else if (it.kind === "judge_result") {
      const reasoning = it.reasoning ? `\n    <reasoning>${esc(it.reasoning)}</reasoning>\n  ` : "";
      parts.push(`  <judge_result preset="${esc(it.preset)}" path="${esc(it.path)}" idx="${it.idx}" score="${it.score ?? ""}">${reasoning}</judge_result>`);
    } else if (it.kind === "eval_sample") {
      parts.push(`  <eval_sample path="${esc(it.path)}" idx="${it.idx}" />`);
    }
  }
  parts.push("</context>");
  return parts.join("\n");
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;");
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => pad + l).join("\n");
}

export function shortLabel(item: ContextItem): string {
  if (item.kind === "dataset") return item.path.split("/").pop() ?? item.path;
  if (item.kind === "row") return `row ${item.idx}`;
  if (item.kind === "mark") return `★ ${item.idx}${item.tags[0] ? ` ${item.tags[0]}` : ""}`;
  if (item.kind === "eval_sample") return `sample #${item.idx}`;
  if (item.kind === "judge_result") return `${item.preset}=${item.score ?? "—"} #${item.idx}`;
  return "?";
}
