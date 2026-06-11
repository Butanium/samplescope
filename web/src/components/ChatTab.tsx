import { useEffect, useRef, useState, useCallback } from "react";
import { api, sse } from "../lib/api";
import type { ChatBlock, ChatMessage } from "../lib/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Send, Wrench, Bot, User, AlertCircle, CheckCircle2, Lock, Unlock, ShieldAlert, Square } from "lucide-react";
import { cn, truncate } from "../lib/utils";
import { useViewerState } from "../lib/state";
import { useChatTabs, serializeTray } from "../lib/chatTabs";
import { usePref } from "../lib/prefs";
import ContextTray from "./ContextTray";

type DisplayMessage =
  | { kind: "user"; text: string }
  | { kind: "assistant"; blocks: ChatBlock[]; model: string }
  | { kind: "result"; cost: number | null; turns: number; ms: number; isError: boolean }
  | { kind: "error"; message: string };

type Mode = "acceptEdits" | "default" | "bypassPermissions";
const MODE_CYCLE: Mode[] = ["default", "acceptEdits", "bypassPermissions"];
const MODE_LABEL: Record<Mode, string> = {
  default: "prompt",
  acceptEdits: "accept edits",
  bypassPermissions: "bypass",
};
const MODE_ICON: Record<Mode, React.ReactNode> = {
  default: <Lock size={11} />,
  acceptEdits: <Unlock size={11} />,
  bypassPermissions: <ShieldAlert size={11} />,
};

interface ChatTabProps {
  /** Stable id == backend session id. Switching `id` re-mounts the component. */
  id: string;
  /** Whether this tab is the visible one. Inactive tabs render hidden but live. */
  active: boolean;
  /** When true, treat the tab as a read-only replay of a historical session
   *  (opened from the session list — disables the composer). Independent of
   *  whether history gets loaded: history is loaded on every mount so closing
   *  and reopening the drawer never loses scrollback. */
  readOnlyHistorical?: boolean;
}

/**
 * One Claude-Code chat session. Mounted inside ChatDrawer; SSE keeps streaming
 * for backgrounded tabs. Per-tab local state (messages, draft, busy) is
 * rehydrated from `/sessions/{id}/history` on every mount so the chat drawer
 * can be closed and reopened without losing the conversation.
 */
