// Event blocks of the transcript view: one block per normalized session event
// (human message, assistant text, thinking, tool call, tool result, harness-
// injected system content). The visual grammar follows the report kit's trace
// viewer: a left rule in the kind's colour, a small uppercase label, the fold
// chevron leading the head, a one-line summary standing in for a folded body.

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Flag } from "lucide-react";
import PreOrMarkdown from "../PreOrMarkdown";
import CopyButton from "../CopyButton";
import { cn } from "../../lib/utils";

export type EventKind = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system";

export type TEvent = {
  idx: number;
  kind: EventKind;
  text: string;
  text_len?: number;
  clipped?: boolean;
  tool_name?: string | null;
  tool_input?: Record<string, any> | null;
  tool_call_id?: string | null;
  is_error?: boolean | null;
  subtype?: string | null;
  timestamp?: string | null;
  source_line?: number | null;
};

/** Why a judge cites an event: the overeager action itself, the human request
 *  it is measured against, the human's reaction, or a close call not flagged. */
export type RefRole = "action" | "request" | "reaction" | "considered";

export type EventRef = {
  judge: number;
  judgeName: string;
  /** Incident list index as a string; `n<i>` for a considered-not-flagged entry. */
  item: string;
  role: RefRole;
  detail?: string;
};

/** One hue per judge model, assigned by sorted model name. */
export const JUDGE_COLORS = ["#ea580c", "#c026d3", "#0891b2", "#65a30d"];
export const ROLE_COLORS: Record<RefRole, string | null> = {
  action: null, // the judge's own hue
  request: "#0284c7",
  reaction: "#e11d48",
  considered: "#71717a",
};

/** Things the human did that are not typed requests (filed under system /
 *  tool_result by the session parser): an interrupt, a `!` shell command, a
 *  local slash command, a refused tool call, an answer to the agent's question,
 *  an approved plan. */
export const HUMAN_ACTION_SUBTYPES = new Set([
  "interrupt", "user_shell", "local_command", "user_rejected", "user_answer", "plan_approved",
]);

export function judgeShort(model: string): string {
  return model.split("/").pop() || model;
}

/** Per-viewer expanded state of clamped text, kept above the virtualized list
 *  so a block scrolled out of view comes back the way the reader left it. */
export const ClampStore = createContext<Map<string, boolean>>(new Map());

const KIND: Record<EventKind, { label: string; rule: string; bg: string; labelCls: string; foldable: boolean }> = {
  user: {
    label: "human", foldable: false,
    rule: "border-sky-500", bg: "bg-sky-50 dark:bg-sky-950/40",
    labelCls: "text-sky-700 dark:text-sky-300",
  },
  assistant: {
    label: "assistant", foldable: false,
    rule: "border-zinc-400 dark:border-zinc-500", bg: "",
    labelCls: "text-zinc-500",
  },
  thinking: {
    label: "thinking", foldable: true,
    rule: "border-violet-400", bg: "bg-violet-50/60 dark:bg-violet-950/20",
    labelCls: "text-violet-600 dark:text-violet-300",
  },
  tool_call: {
    label: "tool call", foldable: true,
    rule: "border-amber-500", bg: "bg-zinc-50 dark:bg-zinc-900/60",
    labelCls: "text-amber-700 dark:text-amber-400",
  },
  tool_result: {
    label: "result", foldable: true,
    rule: "border-emerald-500/70", bg: "",
    labelCls: "text-emerald-700 dark:text-emerald-400",
  },
  system: {
    label: "system", foldable: true,
    rule: "border-dashed border-zinc-300 dark:border-zinc-700", bg: "",
    labelCls: "text-zinc-500",
  },
};

const CODE = "font-mono text-[12.5px] leading-snug whitespace-pre-wrap break-words";

/** Wrap case-insensitive occurrences of `q` in <mark>. */
export function hl(text: string, q: string): React.ReactNode {
  if (!q || !text) return text;
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let from = 0;
  for (let n = 0; n < 2000; n++) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) out.push(text.slice(from, at));
    out.push(<mark key={n} className="viewer-hl">{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
  }
  if (from === 0) return text;
  out.push(text.slice(from));
  return out;
}

