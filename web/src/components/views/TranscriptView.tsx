// Transcript view: one agent session read against the judges' incidents.
// The open dataset is a judgments JSONL (one row per session × judge model);
// the row picks the session, the session's events come from a separate
// `{session_id}.json` (api/routes/transcripts.py), and every judge's row for
// that session is shown side by side in the right pane.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, ExternalLink, Pin, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { parseComparison, useUrlSync, type FilterTriple } from "../../lib/url";
import { usePref } from "../../lib/prefs";
import { useRowPage, usePublishNav } from "../../lib/rowPage";
import { cn, copyToClipboard } from "../../lib/utils";
import {
  ClampStore, EventBlock, HUMAN_ACTION_SUBTYPES, judgeShort, refColor,
  type EventRef, type TEvent,
} from "./transcriptEvents";
import TranscriptJudgePanel, { type JudgeRow, type LabelRec, type Selection } from "./TranscriptJudgePanel";

type Mode = "open" | "fold" | "hide";
type ModeKey = "thinking" | "tool_call" | "tool_result" | "system";
const MODE_GROUPS: { key: ModeKey; label: string }[] = [
  { key: "thinking", label: "thinking" },
  { key: "tool_call", label: "tool calls" },
  { key: "tool_result", label: "results" },
  { key: "system", label: "system" },
];
const DEFAULT_MODES: Record<ModeKey, Mode> = { thinking: "fold", tool_call: "open", tool_result: "fold", system: "fold" };

/** Human actions are never hidden and open by default. */
const isHumanAction = (e: TEvent) => !!e.subtype && HUMAN_ACTION_SUBTYPES.has(e.subtype);

const NAV_LIMIT = 2000;

/** The per-row summary columns of a judgments file, i.e. the ones worth a
 *  filter control up front (the rest sit behind the filter bar's fold). */
export const isJudgmentSummaryColumn = (column: string): boolean =>
  /^(verdict|assessable|judge_model|agent|model|categories|judges_agree|other_judge_verdict|n_(firm_)?incidents|max_.*)$/.test(column);