export default function ChatTab({ id, active, readOnlyHistorical = false }: ChatTabProps) {
  const v = useViewerState();
  const { trays, clearTray, setLabel } = useChatTabs();
  const tray = trays[id] ?? [];
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  // Per-tab draft, persisted via the shared prefs layer. Survives drawer
  // switches (chat→plots→back), full reload, and cross-browser. Tied to
  // the tab id so each conversation keeps its own in-progress text.
  const [input, setInput] = usePref<string>(`chatDraft::${id}`, "");
  const [injectRow, setInjectRow] = useState(true);
  const [mode, setMode] = useState<Mode>("acceptEdits");
  // Phased status so the UI tells the user where things are:
  //   sending: POST in flight to our API
  //   acked: backend accepted the message; SDK has it, model not yet emitting
  //   running: model started streaming (turn_start arrived)
  //   idle: nothing in flight
  type Phase = "idle" | "sending" | "acked" | "running";
  const [phase, setPhase] = useState<Phase>("idle");
  const busy = phase !== "idle";
  const [readOnly] = useState(readOnlyHistorical);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolResultsRef = useRef<Map<string, any>>(new Map());

  // SSE subscription handle — ref so `attachLive()` (called from send-error
  // recovery) can tear down the old stream and start a fresh one without
  // tangling with React state.
  const sseUnsubRef = useRef<(() => void) | null>(null);

  const handleSseEvent = useCallback((event: string, data: any) => {
    if (event === "message") onMessageEvent(data as ChatMessage);
    else if (event === "user_input") {} // already shown locally
    else if (event === "error") {
      setMessages((m) => [...m, { kind: "error", message: data?.error ?? "unknown error" }]);
      setPhase("idle");
    } else if (event === "turn_start") setPhase("running");
    else if (event === "turn_end") setPhase("idle");
  }, []);

  const openSse = useCallback(() => {
    sseUnsubRef.current?.();
    sseUnsubRef.current = sse(`/api/chat/sessions/${id}/events`, handleSseEvent);
  }, [id, handleSseEvent]);

  // Rehydrate from backend history on mount, then subscribe to SSE.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hist = await api.sessionHistory(id);
        if (cancelled) return;
        if (hist.length > 0) {
          const display: DisplayMessage[] = [];
          toolResultsRef.current = new Map();
          for (const h of hist) {
            const m = h.payload as ChatMessage;
            if (m.role === "user" && Array.isArray(m.content)) {
              // `role: "user"` covers two distinct kinds of message: a real
              // human-typed prompt AND synthetic agent-loop messages
              // carrying tool_result blocks back to the model (sometimes
              // alongside TextBlocks with file paths or auxiliary text).
              // Tool-result envelopes are never user input — cache their
              // payloads into the lookup map and skip the timeline push
              // entirely, otherwise reloads after image reads / Read tool
              // calls create stray bubbles showing the file path.
              const blocks = m.content as ChatBlock[];
              const isToolReturn = blocks.some((b) => b.type === "tool_result");
              for (const b of blocks) {
                if (b.type === "tool_result") toolResultsRef.current.set(b.tool_use_id, b.content);
              }
              if (!isToolReturn) {
                const txt = blocks
                  .filter((b: any) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("");
                if (txt.trim()) display.push({ kind: "user", text: txt });
              }
            } else if (m.role === "assistant") {
              for (const b of m.content as ChatBlock[]) {
                if (b.type === "tool_result") toolResultsRef.current.set(b.tool_use_id, b.content);
              }
              display.push({ kind: "assistant", blocks: m.content, model: m.model });
            } else if (m.role === "result") {
              display.push({
                kind: "result", cost: m.total_cost_usd, turns: m.num_turns,
                ms: m.duration_ms, isError: m.is_error,
              });
            }
          }
          setMessages(display);
        }
      } catch {
        // Backend may have evicted a session — leave UI in fresh state.
      }
      if (cancelled) return;
      // Read-only tabs (un-resumable historical sessions) have no live SDK
      // client on the backend, so subscribing to /events would just 404.
      if (readOnlyHistorical) return;
      openSse();
    })();
    return () => {
      cancelled = true;
      sseUnsubRef.current?.();
      sseUnsubRef.current = null;
    };
  // id is the identity of this tab — we never change it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (active) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, active]);

  function onMessageEvent(m: ChatMessage) {
    if (m.role === "assistant") {
      setMessages((prev) => [...prev, { kind: "assistant", blocks: m.content, model: m.model }]);
    } else if (m.role === "user") {
      const blocks = m.content as ChatBlock[];
      for (const b of blocks) {
        if (b.type === "tool_result") toolResultsRef.current.set(b.tool_use_id, b.content);
      }
      setMessages((prev) => [...prev]);
    } else if (m.role === "result") {
      setMessages((prev) => [...prev, {
        kind: "result", cost: m.total_cost_usd, turns: m.num_turns, ms: m.duration_ms, isError: m.is_error,
      }]);
    }
  }

  const cycleMode = useCallback(async () => {
    const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
    setMode(next);
    await api.setPermissionMode(id, next).catch(() => {});
  }, [id, mode]);

  async function send() {
    const text = input.trim();
    if (!text || !id || readOnly) return;
    const trayBlock = serializeTray(tray);
    const composed = trayBlock ? `${trayBlock}\n\n${text}` : text;
    setLabel(id, truncate(text, 28));
    setMessages((prev) => [...prev, { kind: "user", text: composed }]);
    setPhase("sending");
    setInput("");
    clearTray(id);
    try {
      await api.sendMessage(id, { text: composed, inject_current_row: injectRow });
      // POST returned 200: backend has the message. Now we wait for the
      // model to actually start emitting (turn_start) — that's the
      // `running` transition. If we're already in `running` from a
      // concurrent turn, leave that alone.
      setPhase((p) => (p === "running" ? p : "acked"));
    } catch (e) {
      // 404 = backend forgot the session (uvicorn reload, manual close).
      // Silent re-attach + retry once. SSE also has to be reopened.
      if (String(e).includes("404")) {
        try {
          await api.resumeSession(id);
          openSse();
          await api.sendMessage(id, { text: composed, inject_current_row: injectRow });
          setPhase((p) => (p === "running" ? p : "acked"));
        } catch (e2) {
          setMessages((prev) => [...prev, {
            kind: "error",
            message: `Session disconnected and re-attach failed: ${String(e2).slice(0, 200)}. Open a new tab to continue.`,
          }]);
          setPhase("idle");
        }
      } else {
        setMessages((prev) => [...prev, { kind: "error", message: String(e).slice(0, 300) }]);
        setPhase("idle");
      }
    }
  }

  async function stop() {
    if (!id || !busy) return;
    await api.interruptSession(id).catch(() => {});
  }

  return (
    <div className={cn("flex-1 min-h-0 flex flex-col", !active && "hidden")}>
      <div className="h-9 shrink-0 px-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2 text-[11px]">
        <button
          onClick={cycleMode}
          title="Shift+Tab cycles permission mode"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800/60 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        >
          {MODE_ICON[mode]} {MODE_LABEL[mode]}
        </button>
        <label className="flex items-center gap-1 text-[10px] text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={injectRow} onChange={(e) => setInjectRow(e.target.checked)} />
          inject current row
        </label>
        {readOnly && (
          <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">historical</span>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-2">
        {messages.length === 0 && (
          <div className="text-[11px] text-zinc-500 p-2 leading-relaxed">
            Try: <code className="text-zinc-700 dark:text-zinc-300">"viewer sample 5 and judge them for alignment"</code>
            {" or shift+click any row / mark / judge to pin it as context."}
          </div>
        )}
        {messages.map((m, i) => (
          <MessageView key={i} m={m} toolResults={toolResultsRef.current} />
        ))}
        {busy && <PhaseIndicator phase={phase} />}
      </div>
      <ContextTray tabId={id} />
      <div className="border-t border-zinc-200 dark:border-zinc-800 p-2">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={readOnly}
            // Layout's `c` hotkey looks for this attribute to focus the
            // composer on drawer-open. Only the active tab's textarea is
            // visible (inactive tabs have `display:none` ancestors), so
            // querySelector reliably picks it.
            data-chat-input={active ? "true" : undefined}
            onKeyDown={(e) => {
              if (e.shiftKey && e.key === "Tab") {
                e.preventDefault();
                cycleMode();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
                return;
              }
              if (e.key === "Escape") {
                // Blur so the next keystroke reaches Layout's global hotkey
                // handler (which ignores keys while focus is in an INPUT
                // or TEXTAREA). Lets you Esc-p to jump to plots, etc.
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            placeholder={
              readOnly ? "(historical session — open a new tab to chat)"
                : busy ? "steer mid-trace (the model picks up new input as it runs)…"
                : v.dataset_path ? `ask about ${v.dataset_path.split("/").pop()}` : "open a dataset, then ask…"
            }
            rows={3}
            className="flex-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded px-2 py-1 text-xs font-mono outline-none focus:border-emerald-600 resize-none disabled:opacity-50"
          />
          <div className="self-end flex flex-col gap-1">
            {busy && (
              <button
                onClick={stop}
                title="stop the current turn (Esc)"
                className="px-2 py-1 bg-rose-700 hover:bg-rose-600 text-zinc-50 rounded text-xs flex items-center gap-1"
              >
                <Square size={11} /> stop
              </button>
            )}
            <button
              onClick={send}
              disabled={readOnly || !input.trim()}
              title={busy ? "send to the running session — the model sees this mid-trace" : "send"}
              className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 text-zinc-50 rounded text-xs flex items-center gap-1 disabled:opacity-50"
            >
              <Send size={12} /> send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Tells the user which lifecycle stage a sent message is in. The phases
 *  map to real backend events: `sending` ends when our POST resolves
 *  (sub-second normally); `acked` ends when the SDK emits its first
 *  message of the turn (turn_start); `running` ends when ResultMessage
 *  closes the turn. */
function PhaseIndicator({ phase }: { phase: "idle" | "sending" | "acked" | "running" }) {
  if (phase === "idle") return null;
  const label =
    phase === "sending" ? "sending to API…"
    : phase === "acked"  ? "queued — waiting for Claude to start…"
    : "Claude is thinking…";
  const tone =
    phase === "sending" ? "text-zinc-500"
    : phase === "acked"  ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400";
  return (
    <div className={cn("flex items-center gap-2 text-[11px] p-2", tone)}>
      <span className="inline-flex gap-0.5">
        <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: "0ms" }} />
        <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: "150ms" }} />
        <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: "300ms" }} />
      </span>
      {label}
    </div>
  );
}

