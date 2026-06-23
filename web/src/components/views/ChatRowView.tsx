import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { useRowPage } from "../../lib/rowPage";
import { useUrlSync } from "../../lib/url";
import { usePref } from "../../lib/prefs";
import { cn } from "../../lib/utils";
import MarkInline from "../MarkInline";
import RawJsonToggle from "../RawJsonToggle";
import PreOrMarkdown from "../PreOrMarkdown";
import Collapsible from "../Collapsible";
import CopyButton from "../CopyButton";
import MultiSelectChips from "../ui/MultiSelectChips";
import { ChevronsDown, ChevronsRight, Pin } from "lucide-react";
import { usePinHandler } from "../../lib/pin";
import { useRawOverride } from "../../lib/rawOverrides";

const PAGE = 100;

type Message = { role: string; content: string };

const ROLE_RULE: Record<string, string> = {
  system: "bg-amber-500",
  user: "bg-zinc-400 dark:bg-zinc-500",
  assistant: "bg-emerald-500",
  tool: "bg-violet-500",
};
const ROLE_LABEL_TONE: Record<string, string> = {
  system: "text-amber-600 dark:text-amber-400",
  user: "text-zinc-500 dark:text-zinc-400",
  assistant: "text-emerald-600 dark:text-emerald-400",
  tool: "text-violet-600 dark:text-violet-400",
};

function getMessages(row: Record<string, any> | undefined): Message[] {
  const m = row?.messages;
  if (!Array.isArray(m)) return [];
  return m as Message[];
}

/** Pref key for which metadata columns are pinned at the top of each row.
 *  Per-dataset (different metric dumps want different fields). Stored via
 *  the shared prefs layer so it round-trips to the backend and survives
 *  reload + cross-browser. The CLI mutates the same key directly. */
function pinnedFieldsKey(path: string): string {
  return `pinnedFields::${path}`;
}

/** Strip of `key: value` chips rendered above each row's messages. Skips
 *  fields whose value is null/empty so an unselected metadata field doesn't
 *  produce a blank chip when the column is sparse. */
function PinnedFields({ row, fields }: { row: Record<string, any>; fields: string[] }) {
  if (fields.length === 0) return null;
  const present = fields.filter((f) => row[f] !== undefined && row[f] !== null && row[f] !== "");
  if (present.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {present.map((f) => (
        <span
          key={f}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-amber-500/10 text-[10.5px] font-mono border border-amber-500/30"
          title={`${f}: ${String(row[f])}`}
        >
          <span className="text-amber-700 dark:text-amber-300 opacity-70">{f}</span>
          <span className="text-zinc-800 dark:text-zinc-100 truncate max-w-[260px]">
            {fmtFieldValue(row[f])}
          </span>
        </span>
      ))}
    </div>
  );
}

function fmtFieldValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") {
    // Trim noise on floats so chips stay readable.
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
  }
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…" : v;
  return JSON.stringify(v).slice(0, 80);
}

/** A single message: tiny role caption + 2px hue rule + body + hover actions. */
function MessageBlock({
  msg, msgIdx, row, datasetPath, rowIdx, defaultRaw,
}: {
  msg: Message;
  msgIdx: number;
  row: Record<string, any>;
  datasetPath: string;
  rowIdx: number;
  defaultRaw: boolean;
}) {
  const ruleClass = ROLE_RULE[msg.role] ?? "bg-zinc-400 dark:bg-zinc-600";
  const labelTone = ROLE_LABEL_TONE[msg.role] ?? "text-zinc-500";
  const text = String(msg.content ?? "");
  const [raw, toggleRaw] = useRawOverride(`msg::${datasetPath}::${rowIdx}::${msgIdx}`, defaultRaw);
  return (
    <div className="grid grid-cols-[2px_minmax(0,1fr)] gap-3 py-2 group/msg">
      <div className={cn("rounded-sm", ruleClass)} />
      <div className="min-w-0">
        <div className="flex items-center mb-1.5">
          <div
            className={cn(
              "text-[10px] font-mono uppercase tracking-[0.18em]",
              labelTone,
            )}
          >
            {msg.role}
          </div>
          <div
            className="ml-auto flex items-center gap-1 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <CopyButton variant="markdown" value={text} title="copy message text (markdown)" />
            <CopyButton variant="json" value={() => JSON.stringify(msg, null, 2)} title="copy message JSON" />
            <RawJsonToggle value={raw} onChange={toggleRaw} title={raw ? "show parsed message" : "show raw message JSON"} />
          </div>
        </div>
        {raw ? (
          <pre
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-mono whitespace-pre-wrap p-2 rounded-sm bg-zinc-100/70 dark:bg-zinc-900/70 text-zinc-800 dark:text-zinc-200 overflow-x-auto"
          >
            {JSON.stringify(msg, null, 2)}
          </pre>
        ) : (
          <Collapsible lines={10} chars={520}>
            <PreOrMarkdown
              text={text}
              mode="markdown"
              highlightCtx={{ row, msg: { role: msg.role, content: text } }}
            />
          </Collapsible>
        )}
      </div>
    </div>
  );
}

