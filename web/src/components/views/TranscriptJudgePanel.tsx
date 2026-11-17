// Right pane of the transcript view: each judge model's verdict, analysis and
// incidents for the open session, plus the reader's own labels on them.
// Incident fields are rendered by shape (`*_event_ids` → event chips, `*_quote`
// → quotes, small scalars → chips, long strings → prose), so a rubric revision
// that adds or renames a field still shows up without a code change.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useViewerState } from "../../lib/state";
import { Check, X, HelpCircle, Link as LinkIcon, ChevronRight } from "lucide-react";
import { api } from "../../lib/api";
import { cn, copyToClipboard } from "../../lib/utils";
import { JUDGE_COLORS, ROLE_COLORS, judgeShort } from "./transcriptEvents";

export type JudgeRow = Record<string, any> & { __idx: number; judge_model?: string };
export type Selection = { judge: number; item: string } | null;
export type LabelRec = Record<string, any>;

type PanelProps = {
  judges: JudgeRow[];
  sel: Selection;
  onSelect: (judge: number, item: string) => void;
  onSelectEvent: (idx: number) => void;
  linkFor: (judge: number, item: string) => string;
  labels: LabelRec[];
  labelsFile: string | null;
  saveLabel: (rec: LabelRec) => void;
  sessionId: string;
  path: string;
  /** Pinned tab: controls that move the shared view are left out. */
  pinned: boolean;
  currentRowIdx: number;
};

const ROW_HIDDEN = new Set([
  "__idx", "session_id", "judge_model", "incidents", "considered_not_flagged", "scope_notes",
  "thought_of_the_rater", "raw_response", "verdict", "session_path",
]);
const SCALES = ["out_of_scope", "severity", "disclosure"];

function verdictCls(v: unknown): string {
  switch (v) {
    case "flagged": return "bg-red-600 text-white border-red-600";
    case "none": return "border-emerald-600 text-emerald-700 dark:text-emerald-400";
    case "minor_only": return "border-yellow-500 text-yellow-700 dark:text-yellow-400";
    default: return "border-amber-500 text-amber-700 dark:text-amber-400";
  }
}

/** Top of each 1..max scale; a scale not listed is taken as 1-3. */
const SCALE_MAX: Record<string, number> = { severity: 5 };
const LEVEL_CLS = [
  "border-zinc-400 text-zinc-600 dark:text-zinc-300",                       // lowest
  "border-yellow-500 bg-yellow-200 text-yellow-950",
  "border-orange-500 bg-orange-500 text-white",
  "border-red-600 bg-red-600 text-white",
  "border-fuchsia-950 bg-fuchsia-950 text-white font-semibold",             // highest
];

/** One class per level, spread over the ramp so the top of a 3-level scale
 *  looks like the top of a 5-level one. */
function scaleCls(key: string, n: unknown): string {
  const max = SCALE_MAX[key] ?? 3;
  if (typeof n !== "number") return LEVEL_CLS[0];
  const frac = max > 1 ? (Math.min(max, Math.max(1, n)) - 1) / (max - 1) : 0;
  const at = max === 3 ? [0, 2, 3][Math.round(frac * 2)] : Math.round(frac * (LEVEL_CLS.length - 1));
  return LEVEL_CLS[at];
}

function Chip({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-block rounded border px-1.5 py-px text-[11px] leading-4 whitespace-nowrap", className)}>
      {children}
    </span>
  );
}

function EvChips({ ids, color, onSelectEvent, label }: {
  ids: unknown; color: string; onSelectEvent: (idx: number) => void; label?: string;
}) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {label && <span className="text-[11px] text-zinc-500">{label}</span>}
      {ids.map((id) => (
        <button
          key={String(id)}
          onClick={(e) => { e.stopPropagation(); onSelectEvent(Number(id)); }}
          title={`go to event ${id}`}
          className="rounded border px-1 py-px font-mono text-[11px] leading-4 hover:brightness-90"
          style={{ borderColor: color, color }}
        >
          E{String(id)}
        </button>
      ))}
    </span>
  );
}

function Prose({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-200">{text}</div>
    </div>
  );
}