function firstLine(s: string, n = 140): string {
  const t = (s || "").trim().split("\n")[0] ?? "";
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/**
 * Bound a tall block to `lines` lines; clicking the text itself expands and
 * collapses it (a click that ends a text selection does not). No hint when the
 * content already fits.
 */
export function Clamp({ id, lines = 24, children }: { id: string; lines?: number; children: React.ReactNode }) {
  const store = useContext(ClampStore);
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpandedState] = useState(store.get(id) ?? false);
  const [overflow, setOverflow] = useState(false);
  const maxPx = lines * 18;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollHeight > maxPx + 8);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxPx]);
  const toggle = () => {
    if (!overflow) return;
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    store.set(id, !expanded);
    setExpandedState(!expanded);
  };
  return (
    <div>
      <div
        ref={ref}
        onClick={toggle}
        className={cn(overflow && "cursor-pointer")}
        style={!expanded ? { maxHeight: maxPx, overflow: "hidden" } : undefined}
      >
        {children}
      </div>
      {overflow && (
        <button onClick={toggle} className="mt-0.5 text-[11px] text-sky-700 dark:text-sky-400 hover:underline">
          {expanded ? "show less" : "show all"}
        </button>
      )}
    </div>
  );
}

// ── tool input ──────────────────────────────────────────────────────────────

type DiffLine = { t: " " | "-" | "+"; s: string };

/** Line diff (common prefix/suffix trimmed, LCS on the middle). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n"), B = b.split("\n");
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const am = A.slice(pre, A.length - suf), bm = B.slice(pre, B.length - suf);
  const out: DiffLine[] = A.slice(0, pre).map((s) => ({ t: " " as const, s }));
  if (am.length * bm.length > 400_000) {
    am.forEach((s) => out.push({ t: "-", s }));
    bm.forEach((s) => out.push({ t: "+", s }));
  } else {
    const n = am.length, m = bm.length;
    const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { out.push({ t: " ", s: am[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "-", s: am[i++] });
      else out.push({ t: "+", s: bm[j++] });
    }
    while (i < n) out.push({ t: "-", s: am[i++] });
    while (j < m) out.push({ t: "+", s: bm[j++] });
  }
  A.slice(A.length - suf).forEach((s) => out.push({ t: " ", s }));
  return out;
}

function DiffBlock({ lines, q }: { lines: DiffLine[]; q: string }) {
  return (
    <div className={cn(CODE, "rounded border border-zinc-200 dark:border-zinc-800 overflow-hidden")}>
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "flex",
            l.t === "-" && "bg-red-500/15 text-red-900 dark:text-red-200",
            l.t === "+" && "bg-emerald-500/15 text-emerald-900 dark:text-emerald-200",
          )}
        >
          <span className="w-5 shrink-0 text-center select-none opacity-60">{l.t}</span>
          <span className="min-w-0 flex-1">{hl(l.s, q) || " "}</span>
        </div>
      ))}
    </div>
  );
}

/** A unified-diff / apply_patch body: colour by each line's leading character. */
function patchLines(patch: string): DiffLine[] {
  return patch.split("\n").map((s) => {
    if (s.startsWith("+") && !s.startsWith("+++")) return { t: "+", s: s.slice(1) };
    if (s.startsWith("-") && !s.startsWith("---")) return { t: "-", s: s.slice(1) };
    return { t: " ", s: s.startsWith(" ") ? s.slice(1) : s };
  });
}

function CodeBlock({ id, text, q, lines = 24 }: { id: string; text: string; q: string; lines?: number }) {
  return (
    <Clamp id={id} lines={lines}>
      <pre className={cn(CODE, "bg-zinc-100 dark:bg-zinc-900 rounded px-2 py-1.5 text-zinc-800 dark:text-zinc-200")}>
        {hl(text, q)}
      </pre>
    </Clamp>
  );
}

const OLD_KEYS = ["old_string", "old_str", "oldText", "old_text"];
const NEW_KEYS = ["new_string", "new_str", "newText", "new_text"];
const PATH_KEYS = ["file_path", "path", "notebook_path", "filename", "target_file", "filePath"];
const CONTENT_KEYS = ["content", "file_text", "new_source", "contents"];

function pick(o: Record<string, any>, keys: string[]): string | null {
  for (const k of keys) if (typeof o[k] === "string") return k;
  return null;
}

function commandOf(input: Record<string, any>): { key: string; text: string } | null {
  for (const key of ["command", "cmd", "script"]) {
    const c = input[key];
    if (typeof c === "string") return { key, text: c };
    if (Array.isArray(c) && c.every((x) => typeof x === "string")) return { key, text: c.join(" ") };
  }
  return null;
}