function MessageView({ m, toolResults }: { m: DisplayMessage; toolResults: Map<string, any> }) {
  if (m.kind === "user") {
    return (
      <div className="flex gap-2">
        <User size={14} className="mt-1 text-blue-500 dark:text-blue-400 shrink-0" />
        <div className="flex-1 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/60 rounded p-2 text-xs whitespace-pre-wrap text-zinc-800 dark:text-zinc-100">
          {m.text}
        </div>
      </div>
    );
  }
  if (m.kind === "result") {
    return (
      <div className="text-[10px] text-zinc-500 flex items-center gap-2 px-2">
        {m.isError ? <AlertCircle size={10} className="text-red-400" /> : <CheckCircle2 size={10} className="text-emerald-500" />}
        <span>{m.turns} turns · {(m.ms / 1000).toFixed(1)}s {m.cost != null ? `· $${m.cost.toFixed(4)}` : ""}</span>
      </div>
    );
  }
  if (m.kind === "error") {
    return (
      <div className="bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-900 rounded p-2 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        {m.message}
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <Bot size={14} className="mt-1 text-emerald-500 dark:text-emerald-400 shrink-0" />
      <div className="flex-1 space-y-1.5 min-w-0">
        {m.blocks.map((b, i) => <Block key={i} b={b} toolResults={toolResults} />)}
      </div>
    </div>
  );
}

function Block({ b, toolResults }: { b: ChatBlock; toolResults: Map<string, any> }) {
  if (b.type === "text") {
    return (
      <div className="text-xs markdown text-zinc-800 dark:text-zinc-200">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{b.text}</ReactMarkdown>
      </div>
    );
  }
  if (b.type === "thinking") {
    return (
      <details className="text-[11px] text-zinc-500">
        <summary className="cursor-pointer">thinking</summary>
        <pre className="mt-1 whitespace-pre-wrap">{b.text}</pre>
      </details>
    );
  }
  if (b.type === "tool_use") {
    const result = toolResults.get(b.id);
    const headline = toolHeadline(b.name, b.input);
    return (
      <details className="border border-zinc-200 dark:border-zinc-800 rounded">
        <summary className="cursor-pointer px-2 py-1 text-[11px] flex items-center gap-1.5 min-w-0">
          <Wrench size={11} className={cn("opacity-70 shrink-0", result == null && "animate-pulse")} />
          <code className="font-mono text-zinc-600 dark:text-zinc-400 shrink-0">{b.name}</code>
          {headline.description && (
            <span className="text-zinc-700 dark:text-zinc-300 truncate" title={headline.description}>
              {headline.description}
            </span>
          )}
          {headline.code && (
            <code className="font-mono text-emerald-700 dark:text-emerald-300 truncate text-[10.5px] bg-emerald-500/5 px-1 rounded" title={headline.code}>
              {headline.code}
            </code>
          )}
        </summary>
        <div className="px-2 py-1 border-t border-zinc-200 dark:border-zinc-800 text-[11px] space-y-1">
          <pre className="bg-zinc-50 dark:bg-zinc-950 p-1 rounded overflow-x-auto whitespace-pre-wrap">{JSON.stringify(b.input, null, 2)}</pre>
          {result && (
            <pre className="bg-zinc-50 dark:bg-zinc-950 p-1 rounded overflow-x-auto text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
              {Array.isArray(result)
                ? result.map((c: any) => c?.text ?? JSON.stringify(c)).join("\n")
                : truncate(typeof result === "string" ? result : JSON.stringify(result, null, 2), 4000)}
            </pre>
          )}
        </div>
      </details>
    );
  }
  return null;
}

/** Per-tool summary line: `description` is the prose label (what the call
 *  is *for*), `code` is the actionable bit (the bash command, the file
 *  path, the search pattern). Either or both may be empty. */
function toolHeadline(name: string, input: Record<string, unknown>): { description?: string; code?: string } {
  const s = (v: unknown) => (v == null ? "" : String(v));
  switch (name) {
    case "Bash":
      return { description: s(input.description), code: truncate(s(input.command), 120) };
    case "Read":
      return { code: rangeLabel(s(input.file_path), input.offset, input.limit) };
    case "Write":
      return { description: "write", code: s(input.file_path) };
    case "Edit":
      return { description: input.replace_all ? "edit (all)" : "edit", code: s(input.file_path) };
    case "Grep":
      return { description: s(input.pattern), code: s(input.path) || s(input.glob) || undefined };
    case "Glob":
      return { code: s(input.pattern) };
    case "WebFetch":
      return { description: truncate(s(input.prompt), 80), code: s(input.url) };
    case "WebSearch":
      return { code: s(input.query) };
    default:
      // Unknown / MCP / custom tool — fall back to the most informative
      // string-valued field, prefixed by its name so it's parseable.
      for (const k of ["description", "command", "query", "path", "url", "input", "prompt"]) {
        if (typeof input[k] === "string" && input[k]) {
          return { code: truncate(`${k}: ${input[k] as string}`, 140) };
        }
      }
      const first = Object.entries(input)[0];
      return first ? { code: truncate(`${first[0]}: ${String(first[1])}`, 140) } : {};
  }
}

function rangeLabel(path: string, offset: unknown, limit: unknown): string {
  if (!offset && !limit) return path;
  const off = Number(offset || 1);
  const end = limit ? off + Number(limit) - 1 : off;
  return `${path}:${off}-${end}`;
}