/** Render a chat-format row as a markdown transcript suitable for clipboard pasting. */
function rowToMarkdown(row: Record<string, any>): string {
  const msgs = getMessages(row);
  const parts: string[] = [];
  for (const m of msgs) {
    parts.push(`## ${m.role}\n\n${m.content ?? ""}`);
  }
  const others = Object.entries(row).filter(([k]) => k !== "messages");
  if (others.length > 0) {
    parts.push(`## (other fields)\n\n\`\`\`json\n${JSON.stringify(Object.fromEntries(others), null, 2)}\n\`\`\``);
  }
  return parts.join("\n\n");
}

function OtherFields({ row, hide }: { row: Record<string, any>; hide?: string[] }) {
  const hidden = new Set<string>(["messages", ...(hide ?? [])]);
  const others = Object.entries(row).filter(([k]) => !hidden.has(k));
  if (others.length === 0) return null;
  return (
    <details className="text-[11px] text-zinc-500 mt-3">
      <summary
        onClick={(e) => e.stopPropagation()}
        className="cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300 select-none font-mono"
      >
        other fields ({others.length})
      </summary>
      <pre
        onClick={(e) => e.stopPropagation()}
        className="mt-1 p-2 rounded-sm bg-zinc-100/60 dark:bg-zinc-900/60 overflow-x-auto whitespace-pre-wrap font-mono"
      >
        {JSON.stringify(Object.fromEntries(others), null, 2)}
      </pre>
    </details>
  );
}

/** One row in the skim list. Compact caption, content gets full width. */
function RowBlock({
  row,
  idx,
  datasetPath,
  active,
  onSelect,
  defaultRaw,
  pinnedFields,
}: {
  row: Record<string, any>;
  idx: number;
  datasetPath: string;
  active: boolean;
  onSelect: () => void;
  defaultRaw: boolean;
  pinnedFields: string[];
}) {
  const messages = getMessages(row);
  const pin = usePinHandler();
  const [raw, toggleRaw] = useRawOverride(`row::${datasetPath}::${idx}`, defaultRaw);
  return (
    <article
      onClick={(e) => {
        if (pin(e, { kind: "row", path: datasetPath, idx, snapshot: JSON.stringify(row, null, 2).slice(0, 4000) })) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
        onSelect();
      }}
      title="shift+click to pin to chat"
      className={cn(
        "relative px-6 py-5 border-t border-zinc-200/60 dark:border-zinc-800/70 cursor-default group",
        active && "bg-emerald-50/40 dark:bg-emerald-500/[0.04]",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-5 bottom-5 w-[3px] bg-emerald-500 rounded-r-sm"
        />
      )}
      <header className="flex items-center mb-2 text-[11px] font-mono">
        <span
          className={cn(
            "tabular-nums tracking-wider select-none",
            active
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-zinc-500",
          )}
        >
          row {idx}
        </span>
        <span className="ml-3 text-zinc-400 dark:text-zinc-600">
          {messages.length} message{messages.length === 1 ? "" : "s"}
        </span>
        <div
          className="ml-auto flex items-center gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <MarkInline path={datasetPath} idx={idx} />
          <CopyButton variant="markdown" value={() => rowToMarkdown(row)} title="copy conversation (markdown)" />
          <CopyButton variant="json" value={() => JSON.stringify(row, null, 2)} title="copy row JSON" />
          <RawJsonToggle value={raw} onChange={toggleRaw} title={raw ? "show parsed row" : "show raw row JSON"} />
        </div>
      </header>
      {raw ? (
        <pre
          onClick={(e) => e.stopPropagation()}
          className="text-xs font-mono whitespace-pre-wrap p-3 rounded-sm bg-zinc-100/70 dark:bg-zinc-900/70 text-zinc-800 dark:text-zinc-200 overflow-x-auto"
        >
          {JSON.stringify(row, null, 2)}
        </pre>
      ) : (
        <div>
          <PinnedFields row={row} fields={pinnedFields} />
          {messages.map((m, i) => (
            <MessageBlock
              key={i}
              msg={m}
              msgIdx={i}
              row={row}
              datasetPath={datasetPath}
              rowIdx={idx}
              defaultRaw={defaultRaw}
            />
          ))}
          <OtherFields row={row} hide={pinnedFields} />
        </div>
      )}
    </article>
  );
}