/** The one line that says what a tool call does (its head summary). */
export function toolSummary(ev: TEvent): string {
  const input = ev.tool_input;
  if (!input || typeof input !== "object") return firstLine(ev.text);
  const cmd = commandOf(input);
  if (cmd) return firstLine(cmd.text);
  const p = pick(input, PATH_KEYS);
  if (p) return String(input[p]);
  for (const k of ["pattern", "query", "url", "description", "prompt", "skill", "subject"]) {
    if (typeof input[k] === "string") return firstLine(input[k]);
  }
  const first = Object.values(input).find((x) => typeof x === "string");
  return first ? firstLine(first as string) : "";
}

/**
 * A tool call's input, rendered by the shape of its fields rather than by tool
 * name (the sessions come from several agents): a shell command as a code
 * block, old/new strings as a diff, written content under its path, a patch
 * coloured by line, and whatever is left as a key/value list.
 */
export function ToolInput({ ev, q }: { ev: TEvent; q: string }) {
  const input = ev.tool_input;
  const id = `in:${ev.idx}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ev.text ? <CodeBlock id={id} text={ev.text} q={q} /> : null;
  }
  const rest: Record<string, any> = { ...input };
  const parts: React.ReactNode[] = [];

  const pathKey = pick(rest, PATH_KEYS);
  const path = pathKey ? String(rest[pathKey]) : null;
  const cmd = commandOf(rest);
  const oldKey = pick(rest, OLD_KEYS), newKey = pick(rest, NEW_KEYS);
  const contentKey = pick(rest, CONTENT_KEYS);

  if (path && (oldKey || contentKey || Array.isArray(rest.edits))) {
    delete rest[pathKey!];
    parts.push(
      <div key="path" className="font-mono text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-200 break-all">
        {hl(path, q)}
      </div>,
    );
  }
  if (cmd) {
    delete rest[cmd.key];
    if (typeof rest.description === "string") {
      parts.push(<div key="desc" className="text-[12.5px] text-zinc-600 dark:text-zinc-400">{hl(rest.description, q)}</div>);
      delete rest.description;
    }
    const isPatch = /\*\*\* Begin Patch/.test(cmd.text);
    parts.push(
      isPatch
        ? <Clamp key="cmd" id={`${id}:cmd`} lines={40}><DiffBlock lines={patchLines(cmd.text)} q={q} /></Clamp>
        : <CodeBlock key="cmd" id={`${id}:cmd`} text={cmd.text} q={q} lines={40} />,
    );
  }
  if (oldKey && newKey) {
    const diff = lineDiff(rest[oldKey], rest[newKey]);
    delete rest[oldKey];
    delete rest[newKey];
    parts.push(<Clamp key="diff" id={`${id}:diff`} lines={40}><DiffBlock lines={diff} q={q} /></Clamp>);
  }
  if (Array.isArray(rest.edits)) {
    rest.edits.forEach((e: any, i: number) => {
      const o = e && pick(e, OLD_KEYS), n = e && pick(e, NEW_KEYS);
      if (!o || !n) return;
      parts.push(
        <Clamp key={`edit${i}`} id={`${id}:edit${i}`} lines={40}>
          <DiffBlock lines={lineDiff(e[o], e[n])} q={q} />
        </Clamp>,
      );
    });
    if (rest.edits.every((e: any) => e && pick(e, OLD_KEYS) && pick(e, NEW_KEYS))) delete rest.edits;
  }
  if (contentKey && path && !oldKey) {
    const content = rest[contentKey] as string;
    delete rest[contentKey];
    parts.push(
      <Clamp key="content" id={`${id}:content`} lines={24}>
        <DiffBlock lines={content.split("\n").map((s) => ({ t: "+" as const, s }))} q={q} />
      </Clamp>,
    );
  }
  for (const k of ["patch", "diff", "input"]) {
    const val = rest[k];
    if (typeof val === "string" && /^(\*\*\* Begin Patch|diff --git|--- |@@ )/m.test(val)) {
      delete rest[k];
      parts.push(<Clamp key={k} id={`${id}:${k}`} lines={40}><DiffBlock lines={patchLines(val)} q={q} /></Clamp>);
    }
  }
  const keys = Object.keys(rest);
  const str = (val: any) => (typeof val === "string" ? val : JSON.stringify(val, null, 2));
  const isShort = (val: any) => { const t = str(val) ?? ""; return t.length <= 160 && !t.includes("\n"); };
  // Short leftovers (cwd, timeouts, flags) share one line; long ones get a block each.
  const short = keys.filter((k) => isShort(rest[k]));
  const long = keys.filter((k) => !isShort(rest[k]));
  if (short.length) {
    parts.push(
      <div key="short" className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[12px]">
        {short.map((k) => (
          <span key={k} className="min-w-0 break-all">
            <span className="text-zinc-500">{k}</span>{" "}
            <span className="text-zinc-800 dark:text-zinc-200">{hl(str(rest[k]) ?? "", q)}</span>
          </span>
        ))}
      </div>,
    );
  }
  long.forEach((k) => {
    parts.push(
      <div key={`k:${k}`}>
        <div className="font-mono text-[12px] text-zinc-500">{k}</div>
        <CodeBlock id={`${id}:k:${k}`} text={str(rest[k])} q={q} lines={16} />
      </div>,
    );
  });
  return <div className="space-y-1.5">{parts}</div>;
}

// ── one event ───────────────────────────────────────────────────────────────

function refLabel(r: EventRef): string {
  const who = `${r.judgeName} #${r.item.replace(/^n/, "")}`;
  if (r.role === "action") return r.detail ? `${who} · ${r.detail}` : who;
  if (r.role === "request") return `request · ${who}`;
  if (r.role === "reaction") return `reaction${r.detail ? ` (${r.detail})` : ""} · ${who}`;
  return `not flagged · ${who}`;
}