function Quote({ label, text, color }: { label: string; text: string; color: string }) {
  return (
    <div className="border-l-2 pl-2" style={{ borderColor: color }}>
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="whitespace-pre-wrap text-[12.5px] leading-snug text-zinc-700 dark:text-zinc-300">{text}</div>
    </div>
  );
}

const pretty = (k: string) => k.replace(/_/g, " ");

type Legend = Record<string, { about?: string; values: Record<string, { name?: string | null; text: string }> }>;
/** What each value of an incident field means (the run's own rubric). */
const LegendCtx = createContext<Legend>({});
const useLevelName = (field: string, value: unknown): string | null =>
  useContext(LegendCtx)[field]?.values[String(value)]?.name ?? null;

/**
 * Hovering the wrapped chip shows what its value means: for a numeric scale,
 * every level with the current one marked; for a category, that category's
 * definition. Renders the children alone when the rubric says nothing.
 */
function Hint({ field, value, children }: { field: string; value: unknown; children: React.ReactNode }) {
  const entry = useContext(LegendCtx)[field];
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const key = String(value);
  if (!entry || !(key in entry.values)) return <>{children}</>;
  const levels = Object.entries(entry.values);
  const isScale = levels.every(([k]) => /^\d+$/.test(k));
  return (
    <span
      className="inline-flex min-w-0"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const left = Math.max(8, Math.min(r.left, window.innerWidth - 408));
        // Below the chip, or above it when the lower half of the window is short.
        setPos(r.bottom > window.innerHeight * 0.55
          ? { left, bottom: window.innerHeight - r.top + 6 }
          : { left, top: r.bottom + 6 });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <div
          style={pos}
          className="pointer-events-none fixed z-50 w-[400px] space-y-1 rounded border border-zinc-300 bg-white p-2.5 text-left text-[12.5px] font-normal leading-snug text-zinc-800 shadow-lg whitespace-normal dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        >
          <div className="font-semibold">{pretty(field)}</div>
          {entry.about && <div className="text-zinc-600 dark:text-zinc-400">{entry.about}</div>}
          {isScale ? levels.map(([k, lv]) => (
            <div
              key={k}
              className={cn("rounded px-1.5 py-0.5", k === key ? "bg-sky-100 dark:bg-sky-900/50" : "text-zinc-600 dark:text-zinc-400")}
            >
              <b>{k}{lv.name ? `, ${lv.name}` : ""}</b>: {lv.text}
            </div>
          )) : (
            <div><b>{pretty(key)}</b>: {entry.values[key].text}</div>
          )}
        </div>
      )}
    </span>
  );
}

/** A 1..max scale value as a chip coloured by level, named when the rubric names it. */
function ScaleChip({ field, value }: { field: string; value: unknown }) {
  const name = useLevelName(field, value);
  return (
    <Hint field={field} value={value}>
      <Chip className={scaleCls(field, value)}>
        {pretty(field)} {String(value)}{name ? ` · ${name}` : `/${SCALE_MAX[field] ?? 3}`}
      </Chip>
    </Hint>
  );
}

/** correct / wrong / unsure toggle + a note; saves on click and on note blur. */
function LabelRow({ value, note, onChange, hints }: {
  value: string | null; note: string;
  onChange: (label: string | null, note: string) => void;
  hints: [string, string, string];
}) {
  const [draft, setDraft] = useState(note);
  useEffect(() => setDraft(note), [note]);
  const btn = (key: string, icon: React.ReactNode, on: string, hint: string) => (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(value === key ? null : key, draft); }}
      title={hint}
      className={cn(
        "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11.5px]",
        value === key ? on : "border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800",
      )}
    >
      {icon}{key}
    </button>
  );
  return (
    <div className="flex items-center gap-1.5 pt-1" onClick={(e) => e.stopPropagation()}>
      {btn("correct", <Check size={12} />, "bg-emerald-600 border-emerald-600 text-white", hints[0])}
      {btn("wrong", <X size={12} />, "bg-red-600 border-red-600 text-white", hints[1])}
      {btn("unsure", <HelpCircle size={12} />, "bg-zinc-600 border-zinc-600 text-white", hints[2])}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== note) onChange(value, draft); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        placeholder="note"
        className="min-w-0 flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-1.5 py-0.5 text-[12px]"
      />
    </div>
  );
}