export default function TranscriptView() {
  const v = useViewerState();
  const { url } = useUrlSync();
  // Pinned tab (`pin=<session id>`): the session and file come from this tab's
  // URL alone; nothing here reads or moves the shared view.
  const pinned = url.pin && url.path ? url.pin : null;
  const path = pinned ? url.path! : v.dataset_path!;

  // j/k step through the visible (filtered / sorted) rows.
  const { data: indexPage } = useRowPage("transcript-index", { limit: NAV_LIMIT, enabled: !pinned });
  usePublishNav(indexPage?.indices, !pinned);
  // A filter that excludes the open row: show the first row it keeps.
  useEffect(() => {
    if (pinned || !indexPage || indexPage.indices.length === 0) return;
    if (!indexPage.indices.includes(v.row_idx)) api.goto(indexPage.indices[0]).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexPage?.indices.join(",")]);

  const rowQ = useQuery({
    queryKey: ["transcript-row", path, v.row_idx],
    queryFn: () => api.row(path, v.row_idx),
    placeholderData: keepPreviousData,
    enabled: !pinned,
  });
  const row = pinned ? { session_id: pinned } : rowQ.data;
  const sid: string | null = typeof row?.session_id === "string" ? row.session_id : null;

  const sessQ = useQuery({
    queryKey: ["transcript-session", path, sid],
    queryFn: () => api.transcriptSession(path, sid!, row?.session_path),
    enabled: !!sid,
    staleTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const judgQ = useQuery({
    queryKey: ["transcript-judgments", path, sid],
    queryFn: () => api.transcriptJudgments(path, sid!),
    enabled: !!sid,
    placeholderData: keepPreviousData,
  });
  const labelsQ = useQuery({
    queryKey: ["transcript-labels", path, sid],
    queryFn: () => api.transcriptLabels(path, sid!),
    enabled: !!sid,
  });

  if (!pinned && indexPage && indexPage.total_filtered === 0 && (v.filters.length > 0 || v.sql_mode === "selection")) {
    return <div className="p-6 text-sm text-zinc-600 dark:text-zinc-400">No row matches the active filters.</div>;
  }
  if (rowQ.isError) return <div className="p-6 text-sm text-red-600">{String((rowQ.error as Error).message)}</div>;
  if (!row) return <div className="p-6 text-sm text-zinc-500">loading…</div>;
  if (!sid) return <div className="p-6 text-sm text-zinc-500">row {v.row_idx} has no session_id</div>;

  // Keep the previous session on screen until the next one has arrived, then
  // remount the body (its fold / focus state belongs to one session).
  const sessErr = sessQ.isError ? String((sessQ.error as Error).message) : null;
  const loaded = sessErr ? null : sessQ.data;
  if (!loaded && !sessErr) return <div className="p-6 text-sm text-zinc-500">loading session {sid.slice(0, 8)}…</div>;
  const shownSid: string = loaded ? String(loaded.session_id ?? sid) : sid;
  const judges = ((judgQ.data?.rows ?? []) as JudgeRow[])
    .filter((r) => r.session_id === shownSid)
    .sort((a, b) => String(a.judge_model ?? "").localeCompare(String(b.judge_model ?? "")));

  return (
    <TranscriptBody
      key={shownSid}
      path={path}
      sid={shownSid}
      session={loaded ?? null}
      sessionError={sessErr}
      judges={judges}
      judgesReady={judgQ.data != null && !judgQ.isPlaceholderData}
      labels={labelsQ.data?.labels ?? []}
      labelsFile={labelsQ.data?.file ?? null}
      currentRowIdx={pinned ? -1 : v.row_idx}
      sessionPath={(row as Record<string, any>).session_path ?? null}
      pinned={!!pinned}
    />
  );
}

/**
 * The row filters, read as filters on single incidents, so the panel lists the
 * incidents that made the row match. A row column maps to an incident field by
 * name: itself, minus a `max_` / `min_` prefix (`max_severity` → `severity`;
 * a longer suffix falls back to the field it starts with), or its singular
 * (`categories` → `category`). Filters on other columns are left out.
 */
function incidentMatcher(filters: FilterTriple[], judges: JudgeRow[]): ((inc: any) => boolean) | null {
  const fields = new Set<string>();
  judges.forEach((j) => (Array.isArray(j.incidents) ? j.incidents : []).forEach((inc: any) => {
    if (inc && typeof inc === "object") Object.keys(inc).forEach((k) => fields.add(k));
  }));
  const tests: ((inc: any) => boolean)[] = [];
  for (const [col, text, mode] of filters) {
    if (!col) continue;
    const base = col.replace(/^(max|min)_/, "");
    let field = [col, base, base.replace(/ies$/, "y"), base.replace(/s$/, "")].find((c) => fields.has(c));
    if (!field && base !== col) {
      field = [...fields].filter((f) => base.startsWith(f + "_")).sort((a, b) => b.length - a.length)[0];
    }
    if (!field) continue;
    const f = field;
    if (mode === "cmp") {
      const c = parseComparison(text);
      if (!c) continue;
      tests.push((inc) => {
        const x = Number(inc?.[f]);
        return c.op === ">=" ? x >= c.value : c.op === "<=" ? x <= c.value : c.op === ">" ? x > c.value
          : c.op === "<" ? x < c.value : c.op === "!=" ? x !== c.value : x === c.value;
      });
    } else if (mode === "exact") {
      tests.push((inc) => String(inc?.[f]) === text);
    } else if (mode === "text") {
      tests.push((inc) => String(inc?.[f] ?? "").toLowerCase().includes(text.toLowerCase()));
    } else {
      try {
        const re = new RegExp(text);
        tests.push((inc) => re.test(String(inc?.[f] ?? "")));
      } catch { /* invalid regex: the server ignores it too */ }
    }
  }
  return tests.length ? (inc) => tests.every((t) => t(inc)) : null;
}

function ids(x: unknown): number[] {
  return Array.isArray(x) ? x.filter((n) => typeof n === "number") : [];
}

function TranscriptBody(p: {
  path: string; sid: string; session: Record<string, any> | null; sessionError: string | null;
  judges: JudgeRow[]; judgesReady: boolean; labels: LabelRec[]; labelsFile: string | null;
  currentRowIdx: number; sessionPath: string | null; pinned: boolean;
}) {
  const { path, sid, judges } = p;
  const qc = useQueryClient();
  const { url, setTranscriptFocus, unpin } = useUrlSync();
  const sid8 = sid.slice(0, 8);

  // Events, with any server-clipped ones swapped for their full version once loaded.
  const [full, setFull] = useState<Map<number, TEvent>>(new Map());
  const events: TEvent[] = useMemo(() => {
    const base = (p.session?.events ?? []) as TEvent[];
    return full.size ? base.map((e) => full.get(e.idx) ?? e) : base;
  }, [p.session, full]);
  const loadFull = useCallback(async (idx: number) => {
    const ev = (await api.transcriptEvent(path, sid, idx, p.sessionPath)) as TEvent;
    setFull((m) => new Map(m).set(idx, ev));
  }, [path, sid, p.sessionPath]);

  // ── what the judges cite, per event ──
  const refsByEvent = useMemo(() => {
    const m = new Map<number, EventRef[]>();
    const add = (id: number, r: EventRef) => { m.set(id, [...(m.get(id) ?? []), r]); };
    judges.forEach((j, ji) => {
      const judgeName = judgeShort(String(j.judge_model ?? `judge ${ji}`));
      (Array.isArray(j.incidents) ? j.incidents : []).forEach((inc: any, i: number) => {
        const base = { judge: ji, judgeName, item: String(i) };
        const cat = typeof inc?.category === "string" ? inc.category.replace(/_/g, " ") : undefined;
        ids(inc?.event_ids).forEach((id) => add(id, { ...base, role: "action", detail: cat }));
        ids(inc?.request_event_ids).forEach((id) => add(id, { ...base, role: "request" }));
        ids(inc?.reaction_event_ids).forEach((id) => add(id, {
          ...base, role: "reaction",
          detail: typeof inc?.human_reaction === "string" ? inc.human_reaction.replace(/_/g, " ") : undefined,
        }));
      });
      (Array.isArray(j.considered_not_flagged) ? j.considered_not_flagged : []).forEach((c: any, i: number) => {
        ids(c?.event_ids).forEach((id) => add(id, { judge: ji, judgeName, item: `n${i}`, role: "considered" }));
      });
    });
    return m;
  }, [judges]);

  // ── focus, from the URL ──
  const sel: Selection = useMemo(() => {
    const parts = (url.inc ?? "").split("~");
    if (parts.length !== 3 || parts[0] !== sid8) return null;
    const judge = judges.findIndex((j) => j.judge_model === parts[1]);
    return judge < 0 ? null : { judge, item: parts[2] };
  }, [url.inc, sid8, judges]);
  const focusEv: number | null = useMemo(() => {
    const parts = (url.ev ?? "").split("~");
    if (parts.length !== 2 || parts[0] !== sid8) return null;
    const n = Number(parts[1]);
    return Number.isInteger(n) ? n : null;
  }, [url.ev, sid8]);
  const selRefs = useMemo(() => {
    const m = new Map<number, EventRef[]>();
    if (!sel) return m;
    refsByEvent.forEach((rs, id) => {
      const mine = rs.filter((r) => r.judge === sel.judge && r.item === sel.item);
      if (mine.length) m.set(id, mine);
    });
    return m;
  }, [sel, refsByEvent]);

  // ── which events are listed, and which are unfolded ──
  const [modes, setModes] = usePref<Record<ModeKey, Mode>>("transcript.kindModes", DEFAULT_MODES);
  const modeOf = (e: TEvent): Mode | null =>
    e.kind === "user" || e.kind === "assistant" ? null : (modes[e.kind as ModeKey] ?? DEFAULT_MODES[e.kind as ModeKey]);
  const [overrides, setOverrides] = useState<Map<number, boolean>>(new Map());
  const [qRaw, setQRaw] = useState("");
  const q = useDeferredValue(qRaw.trim());
  const haystack = useMemo(
    () => (q ? events.map((e) => (e.text + (e.tool_input ? "\n" + JSON.stringify(e.tool_input) : "")).toLowerCase()) : []),
    // Lowercased once per session, on the first search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, q !== ""],
  );
  const matches = useMemo(() => {
    const s = new Set<number>();
    if (!q) return s;
    const needle = q.toLowerCase();
    haystack.forEach((h, i) => { if (h.includes(needle)) s.add(events[i].idx); });
    return s;
  }, [q, haystack, events]);

  const visible = useMemo(
    () => events.filter((e) =>
      modeOf(e) !== "hide" || isHumanAction(e) || refsByEvent.has(e.idx) || e.idx === focusEv || matches.has(e.idx)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, modes, refsByEvent, focusEv, matches],
  );
  const posByIdx = useMemo(() => new Map(visible.map((e, i) => [e.idx, i])), [visible]);
  const isOpen = (e: TEvent): boolean => {
    const o = overrides.get(e.idx);
    if (o != null) return o;
    const mode = modeOf(e);
    return mode == null || mode === "open" || isHumanAction(e) || selRefs.has(e.idx) || e.idx === focusEv || matches.has(e.idx);
  };

  // ── virtualized list + jumps ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 10,
    measureElement: (el) => el.getBoundingClientRect().height,
  });
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  const jumpTo = useCallback((idx: number) => {
    const el = scrollRef.current;
    const pos = posByIdx.get(idx);
    if (!el || pos == null) return;
    virtualizer.scrollToIndex(pos, { align: "start" });
    setFlashIdx(idx);
    window.setTimeout(() => setFlashIdx((cur) => (cur === idx ? null : cur)), 1500);
    // Row heights are measured as they mount, so the first landing is off;
    // re-aim for a few frames until the target sits still, or the reader scrolls.
    let frames = 0, still = 0, stopped = false;
    const stop = () => { stopped = true; };
    el.addEventListener("wheel", stop, { once: true, passive: true });
    el.addEventListener("pointerdown", stop, { once: true });
    const tick = () => {
      if (stopped) return;
      const node = el.querySelector<HTMLElement>(`[data-ev="${idx}"]`);
      if (node) {
        const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
        if (Math.abs(delta) > 2) { el.scrollTop += delta; still = 0; }
        else if (++still >= 4) return;
      } else {
        virtualizer.scrollToIndex(pos, { align: "start" });
      }
      if (++frames < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [posByIdx, virtualizer]);

  // A click sets the URL; the jump runs once the target is in the list.
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    if (pending == null || !posByIdx.has(pending)) return;
    jumpTo(pending);
    setPending(null);
  }, [pending, posByIdx, jumpTo]);

  const firstEventOf = useCallback((judge: number, item: string): number | null => {
    const j = judges[judge];
    const entry = item.startsWith("n")
      ? j?.considered_not_flagged?.[Number(item.slice(1))]
      : j?.incidents?.[Number(item)];
    const all = [...ids(entry?.event_ids), ...ids(entry?.request_event_ids)];
    return ids(entry?.event_ids)[0] ?? all[0] ?? null;
  }, [judges]);

  const selectIncident = useCallback((judge: number, item: string) => {
    const model = judges[judge]?.judge_model;
    if (model == null) return;
    setTranscriptFocus({ inc: `${sid8}~${model}~${item}`, ev: null });
    setPending(firstEventOf(judge, item));
  }, [judges, sid8, setTranscriptFocus, firstEventOf]);
  const selectEvent = useCallback((idx: number) => {
    setTranscriptFocus({ ev: `${sid8}~${idx}` });
    setPending(idx);
  }, [sid8, setTranscriptFocus]);

  // Deep link: land on the URL's event / incident once, when the data is there.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !events.length) return;
    if (url.inc && !p.judgesReady) return;
    landed.current = true;
    const target = focusEv ?? (sel ? firstEventOf(sel.judge, sel.item) : null);
    if (target != null) setPending(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length, p.judgesReady]);

  // ── stepping: human messages, incidents, search hits ──
  const topPos = () => {
    const el = scrollRef.current;
    if (!el) return 0;
    const item = virtualizer.getVirtualItems().find((vi) => vi.end > el.scrollTop + 24);
    return item?.index ?? 0;
  };
  const stepThrough = (targets: number[], dir: 1 | -1) => {
    const here = topPos();
    const positions = targets.map((idx) => posByIdx.get(idx)).filter((x): x is number => x != null).sort((a, b) => a - b);
    const next = dir > 0 ? positions.find((x) => x > here) : [...positions].reverse().find((x) => x < here);
    if (next != null) jumpTo(visible[next].idx);
  };
  const humanIdx = useMemo(() => visible.filter((e) => e.kind === "user").map((e) => e.idx), [visible]);
  const filtersKey = JSON.stringify(url.filters);
  const matchInc = useMemo(
    () => (p.pinned ? null : incidentMatcher(url.filters, judges)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtersKey, judges, p.pinned],
  );
  // Stepping goes through the incidents the filters keep.
  const incidentOrder = useMemo(() => {
    const out: { judge: number; item: string; first: number }[] = [];
    judges.forEach((j, ji) => (Array.isArray(j.incidents) ? j.incidents : []).forEach((inc: any, i: number) => {
      const first = firstEventOf(ji, String(i));
      if (first != null && (!matchInc || matchInc(inc))) out.push({ judge: ji, item: String(i), first });
    }));
    return out.sort((a, b) => a.first - b.first || a.judge - b.judge);
  }, [judges, firstEventOf, matchInc]);
  const stepIncident = (dir: 1 | -1) => {
    if (!incidentOrder.length) return;
    const cur = sel ? incidentOrder.findIndex((x) => x.judge === sel.judge && x.item === sel.item) : -1;
    const next = cur < 0 ? (dir > 0 ? 0 : incidentOrder.length - 1) : cur + dir;
    if (next < 0 || next >= incidentOrder.length) return;
    selectIncident(incidentOrder[next].judge, incidentOrder[next].item);
  };
  const matchList = useMemo(() => [...matches].sort((a, b) => a - b), [matches]);

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "u") stepThrough(humanIdx, 1);
    else if (e.key === "U") stepThrough(humanIdx, -1);
    else if (e.key === ".") stepIncident(1);
    else if (e.key === ",") stepIncident(-1);
    else if (e.key === "Escape") setTranscriptFocus({ inc: null, ev: null });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── labels ──
  const saveLabel = useCallback(async (rec: LabelRec) => {
    const res = await api.addTranscriptLabel(path, rec);
    qc.setQueryData(["transcript-labels", path, sid], res);
    qc.invalidateQueries({ queryKey: ["transcript-progress", path] });
  }, [path, sid, qc]);
  const sessionLabel = p.labels.find((l) => l.kind === "session") ?? {};
  const missedIds: number[] = Array.isArray(sessionLabel.missed_event_ids) ? sessionLabel.missed_event_ids : [];
  const toggleMissed = (idx: number) => {
    const has = missedIds.includes(idx);
    const next = has ? missedIds.filter((x) => x !== idx) : [...missedIds, idx].sort((a, b) => a - b);
    saveLabel({
      kind: "session", session_id: sid, rubric_version: judges[0]?.rubric_version ?? null,
      note: sessionLabel.note ?? "",
      missed: has ? !!sessionLabel.missed : true, missed_event_ids: next,
    });
  };

  // Links open as pinned tabs: they name the session, not a row, and opening
  // one doesn't move the view other tabs are following.
  const pinnedLink = (focus: { inc?: string | null; ev?: string | null }) => {
    const u = new URLSearchParams({ path, pin: sid });
    if (focus.inc) u.set("inc", focus.inc);
    if (focus.ev) u.set("ev", focus.ev);
    return `${window.location.origin}${window.location.pathname}?${u}`;
  };
  const linkFor = (judge: number, item: string) =>
    pinnedLink({ inc: `${sid8}~${judges[judge]?.judge_model}~${item}` });

  const clampStore = useRef(new Map<string, boolean>()).current;
  const [panelWidth, setPanelWidth] = usePref<number>("transcript.panelWidth", 440);
  const s = p.session ?? {};
  const stats = s.stats && typeof s.stats === "object" ? (s.stats as Record<string, unknown>) : {};
  const virtualItems = virtualizer.getVirtualItems();
  const n = Math.max(1, visible.length);

  return (
    <div className="h-full flex min-w-0">
      <div className="flex-1 min-w-0 flex flex-col">
        {/* session + reading controls */}
        <div className="shrink-0 border-b border-zinc-200 dark:border-zinc-800 px-3 py-1.5 space-y-1 text-[12px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {p.pinned ? (
              <button
                onClick={unpin}
                title="this tab stays on this session; click to make it follow the shared view again"
                className="flex items-center gap-1 rounded border border-sky-500 px-1.5 py-px text-sky-700 dark:text-sky-300 hover:bg-sky-500/10"
              >
                <Pin size={12} /> pinned tab
              </button>
            ) : (
              <a
                href={pinnedLink({ inc: url.inc, ev: url.ev })}
                target="_blank"
                rel="noreferrer"
                title="open this session in its own tab (it stays on this session)"
                className="rounded p-0.5 text-zinc-500 hover:text-sky-600"
              >
                <ExternalLink size={13} />
              </a>
            )}
            <button
              onClick={() => copyToClipboard(sid)}
              title={`${sid} · click to copy`}
              className="font-mono font-semibold text-zinc-900 dark:text-zinc-100 hover:text-sky-600"
            >
              {sid8}
            </button>
            {s.agent && <span className="text-zinc-700 dark:text-zinc-300">{String(s.agent)}</span>}
            {s.model && <span className="font-mono text-zinc-600 dark:text-zinc-400">{String(s.model)}</span>}
            {s.repo_id && <span className="text-zinc-500 truncate max-w-[16rem]" title={String(s.repo_id)}>{String(s.repo_id)}</span>}
            <span className="text-zinc-500 tabular-nums">
              {events.length} events{visible.length !== events.length ? ` (${visible.length} listed)` : ""}
            </span>
            {Object.entries(stats).filter(([k]) => k.startsWith("n_") && k !== "n_events").map(([k, val]) => (
              <span key={k} className="text-zinc-500 tabular-nums">{k.replace(/^n_/, "").replace(/_/g, " ")}: {String(val)}</span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Stepper label="human" title="previous / next human message (U / u)" onPrev={() => stepThrough(humanIdx, -1)} onNext={() => stepThrough(humanIdx, 1)} count={humanIdx.length} />
            <Stepper label="incident" title="previous / next incident (, / .)" onPrev={() => stepIncident(-1)} onNext={() => stepIncident(1)} count={incidentOrder.length} />
            {MODE_GROUPS.map((g) => (
              <label key={g.key} className="flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
                {g.label}
                <select
                  value={modes[g.key] ?? DEFAULT_MODES[g.key]}
                  onChange={(e) => {
                    setModes({ ...DEFAULT_MODES, ...modes, [g.key]: e.target.value as Mode });
                    setOverrides((m) => {
                      const next = new Map(m);
                      events.forEach((ev) => { if (ev.kind === g.key) next.delete(ev.idx); });
                      return next;
                    });
                  }}
                  className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-1 py-px text-[12px] text-zinc-800 dark:text-zinc-200"
                >
                  <option value="open">open</option>
                  <option value="fold">folded</option>
                  <option value="hide">hidden</option>
                </select>
              </label>
            ))}
            <div className="ml-auto flex items-center gap-1">
              <div className={cn("flex items-center gap-1 rounded border px-1.5 py-px", q && !matchList.length ? "border-red-500" : "border-zinc-300 dark:border-zinc-700")}>
                <Search size={12} className="text-zinc-500" />
                <input
                  value={qRaw}
                  onChange={(e) => setQRaw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") stepThrough(matchList, e.shiftKey ? -1 : 1);
                    else if (e.key === "Escape") { setQRaw(""); (e.target as HTMLInputElement).blur(); }
                  }}
                  placeholder="find in session"
                  title="Enter: next match · Shift+Enter: previous"
                  className="w-40 bg-transparent text-[12px] outline-none"
                />
                {q && <span className="text-zinc-500 tabular-nums whitespace-nowrap">{matchList.length} event{matchList.length === 1 ? "" : "s"}</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto" data-transcript-scroll>
            {p.sessionError ? (
              <div className="p-6 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">{p.sessionError}</div>
            ) : (
              <ClampStore.Provider value={clampStore}>
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualItems.map((vi) => {
                    const ev = visible[vi.index];
                    if (!ev) return null;
                    return (
                      <div
                        key={ev.idx}
                        ref={virtualizer.measureElement}
                        data-index={vi.index}
                        style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                      >
                        <EventBlock
                          ev={ev}
                          open={isOpen(ev)}
                          onToggle={() => setOverrides((m) => new Map(m).set(ev.idx, !isOpen(ev)))}
                          refs={refsByEvent.get(ev.idx) ?? EMPTY}
                          selectedRoles={selRefs.get(ev.idx) ?? EMPTY}
                          focused={focusEv === ev.idx}
                          flash={flashIdx === ev.idx}
                          q={matches.has(ev.idx) ? q : ""}
                          missed={missedIds.includes(ev.idx)}
                          onToggleMissed={() => toggleMissed(ev.idx)}
                          onSelectEvent={() => selectEvent(ev.idx)}
                          onSelectRef={(r) => selectIncident(r.judge, r.item)}
                          onLoadFull={() => loadFull(ev.idx)}
                        />
                      </div>
                    );
                  })}
                </div>
              </ClampStore.Provider>
            )}
          </div>

          <Minimap
            visible={visible}
            refsByEvent={refsByEvent}
            missedIds={missedIds}
            matches={matches}
            first={virtualItems[0]?.index ?? 0}
            last={virtualItems[virtualItems.length - 1]?.index ?? 0}
            onScrollTo={(pos) => virtualizer.scrollToIndex(pos, { align: "center" })}
            onEvent={selectEvent}
            onIncident={(r) => selectIncident(r.judge, r.item)}
          />
        </div>
      </div>

      <div
        className="w-1 shrink-0 cursor-col-resize bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-400 dark:hover:bg-zinc-600"
        title="drag to resize"
        onMouseDown={(e) => {
          const start = e.clientX, startW = panelWidth;
          const onMove = (ev: MouseEvent) => setPanelWidth(Math.max(260, Math.min(900, startW - (ev.clientX - start))));
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />
      <aside style={{ width: panelWidth }} className="shrink-0 min-w-0">
        <TranscriptJudgePanel
          judges={judges}
          sel={sel}
          onSelect={selectIncident}
          onSelectEvent={selectEvent}
          linkFor={linkFor}
          labels={p.labels}
          labelsFile={p.labelsFile}
          saveLabel={saveLabel}
          sessionId={sid}
          path={path}
          matchInc={matchInc}
          pinned={p.pinned}
          currentRowIdx={p.currentRowIdx}
        />
      </aside>
    </div>
  );
}

const EMPTY: EventRef[] = [];

type Tick = { pos: number; idx: number; rank: number; cls: string; color?: string; label: string; ref?: EventRef };

/**
 * Overview strip beside the transcript: a tick per human message (left) and
 * per flagged event (right, in the judge's hue), plus missed-event flags and
 * search hits. It works like a scrollbar (drag to scroll, click to jump) and
 * like an index: hovering a tick names it, clicking it lands exactly on that
 * event (and selects the incident).
 */
function Minimap(p: {
  visible: TEvent[]; refsByEvent: Map<number, EventRef[]>; missedIds: number[]; matches: Set<number>;
  first: number; last: number;
  onScrollTo: (pos: number) => void; onEvent: (idx: number) => void; onIncident: (r: EventRef) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{ tick: Tick; y: number; right: number } | null>(null);
  const n = Math.max(1, p.visible.length);
  const ticks = useMemo(() => {
    const out: Tick[] = [];
    p.visible.forEach((e, pos) => {
      const action = p.refsByEvent.get(e.idx)?.find((r) => r.role === "action");
      if (action) {
        out.push({
          pos, idx: e.idx, rank: 0, cls: "right-0 w-2.5 h-[3px]", color: refColor(action), ref: action,
          label: `${action.judgeName} #${action.item}${action.detail ? ` · ${action.detail}` : ""}`,
        });
      }
      if (p.missedIds.includes(e.idx)) out.push({ pos, idx: e.idx, rank: 1, cls: "inset-x-0 h-[3px] bg-amber-500", label: "flagged as missed by the judges" });
      if (e.kind === "user") {
        const line = (e.text || "").trim().split("\n")[0];
        out.push({ pos, idx: e.idx, rank: 2, cls: "left-0 w-2 h-[2px] bg-sky-500", label: `human: ${line.length > 90 ? line.slice(0, 89) + "…" : line}` });
      }
      if (p.matches.has(e.idx)) out.push({ pos, idx: e.idx, rank: 3, cls: "inset-x-1 h-[2px] bg-yellow-400", label: "search match" });
    });
    return out;
  }, [p.visible, p.refsByEvent, p.missedIds, p.matches]);

  const rect = () => box.current!.getBoundingClientRect();
  const posAt = (clientY: number) => {
    const r = rect();
    return Math.min(n - 1, Math.max(0, Math.floor(((clientY - r.top) / r.height) * n)));
  };
  /** The tick within 7 px of the pointer (flagged events win ties). */
  const tickAt = (clientY: number): Tick | null => {
    const r = rect();
    const y = clientY - r.top;
    let best: Tick | null = null, bestD = 7;
    for (const t of ticks) {
      const d = Math.abs(((t.pos + 0.5) / n) * r.height - y);
      if (d < bestD || (best && d === bestD && t.rank < best.rank)) { best = t; bestD = d; }
    }
    return best;
  };

  return (
    <div
      ref={box}
      data-transcript-minimap
      className={cn(
        "relative w-5 shrink-0 select-none touch-none border-l border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950",
        hover ? "cursor-pointer" : "cursor-ns-resize",
      )}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) {
          if (Math.abs(e.clientY - d.y) > 3) d.moved = true;
          if (d.moved) { setHover(null); p.onScrollTo(posAt(e.clientY)); }
          return;
        }
        const tick = tickAt(e.clientY);
        setHover(tick ? { tick, y: rect().top + ((tick.pos + 0.5) / n) * rect().height, right: window.innerWidth - rect().left + 6 } : null);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved) return;
        const tick = tickAt(e.clientY);
        if (tick?.ref) p.onIncident(tick.ref);
        else if (tick) p.onEvent(tick.idx);
        else p.onScrollTo(posAt(e.clientY));
      }}
      onPointerLeave={() => { if (!drag.current) setHover(null); }}
    >
      <div
        className="absolute inset-x-0 bg-zinc-400/25"
        style={{ top: `${(p.first / n) * 100}%`, height: `${Math.max(1, ((p.last - p.first + 1) / n) * 100)}%` }}
      />
      {ticks.map((t, i) => {
        const on = hover?.tick === t;
        return (
          <div
            key={i}
            className={cn("absolute -translate-y-1/2", t.cls, on && "!h-[7px] !inset-x-0 !w-auto ring-1 ring-zinc-900 dark:ring-zinc-100")}
            style={{ top: `${((t.pos + 0.5) / n) * 100}%`, background: t.color }}
          />
        );
      })}
      {hover && (
        <div
          data-minimap-tip
          className="pointer-events-none fixed z-50 max-w-[26rem] -translate-y-1/2 truncate rounded border border-zinc-300 bg-white px-2 py-1 text-[12px] text-zinc-800 shadow-md dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          style={{ top: hover.y, right: hover.right }}
        >
          <span className="font-mono text-zinc-500">E{hover.tick.idx}</span> {hover.tick.label}
        </div>
      )}
    </div>
  );
}

function Stepper({ label, title, onPrev, onNext, count }: {
  label: string; title: string; onPrev: () => void; onNext: () => void; count: number;
}) {
  const btn = "rounded p-0.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-30";
  return (
    <span className="flex items-center gap-0.5" title={title}>
      <button className={btn} onClick={onPrev} disabled={!count}><ChevronLeft size={14} /></button>
      <span className="text-zinc-700 dark:text-zinc-300">{label} <span className="text-zinc-500 tabular-nums">{count}</span></span>
      <button className={btn} onClick={onNext} disabled={!count}><ChevronRight size={14} /></button>
    </span>
  );
}