export function refColor(r: EventRef): string {
  return ROLE_COLORS[r.role] ?? JUDGE_COLORS[r.judge % JUDGE_COLORS.length];
}

function RefChip({ r, active, onClick }: { r: EventRef; active: boolean; onClick: () => void }) {
  const color = refColor(r);
  const filled = r.role === "action";
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title="show this incident"
      className={cn(
        "shrink-0 rounded px-1.5 py-px text-[11px] font-medium leading-4 border whitespace-nowrap",
        r.role === "considered" && "border-dashed",
        active && "ring-2 ring-offset-1 ring-offset-white dark:ring-offset-zinc-950",
      )}
      style={{
        borderColor: color,
        background: filled ? color : "transparent",
        color: filled ? "#fff" : color,
        // @ts-expect-error CSS custom property consumed by Tailwind's ring
        "--tw-ring-color": color,
      }}
    >
      {refLabel(r)}
    </button>
  );
}

export type EventBlockProps = {
  ev: TEvent;
  open: boolean;
  onToggle: () => void;
  refs: EventRef[];
  /** Roles this event plays in the selected incident (empty when it has none). */
  selectedRoles: EventRef[];
  focused: boolean;
  flash: boolean;
  q: string;
  missed: boolean;
  onToggleMissed: () => void;
  onSelectEvent: () => void;
  onSelectRef: (r: EventRef) => void;
  onLoadFull: () => void;
};