function CopyLink({ href }: { href: () => string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyToClipboard(href())) { setOk(true); setTimeout(() => setOk(false), 1200); }
      }}
      title="copy a link to this incident"
      className={cn("rounded p-0.5", ok ? "text-emerald-600" : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200")}
    >
      {ok ? <Check size={13} /> : <LinkIcon size={13} />}
    </button>
  );
}

function Fold({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
        {title}
      </button>
      {open && <div className="pt-1">{children}</div>}
    </div>
  );
}

/** Two incidents are about the same act when their action events are within
 *  2 events of each other (one judge cites the tool call, the other its result). */
function overlaps(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.some((x) => b.some((y) => typeof x === "number" && typeof y === "number" && Math.abs(x - y) <= 2));
}

/** Both judges' incidents on one grid, one line per act: a line with an empty
 *  cell is something only one judge flagged. */
function labelGlyph(labels: LabelRec[], model: string, idx: number): string {
  const l = labels.find((x) => x.kind === "incident" && x.judge_model === model && x.incident_idx === idx)?.label;
  return l === "correct" ? "✓ " : l === "wrong" ? "✗ " : l === "unsure" ? "? " : "";
}

type Scope = "incidents" | "firm" | "open_firm" | "open";
/** Row filters offered by the panel; each is applied as an SQL selection whose
 *  trailing comment names it (that is how the select reads it back). */
const SCOPES: { key: Scope; label: string; rows: (d: ProgressData) => number[] }[] = [
  { key: "incidents", label: "with incidents", rows: (d) => d.incident_rows },
  { key: "firm", label: "with firm incidents", rows: (d) => d.firm_rows },
  { key: "open_firm", label: "with unlabelled firm incidents", rows: (d) => d.unlabelled_firm_rows },
  { key: "open", label: "with unlabelled incidents", rows: (d) => d.unlabelled_rows },
];
type ProgressData = Awaited<ReturnType<typeof api.transcriptProgress>>;

/** Labelled / total counts for the open file, and a row filter (sessions with
 *  incidents, or with incidents still to label), applied as an SQL selection
 *  so it is in the URL. */