function ListMode({ datasetPath, defaultRaw, pinnedFields }: {
  datasetPath: string; defaultRaw: boolean; pinnedFields: string[];
}) {
  const v = useViewerState();
  const parentRef = useRef<HTMLDivElement>(null);

  const { data: page } = useRowPage("chat-list", { limit: PAGE });

  const rows = page?.rows ?? [];
  const indices = page?.indices ?? [];

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 240,
    overscan: 4,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
      <div
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const r = rows[vi.index];
          const idx = indices[vi.index];
          return (
            <div
              key={vi.key}
              ref={virtualizer.measureElement}
              data-index={vi.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <RowBlock
                row={r}
                idx={idx}
                datasetPath={datasetPath}
                active={idx === v.row_idx}
                onSelect={() => api.goto(idx)}
                defaultRaw={defaultRaw}
                pinnedFields={pinnedFields}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SingleMode({ datasetPath, defaultRaw, pinnedFields }: {
  datasetPath: string; defaultRaw: boolean; pinnedFields: string[];
}) {
  const v = useViewerState();
  const [raw, toggleRaw] = useRawOverride(`row::${datasetPath}::${v.row_idx}`, defaultRaw);

  const { data: page } = useRowPage("chat-single", { offset: v.row_idx, limit: 1 });

  const row = page?.rows[0];
  const realIdx = page?.indices[0];
  const messages = useMemo(() => getMessages(row), [row]);

  if (!row) {
    return <div className="p-12 text-zinc-500 text-sm">loading row…</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex items-center gap-3 px-6 pt-5 pb-3 text-[11px] font-mono border-b border-zinc-200/60 dark:border-zinc-800/70">
        <span className="tabular-nums tracking-wider text-emerald-600 dark:text-emerald-400">
          row {v.row_idx}
        </span>
        {realIdx != null && realIdx !== v.row_idx && (
          <span className="text-zinc-500">orig {realIdx}</span>
        )}
        <span className="text-zinc-400 dark:text-zinc-600">
          {messages.length} message{messages.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <MarkInline path={datasetPath} idx={v.row_idx} />
          <CopyButton variant="markdown" value={() => rowToMarkdown(row)} title="copy conversation (markdown)" />
          <CopyButton variant="json" value={() => JSON.stringify(row, null, 2)} title="copy row JSON" />
          <RawJsonToggle value={raw} onChange={toggleRaw} title={raw ? "show parsed row" : "show raw row JSON"} />
        </div>
      </header>
      <div className="px-6 py-5 max-w-4xl">
        {raw ? (
          <pre className="text-xs font-mono whitespace-pre-wrap p-3 rounded-sm bg-zinc-100/70 dark:bg-zinc-900/70 text-zinc-800 dark:text-zinc-200 overflow-x-auto">
            {JSON.stringify(row, null, 2)}
          </pre>
        ) : (
          <>
            <PinnedFields row={row} fields={pinnedFields} />
            {messages.map((m, i) => (
              <MessageBlock
                key={i}
                msg={m}
                msgIdx={i}
                row={row}
                datasetPath={datasetPath}
                rowIdx={v.row_idx}
                defaultRaw={defaultRaw}
              />
            ))}
            <OtherFields row={row} hide={pinnedFields} />
          </>
        )}
      </div>
    </div>
  );
}

function ModeToggle({
  value,
  onChange,
}: {
  value: "list" | "single";
  onChange: (v: "list" | "single") => void;
}) {
  return (
    <div className="inline-flex text-[10px] font-mono uppercase tracking-wider border border-zinc-200 dark:border-zinc-800 rounded-sm overflow-hidden">
      {(["list", "single"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={cn(
            "px-2 py-0.5 transition-colors",
            value === m
              ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export default function ChatRowView() {
  const v = useViewerState();
  const { url, setViewMode, setRaw } = useUrlSync();
  const [defaultExpand, setDefaultExpand] = usePref<boolean>("defaultExpand", false);
  // Per-dataset pinned metadata fields. Same prefs plumbing as everything else —
  // the CLI's `viewer fields …` commands write to the same key directly.
  const [pinnedFields, setPinnedFields] = usePref<string[]>(
    v.dataset_path ? pinnedFieldsKey(v.dataset_path) : "pinnedFields::__none__",
    [],
  );
  const [pinPickerOpen, setPinPickerOpen] = useState(false);

  if (!v.dataset_path) {
    return <div className="p-12 text-zinc-500 text-sm">no dataset</div>;
  }

  // Available columns to pin = every scalar field DuckDB inferred MINUS
  // `messages` and the synthetic `__idx`. Keep the list deterministic so
  // the dropdown ordering doesn't shuffle on each render.
  const pinnableColumns = (v.columns ?? [])
    .filter((c) => c !== "messages" && c !== "__idx")
    .slice()
    .sort();

  const mode = url.viewMode;
  return (
    <div className="h-full flex flex-col bg-zinc-50 dark:bg-zinc-950">
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-zinc-200/60 dark:border-zinc-800/70 text-[11px] font-mono text-zinc-500">
        {mode === "list" && <ListCount />}
        <button
          onClick={() => setPinPickerOpen((o) => !o)}
          title="pin metadata fields to show above each row"
          className={cn(
            "ml-auto p-1 rounded flex items-center gap-1 transition-colors",
            (pinnedFields.length > 0 || pinPickerOpen)
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          <Pin size={12} />
          {pinnedFields.length > 0 && (
            <span className="tabular-nums">{pinnedFields.length}</span>
          )}
        </button>
        <button
          onClick={() => setDefaultExpand(!defaultExpand)}
          title={defaultExpand ? "default-expand on (click to collapse all)" : "default-expand off (click to expand all by default)"}
          className={cn(
            "p-1 rounded transition-colors",
            defaultExpand
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
          )}
        >
          {defaultExpand ? <ChevronsDown size={13} /> : <ChevronsRight size={13} />}
        </button>
        <RawJsonToggle value={url.raw} onChange={setRaw} title={url.raw ? "show parsed messages" : "show raw JSON for every row"} />
        <ModeToggle value={mode} onChange={setViewMode} />
      </div>
      {pinPickerOpen && (
        <div className="px-4 py-2 border-b border-zinc-200/60 dark:border-zinc-800/70 bg-amber-500/5">
          <div className="flex items-center gap-2 mb-1.5 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300">
            <Pin size={10} />
            pin fields to show above each row
            <span className="text-zinc-500 normal-case tracking-normal lowercase">
              (also: <code>viewer fields add &lt;col&gt;</code>)
            </span>
          </div>
          <MultiSelectChips
            options={pinnableColumns}
            value={pinnedFields}
            onChange={setPinnedFields}
            placeholder="type a column name…"
            emptyMessage="no more columns to pin"
          />
        </div>
      )}
      <div className="flex-1 min-h-0" key={`${defaultExpand}`}>
        {mode === "list" ? (
          <ListMode datasetPath={v.dataset_path} defaultRaw={url.raw} pinnedFields={pinnedFields} />
        ) : (
          <SingleMode datasetPath={v.dataset_path} defaultRaw={url.raw} pinnedFields={pinnedFields} />
        )}
      </div>
    </div>
  );
}

/** Inline counter for the toolbar — shares the list page query's cache via the
 *  identical `useRowPage("chat-list", …)` key, so TanStack dedupes to one fetch. */
function ListCount() {
  const { data } = useRowPage("chat-list", { limit: PAGE });
  const page = data as { rows: any[]; total_filtered: number } | undefined;
  return (
    <span className="ml-auto tabular-nums">
      {page ? `${page.rows.length} of ${page.total_filtered}` : "…"}
    </span>
  );
}