export function EventBlock(p: EventBlockProps) {
  const { ev, open, refs } = p;
  const K = KIND[ev.kind] ?? KIND.system;
  const isError = ev.kind === "tool_result" && !!ev.is_error;
  const actionRefs = refs.filter((r) => r.role === "action");
  const flagStyle = useMemo(() => {
    const st: React.CSSProperties = {};
    if (actionRefs.length) {
      const colors = [...new Set(actionRefs.map(refColor))];
      st.boxShadow = colors.map((c, i) => `inset -${(i + 1) * 4}px 0 0 ${c}`).join(", ");
      st.backgroundColor = `color-mix(in srgb, ${colors[0]} 9%, transparent)`;
    }
    const sel = p.selectedRoles[0];
    if (sel) {
      st.outline = `2px solid ${refColor(sel)}`;
      st.outlineOffset = 1;
    } else if (p.focused) {
      st.outline = "2px solid #0ea5e9";
      st.outlineOffset = 1;
    }
    return st;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, p.selectedRoles, p.focused]);

  const humanAction = !!ev.subtype && HUMAN_ACTION_SUBTYPES.has(ev.subtype);
  const sub = ev.subtype ? ev.subtype.replace(/_/g, " ") : null;
  const base = humanAction && ev.kind === "system" ? "human action" : isError ? "result · error" : K.label;
  const label = sub ? `${base} · ${sub}` : base;
  const summary =
    ev.kind === "tool_call" ? toolSummary(ev)
    : !open ? firstLine(ev.text)
    : "";
  const size = ev.text_len ?? ev.text?.length ?? 0;
  const title = [
    `event ${ev.idx}`,
    ev.timestamp ? ev.timestamp : null,
    ev.source_line != null ? `raw transcript line ${ev.source_line}` : null,
    "click to select and put it in the URL",
  ].filter(Boolean).join(" · ");

  return (
    <div data-ev={ev.idx} className="group/ev flex gap-2 pl-2 pr-3 py-[3px]">
      <button
        onClick={p.onSelectEvent}
        title={title}
        className={cn(
          "w-12 shrink-0 self-start pt-1 text-right font-mono text-[11px] hover:text-sky-600 dark:hover:text-sky-400",
          p.focused ? "text-sky-600 dark:text-sky-400 font-semibold" : "text-zinc-500",
        )}
      >
        E{ev.idx}
      </button>
      <div
        className={cn(
          "min-w-0 flex-1 border-l-[3px] rounded-r pl-3 pr-3 py-1",
          K.rule, K.bg,
          ev.kind === "tool_result" && "ml-6",
          isError && "!border-red-500",
          humanAction && "!border-solid !border-rose-500",
          ev.kind === "tool_call" && "border-y border-r border-y-zinc-200 border-r-zinc-200 dark:border-y-zinc-800 dark:border-r-zinc-800",
          p.flash && "transcript-flash",
        )}
        style={flagStyle}
      >
        <div
          className={cn("flex items-center gap-2 min-h-[22px]", K.foldable && "cursor-pointer select-none")}
          onClick={K.foldable ? p.onToggle : undefined}
        >
          {K.foldable && (
            <ChevronRight size={13} className={cn("shrink-0 text-zinc-500 transition-transform", open && "rotate-90")} />
          )}
          <span className={cn("shrink-0 text-[10.5px] font-semibold uppercase tracking-wider", humanAction ? "text-rose-600 dark:text-rose-400" : isError ? "text-red-600 dark:text-red-400" : K.labelCls)}>
            {label}
          </span>
          {ev.tool_name && (
            <span className="shrink-0 font-mono text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-100">{ev.tool_name}</span>
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-zinc-500">{summary ? hl(summary, p.q) : ""}</span>
          {!open && size > 400 && (
            <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">{size.toLocaleString()} chars</span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); p.onToggleMissed(); }}
            title={p.missed ? "remove from “the judges missed this”" : "the judges missed something here"}
            className={cn(
              "shrink-0 rounded p-0.5",
              p.missed
                ? "text-amber-600 dark:text-amber-400"
                : "text-zinc-400 opacity-0 group-hover/ev:opacity-100 hover:text-amber-600",
            )}
          >
            <Flag size={13} fill={p.missed ? "currentColor" : "none"} />
          </button>
          <span className="shrink-0 opacity-0 group-hover/ev:opacity-100">
            <CopyButton value={() => (ev.kind === "tool_call" && ev.tool_input ? JSON.stringify(ev.tool_input, null, 2) : ev.text)} />
          </span>
        </div>
        {refs.length > 0 && (
          <div className="flex flex-wrap gap-1 py-0.5">
          {refs.map((r, i) => (
              <RefChip
                key={i}
                r={r}
                active={p.selectedRoles.some((s) => s.judge === r.judge && s.item === r.item && s.role === r.role)}
                onClick={() => p.onSelectRef(r)}
              />
            ))}
          </div>
        )}
        {open && (
          <div className="pt-0.5 pb-1">
            <EventBody ev={ev} q={p.q} />
            {ev.clipped && (
              <button
                onClick={p.onLoadFull}
                className="mt-1 text-[11px] text-sky-700 dark:text-sky-400 hover:underline"
              >
                long content cut for speed · load all {size > 0 ? `${size.toLocaleString()} chars` : ""}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EventBody({ ev, q }: { ev: TEvent; q: string }) {
  const id = `ev:${ev.idx}`;
  switch (ev.kind) {
    case "user":
      return (
        <Clamp id={id} lines={60}>
          <pre className="whitespace-pre-wrap break-words font-sans text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-50">
            {hl(ev.text, q)}
          </pre>
        </Clamp>
      );
    case "assistant":
      return q
        ? <pre className="whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed text-zinc-800 dark:text-zinc-200">{hl(ev.text, q)}</pre>
        : <PreOrMarkdown text={ev.text} mode="markdown" />;
    case "tool_call":
      return <ToolInput ev={ev} q={q} />;
    case "tool_result":
      return ev.text
        ? <CodeBlock id={id} text={ev.text} q={q} lines={30} />
        : <div className="text-[12.5px] italic text-zinc-500">empty result</div>;
    default:
      return (
        <Clamp id={id} lines={30}>
          <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {hl(ev.text, q)}
          </pre>
        </Clamp>
      );
  }
}