function Progress({ path, currentRowIdx, pinned }: { path: string; currentRowIdx: number; pinned: boolean }) {
  const v = useViewerState();
  const { data } = useQuery({ queryKey: ["transcript-progress", path], queryFn: () => api.transcriptProgress(path) });
  if (!data) return null;
  const q = v.sql_mode === "selection" ? (v.sql_query ?? "") : "";
  const scope = SCOPES.find((x) => q.endsWith(`-- ${x.label}`))?.key ?? (q ? "custom" : "all");
  const apply = async (next: string) => {
    const sc = SCOPES.find((x) => x.key === next);
    if (!sc) {
      await api.sqlApply("off");
      await api.goto(currentRowIdx);
      return;
    }
    const rows = sc.rows(data) ?? [];
    await api.sqlApply("selection", `SELECT __idx FROM t WHERE __idx IN (${rows.length ? rows.join(",") : "-1"}) -- ${sc.label}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
      <span title={`firm = ${data.firm_rule}`} className="tabular-nums text-zinc-700 dark:text-zinc-300">
        labelled <b>{data.firm_labelled}/{data.firm}</b> firm incidents
        <span className="text-zinc-500"> · {data.labelled}/{data.incidents} all</span>
      </span>
      {!pinned && <label className="flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
        rows
        <select
          value={scope}
          onChange={(e) => apply(e.target.value)}
          title="filter the rows (sessions × judge); the list is fixed when picked, pick again to refresh"
          className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-1 py-px text-[12px] text-zinc-800 dark:text-zinc-200"
        >
          <option value="all">all</option>
          {SCOPES.map((x) => (
            <option key={x.key} value={x.key}>{x.label} ({(x.rows(data) ?? []).length})</option>
          ))}
          {scope === "custom" && <option value="custom">custom SQL selection</option>}
        </select>
      </label>}
    </div>
  );
}

function Overview({ judges, sel, onSelect, labels }: { judges: JudgeRow[]; sel: Selection; onSelect: (judge: number, item: string) => void; labels: LabelRec[] }) {
  type Cell = { judge: number; item: string; inc: any };
  const cells: Cell[] = judges.flatMap((j, ji) =>
    (Array.isArray(j.incidents) ? j.incidents : []).map((inc: any, i: number) => ({ judge: ji, item: String(i), inc })));
  // Union-find over "cites nearby events": the grouping can't depend on order.
  const parent = cells.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  cells.forEach((a, i) => cells.forEach((b, k) => {
    if (k > i && overlaps(a.inc?.event_ids, b.inc?.event_ids)) parent[find(i)] = find(k);
  }));
  const byRoot = new Map<number, { first: number; cells: Cell[] }>();
  cells.forEach((c, i) => {
    const g = byRoot.get(find(i)) ?? { first: Infinity, cells: [] };
    g.cells.push(c);
    g.first = Math.min(g.first, ...(Array.isArray(c.inc?.event_ids) ? c.inc.event_ids : []));
    byRoot.set(find(i), g);
  });
  const clusters = [...byRoot.values()];
  clusters.sort((a, b) => a.first - b.first);
  return (
    <div
      className="grid items-center gap-x-2 gap-y-1 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 text-[12px]"
      style={{ gridTemplateColumns: `max-content repeat(${Math.max(1, judges.length)}, minmax(0, 1fr))` }}
    >
      <span />
      {judges.map((j, ji) => (
        <span key={ji} className="flex min-w-0 flex-wrap items-center gap-1 border-l-[3px] pl-1.5" style={{ borderColor: JUDGE_COLORS[ji % JUDGE_COLORS.length] }}>
          <span className="truncate font-semibold text-zinc-900 dark:text-zinc-100" title={String(j.judge_model)}>{judgeShort(String(j.judge_model ?? ""))}</span>
          {j.verdict != null && <Chip className={verdictCls(j.verdict)}>{pretty(String(j.verdict))}</Chip>}
        </span>
      ))}
      {clusters.map((c, ci) => (
        <div key={ci} className="contents">
          <span className="font-mono text-[11px] text-zinc-500">{Number.isFinite(c.first) ? `E${c.first}` : ""}</span>
          {judges.map((_, ji) => {
            const cells = c.cells.filter((x) => x.judge === ji);
            if (!cells.length) return <span key={ji} className="pl-2 text-zinc-400">not flagged</span>;
            return (
              <span key={ji} className="flex min-w-0 flex-wrap gap-1">
                {cells.map((x) => {
                  const on = sel?.judge === x.judge && sel.item === x.item;
                  const color = JUDGE_COLORS[ji % JUDGE_COLORS.length];
                  return (
                    <button
                      key={x.item}
                      onClick={() => onSelect(x.judge, x.item)}
                      title="show this incident"
                      className="flex min-w-0 max-w-full items-center rounded border px-1.5 py-px text-left"
                      style={{ borderColor: color, background: on ? color : "transparent", color: on ? "#fff" : undefined }}
                    >
                      <span className="min-w-0 truncate">
                        {labelGlyph(labels, String(judges[x.judge]?.judge_model), Number(x.item))}
                        #{x.item} {pretty(String(x.inc?.category ?? ""))}
                      </span>
                      {x.inc?.severity != null && (
                        <Hint field="severity" value={x.inc.severity}>
                          <span className={cn("ml-1 shrink-0 rounded border px-1 text-[10.5px] whitespace-nowrap", scaleCls("severity", x.inc.severity))}>
                            sev {String(x.inc.severity)}
                          </span>
                        </Hint>
                      )}
                    </button>
                  );
                })}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function TranscriptJudgePanel(p: PanelProps) {
  const { judges, labels } = p;
  const verdicts = judges.map((j) => String(j.verdict ?? ""));
  const disagree = judges.length > 1 && new Set(verdicts).size > 1;
  const session = labels.find((l) => l.kind === "session") ?? {};
  const missedIds: number[] = Array.isArray(session.missed_event_ids) ? session.missed_event_ids : [];
  const [note, setNote] = useState<string>(session.note ?? "");
  useEffect(() => setNote(session.note ?? ""), [session.note, p.sessionId]);
  const saveSession = (patch: LabelRec) =>
    p.saveLabel({
      kind: "session", session_id: p.sessionId, rubric_version: judges[0]?.rubric_version ?? null,
      missed: !!session.missed, missed_event_ids: missedIds, note: session.note ?? "",
      ...patch,
    });

  const legendQ = useQuery({
    queryKey: ["transcript-legend", p.path],
    queryFn: () => api.transcriptLegend(p.path),
    staleTime: Infinity,
  });

  return (
    <LegendCtx.Provider value={legendQ.data?.legend ?? NO_LEGEND}>
    <div className="h-full overflow-y-auto overflow-x-hidden break-words text-[13px]" data-transcript-panel>
      <div className="border-b border-zinc-200 dark:border-zinc-800 px-3 py-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">your review</span>
          {disagree && <Chip className="border-rose-500 text-rose-600 dark:text-rose-400">judges disagree</Chip>}
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!session.missed}
            onChange={(e) => saveSession({ missed: e.target.checked })}
          />
          <span>the judges missed something</span>
        </label>
        {missedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[11px] text-zinc-500">missed at</span>
            <EvChips ids={missedIds} color="#d97706" onSelectEvent={p.onSelectEvent} />
          </div>
        )}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if (note !== (session.note ?? "")) saveSession({ note }); }}
          placeholder="note on this session (flag a missed event with the ⚑ on its row)"
          rows={2}
          className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-1.5 py-1 text-[12.5px]"
        />
        <Progress path={p.path} currentRowIdx={p.currentRowIdx} pinned={p.pinned} />
        {p.labelsFile && (
          <div className="text-[11px] text-zinc-500 break-all" title="labels are appended here; the last line per incident wins">
            saved to {p.labelsFile}
          </div>
        )}
      </div>

      {judges.length === 0 && <div className="p-3 text-zinc-500">no judgment rows for this session</div>}
      {judges.length > 0 && <Overview judges={judges} sel={p.sel} onSelect={p.onSelect} labels={labels} />}
      {judges.map((j, ji) => (
        <JudgeSection key={j.__idx} j={j} ji={ji} others={judges} p={p} />
      ))}
    </div>
    </LegendCtx.Provider>
  );
}

const NO_LEGEND: Legend = {};

function JudgeSection({ j, ji, others, p }: { j: JudgeRow; ji: number; others: JudgeRow[]; p: PanelProps }) {
  const color = JUDGE_COLORS[ji % JUDGE_COLORS.length];
  const model = String(j.judge_model ?? `judge ${ji}`);
  const incidents: any[] = Array.isArray(j.incidents) ? j.incidents : [];
  const considered: any[] = Array.isArray(j.considered_not_flagged) ? j.considered_not_flagged : [];
  const extra = Object.keys(j).filter((k) => !ROW_HIDDEN.has(k) && (typeof j[k] !== "object" || j[k] === null));
  const labelOf = (kind: string, idx: number) =>
    p.labels.find((l) => l.kind === kind && l.judge_model === model && l[`${kind}_idx`] === idx);

  return (
    <section className="border-b border-zinc-200 dark:border-zinc-800">
      <div
        className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 px-3 py-1.5"
        style={{ boxShadow: `inset 4px 0 0 ${color}` }}
      >
        <span className="font-semibold text-zinc-900 dark:text-zinc-100" title={model}>{judgeShort(model)}</span>
        {j.verdict != null && <Chip className={verdictCls(j.verdict)}>{pretty(String(j.verdict))}</Chip>}
        {j.assessable != null && j.assessable !== "yes" && (
          <Chip className="border-zinc-400 text-zinc-600 dark:text-zinc-300">{pretty(String(j.assessable))}</Chip>
        )}
        {j.parse_ok === false && <Chip className="bg-red-600 border-red-600 text-white">parse failed</Chip>}
        <span className="text-[11.5px] text-zinc-500">{incidents.length} incident{incidents.length === 1 ? "" : "s"}</span>
        <button
          onClick={() => { if (!p.pinned) api.goto(j.__idx); }}
          disabled={p.pinned}
          title="open this judge's row (the table and raw views show that row)"
          className={cn(
            "ml-auto rounded px-1 font-mono text-[11px]",
            j.__idx === p.currentRowIdx ? "text-zinc-800 dark:text-zinc-200 font-semibold" : "text-zinc-500 hover:text-sky-600",
          )}
        >
          row {j.__idx}
        </button>
      </div>

      <div className="px-3 py-2 space-y-2">
        {typeof j.scope_notes === "string" && j.scope_notes && <Prose label="what the human asked" text={j.scope_notes} />}
        {typeof j.analysis === "string" && j.analysis && <Prose label="analysis" text={j.analysis} />}
        {typeof j.thought_of_the_rater === "string" && j.thought_of_the_rater && (
          <Prose label="judge's own note" text={j.thought_of_the_rater} />
        )}

        {incidents.map((inc, i) => {
          const item = String(i);
          const selected = p.sel?.judge === ji && p.sel.item === item;
          const lab = labelOf("incident", i);
          const also = others.flatMap((o, oi) => {
            if (oi === ji) return [];
            const hits = (Array.isArray(o.incidents) ? o.incidents : []).flatMap((x: any, xi: number) =>
              overlaps(x?.event_ids, inc?.event_ids) ? [`#${xi}`] : []);
            return hits.length ? [`${judgeShort(String(o.judge_model))} ${hits.join(" ")}`] : [];
          });
          return (
            <IncidentCard
              key={i}
              title={`#${i}`}
              inc={inc}
              color={color}
              selected={selected}
              onSelect={() => p.onSelect(ji, item)}
              onSelectEvent={p.onSelectEvent}
              link={() => p.linkFor(ji, item)}
              agreement={others.length > 1 ? (also.length ? `also ${also.join(", ")}` : `only ${judgeShort(model)}`) : null}
              agreed={also.length > 0}
              label={lab}
              hints={["a real overeager action", "not overeager, or misdescribed", "can't tell"]}
              onLabel={(label, note) =>
                p.saveLabel({
                  kind: "incident", session_id: p.sessionId, judge_model: model,
                  rubric_version: j.rubric_version ?? null, incident_idx: i,
                  event_ids: inc?.event_ids ?? [], category: inc?.category ?? null,
                  severity: inc?.severity ?? null, label, note,
                })}
            />
          );
        })}

        {considered.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
              considered, not flagged ({considered.length})
            </div>
            {considered.map((c, i) => {
              const item = `n${i}`;
              const lab = labelOf("considered", i);
              return (
                <IncidentCard
                  key={i}
                  title={`not flagged #${i}`}
                  inc={c}
                  color={ROLE_COLORS.considered!}
                  dim
                  selected={p.sel?.judge === ji && p.sel.item === item}
                  onSelect={() => p.onSelect(ji, item)}
                  onSelectEvent={p.onSelectEvent}
                  link={() => p.linkFor(ji, item)}
                  agreement={null}
                  agreed={false}
                  label={lab}
                  hints={["right not to flag it", "should have been flagged", "can't tell"]}
                  onLabel={(label, note) =>
                    p.saveLabel({
                      kind: "considered", session_id: p.sessionId, judge_model: model,
                      rubric_version: j.rubric_version ?? null, considered_idx: i,
                      event_ids: c?.event_ids ?? [], label, note,
                    })}
                />
              );
            })}
          </div>
        )}

        {extra.length > 0 && (
          <Fold title="row fields">
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px]">
              {extra.map((k) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{pretty(k)}</dt>
                  <dd className="break-all text-zinc-800 dark:text-zinc-200">{String(j[k])}</dd>
                </div>
              ))}
            </dl>
          </Fold>
        )}
        {typeof j.raw_response === "string" && j.raw_response && (
          <Fold title="raw judge response">
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-zinc-700 dark:text-zinc-300">{j.raw_response}</pre>
          </Fold>
        )}
      </div>
    </section>
  );
}

function IncidentCard(c: {
  title: string; inc: any; color: string; dim?: boolean; selected: boolean;
  onSelect: () => void; onSelectEvent: (idx: number) => void; link: () => string;
  agreement: string | null; agreed: boolean;
  label: LabelRec | undefined; hints: [string, string, string];
  onLabel: (label: string | null, note: string) => void;
}) {
  const inc = c.inc && typeof c.inc === "object" ? c.inc : {};
  const keys = Object.keys(inc);
  const idKeys = keys.filter((k) => k.endsWith("event_ids") && k !== "event_ids");
  const quoteKeys = keys.filter((k) => k.endsWith("_quote") || k === "quotes");
  const used = new Set(["event_ids", "category", ...SCALES, ...idKeys, ...quoteKeys]);
  const chipKeys = keys.filter((k) => !used.has(k) && (typeof inc[k] === "number" || typeof inc[k] === "boolean"
    || (typeof inc[k] === "string" && inc[k].length <= 32 && !inc[k].includes(" "))));
  const proseKeys = keys.filter((k) => !used.has(k) && !chipKeys.includes(k) && typeof inc[k] === "string" && inc[k]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (c.selected) ref.current?.scrollIntoView({ block: "nearest" }); }, [c.selected]);
  const idColor = (k: string) =>
    k.startsWith("request") ? ROLE_COLORS.request! : k.startsWith("reaction") ? ROLE_COLORS.reaction! : "#71717a";

  return (
    <div
      ref={ref}
      onClick={c.onSelect}
      data-incident-selected={c.selected || undefined}
      className={cn(
        "cursor-pointer rounded border px-2 py-1.5 space-y-1.5",
        c.dim ? "border-dashed border-zinc-300 dark:border-zinc-700" : "border-zinc-300 dark:border-zinc-700",
        c.selected ? "bg-zinc-100 dark:bg-zinc-900" : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50",
      )}
      style={c.selected ? { borderColor: c.color, boxShadow: `inset 3px 0 0 ${c.color}` } : undefined}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[12px] font-semibold" style={{ color: c.color }}>{c.title}</span>
        {inc.category != null && (
          <Hint field="category" value={inc.category}>
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">{pretty(String(inc.category))}</span>
          </Hint>
        )}
        {SCALES.filter((k) => inc[k] != null).map((k) => <ScaleChip key={k} field={k} value={inc[k]} />)}
        <span className="ml-auto flex min-w-0 items-center gap-1.5">
          {c.agreement && (
            <Chip className={cn("!whitespace-normal", c.agreed ? "border-emerald-600 text-emerald-700 dark:text-emerald-400" : "border-zinc-400 text-zinc-500")}>
              {c.agreement}
            </Chip>
          )}
          <CopyLink href={c.link} />
        </span>
      </div>
      {chipKeys.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chipKeys.map((k) => (
            <Hint key={k} field={k} value={inc[k]}>
              <Chip className="border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400">
                {pretty(k)}: {pretty(String(inc[k]))}
              </Chip>
            </Hint>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <EvChips ids={inc.event_ids} color={c.color} onSelectEvent={c.onSelectEvent} label={c.dim ? "at" : "action"} />
        {idKeys.map((k) => (
          <EvChips key={k} ids={inc[k]} color={idColor(k)} onSelectEvent={c.onSelectEvent} label={pretty(k.replace(/_?event_ids$/, ""))} />
        ))}
      </div>
      {proseKeys.map((k) => <Prose key={k} label={pretty(k)} text={inc[k]} />)}
      {quoteKeys.map((k) => {
        const val = inc[k];
        const texts: string[] = Array.isArray(val) ? val.map(String) : val ? [String(val)] : [];
        return texts.map((t, i) => (
          <Quote key={`${k}${i}`} label={pretty(k)} text={t} color={k.startsWith("request") ? ROLE_COLORS.request! : k.startsWith("reaction") ? ROLE_COLORS.reaction! : c.color} />
        ));
      })}
      <LabelRow
        value={c.label?.label ?? null}
        note={c.label?.note ?? ""}
        onChange={c.onLabel}
        hints={c.hints}
      />
    </div>
  );
}
