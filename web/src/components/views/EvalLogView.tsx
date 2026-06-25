import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import { useUrlSync } from "../../lib/url";
import { truncate, cn } from "../../lib/utils";
import { usePinHandler } from "../../lib/pin";
import { useRowPage, usePublishNav } from "../../lib/rowPage";
import { GroupedFeed } from "../GroupedFeed";
import RawJsonToggle from "../RawJsonToggle";

// Eval logs are small enough in this codebase that a single fetch covers the
// full list. Bump this if real logs ever exceed it — the underlying read is
// DuckDB on the materialized JSONL, so larger limits stay cheap.
const EVAL_LIST_LIMIT = 5000;

export default function EvalLogView() {
  const v = useViewerState();
  const { data: header } = useQuery({
    queryKey: ["eval-header", v.dataset_path],
    queryFn: () => api.evalHeader(v.dataset_path!),
    enabled: !!v.dataset_path,
  });
  // The materialized JSONL projection is the source of truth for the visible
  // list AND for the per-sample card — rendering the card from this same payload
  // means arrow-key navigation updates the right pane instantly with no second
  // round-trip. Filter/shuffle/goto all flow through DuckDB the same way they
  // do for regular JSONL datasets.
  const { data: indexPage } = useRowPage("eval-index", { limit: EVAL_LIST_LIMIT });
  const openIdx = v.row_idx;
  const pin = usePinHandler();
  const listRef = useRef<HTMLDivElement>(null);
  const { url } = useUrlSync();
  const grouped = !!url.groupBy;

  // Step arrow / j / k through the visible order (matters under shuffle + filter).
  usePublishNav(indexPage?.indices, !grouped);

  // idx → sample lookup so the grouped feed can render a member card without a
  // second round-trip (the materialized projection already holds every sample).
  const byIdx = useMemo(() => {
    const m = new Map<number, any>();
    indexPage?.indices.forEach((sIdx, pos) => m.set(sIdx, indexPage.rows[pos]));
    return m;
  }, [indexPage]);

  // If the current row isn't in the visible set (just opened a filter that
  // excludes it, or fell off the end of a paginated view), snap to the first
  // visible item. One-shot per indices change — no feedback loop.
  useEffect(() => {
    if (!indexPage || indexPage.indices.length === 0) return;
    if (!indexPage.indices.includes(openIdx)) {
      api.goto(indexPage.indices[0]).catch(() => {});
    }
  // intentionally narrow deps: don't re-trigger purely because openIdx changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexPage?.indices.join(",")]);

  // Keep the highlighted sample in view as the user steps through.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-sample-idx="${openIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [openIdx]);

  if (!header || !indexPage) return <div className="p-6 text-zinc-500 text-sm">loading…</div>;

  // Grouped: collapse to one card per group, each cycling its member samples in
  // place (same overlay as the json/chat feeds). The two-pane browser doesn't
  // map onto "1 row = 1 group", so grouping replaces it with the shared feed.
  if (grouped) {
    return (
      <div className="h-full">
        <GroupedFeed
          renderMember={(idx) => {
            const s = byIdx.get(idx);
            return s ? (
              <SampleCard s={s} idx={idx} />
            ) : (
              <div className="px-4 py-4 text-zinc-500 text-sm">sample #{idx} not loaded</div>
            );
          }}
        />
      </div>
    );
  }

  const currentListPos = indexPage.indices.indexOf(openIdx);
  const currentSample = currentListPos >= 0 ? (indexPage.rows[currentListPos] as any) : null;

  return (
    <div className="h-full flex">
      <div ref={listRef} className="w-72 shrink-0 border-r border-zinc-200 dark:border-zinc-800 overflow-y-auto text-xs">
        <Header header={header} totalFiltered={indexPage.total_filtered} />
        {indexPage.indices.map((sampleIdx, listPos) => {
          const row = indexPage.rows[listPos] as any;
          const score = pickScore(row);
          return (
            <button
              key={sampleIdx}
              data-sample-idx={sampleIdx}
              onClick={(e) => {
                if (pin(e, { kind: "eval_sample", path: v.dataset_path!, idx: sampleIdx })) return;
                api.goto(sampleIdx).catch(() => {});
              }}
              title="shift+click to pin to chat"
              className={cn(
                "w-full text-left px-3 py-2 border-b border-zinc-100 dark:border-zinc-900 hover:bg-white dark:bg-zinc-900 font-mono",
                openIdx === sampleIdx && "bg-emerald-900/30",
              )}
            >
              <div className="flex justify-between gap-2">
                <span className="text-zinc-600 dark:text-zinc-400 truncate">#{sampleIdx} {String(row?.id ?? "")}</span>
                <span className={cn(
                  "shrink-0 text-[10px]",
                  score == null ? "text-zinc-400 dark:text-zinc-600" :
                  typeof score === "number" ? (score >= 0.5 ? "text-emerald-400" : "text-amber-400")
                  : score === "C" ? "text-emerald-400"
                  : score === "I" ? "text-red-400" : "text-amber-400",
                )}>{String(score ?? "")}</span>
              </div>
              <div className="text-[10px] text-zinc-400 dark:text-zinc-600 truncate">{truncate(stringify(row?.input), 80)}</div>
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-sm">
        {currentSample && (
          <SampleCard s={currentSample} idx={openIdx} />
        )}
      </div>
    </div>
  );
}

function Header({ header, totalFiltered }: { header: any; totalFiltered?: number }) {
  const total = header?.samples_count;
  const showingFiltered = totalFiltered != null && total != null && totalFiltered !== total;
  return (
    <div className="p-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 sticky top-0">
      <div className="text-[10px] uppercase text-zinc-500">eval</div>
      <div className="font-mono text-xs truncate">{header?.eval?.task ?? "?"}</div>
      <div className="text-[10px] text-zinc-500 mt-0.5">model: {header?.eval?.model ?? "?"}</div>
      <div className="text-[10px] text-zinc-500">
        samples: {total}{showingFiltered && <span className="text-emerald-500"> · {totalFiltered} filtered</span>}
      </div>
      {header?.results?.scores && (
        <div className="mt-2 space-y-0.5">
          {header.results.scores.map((sc: any, i: number) => (
            <div key={i} className="text-[10px] text-zinc-600 dark:text-zinc-400">
              <span className="font-mono">{sc?.name ?? "?"}: </span>
              {Object.entries(sc?.metrics ?? {}).map(([k, v]: any) => (
                <span key={k} className="mr-2">{k}={typeof v?.value === "number" ? v.value.toFixed(3) : String(v?.value)}</span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SampleCard({ s, idx }: { s: any; idx: number }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-zinc-500 font-mono">sample #{idx} · {String(s.id ?? "")}</div>
        <RawJsonToggle value={raw} onChange={setRaw} />
      </div>
      {raw ? (
        <pre className="text-xs font-mono whitespace-pre-wrap p-3 rounded-sm bg-zinc-100/70 dark:bg-zinc-900/70 text-zinc-800 dark:text-zinc-200 overflow-x-auto">
          {JSON.stringify(s, null, 2)}
        </pre>
      ) : <>
      {s.scores && (
        <div className="mb-3 flex flex-wrap gap-2">
          {Object.entries(s.scores).map(([name, sc]: any) => (
            <span key={name} className="text-[10px] px-2 py-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono">
              {name}: <b className="text-zinc-800 dark:text-zinc-200">{stringify(sc?.value)}</b>
              {sc?.explanation && <span className="text-zinc-500"> · {truncate(sc.explanation, 80)}</span>}
            </span>
          ))}
        </div>
      )}
      {s.metadata && typeof s.metadata === "object" && Object.keys(s.metadata).length > 0 && (
        <Section title="metadata">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded text-xs divide-y divide-zinc-100 dark:divide-zinc-800">
            {Object.entries(s.metadata).map(([k, val]) => (
              <div key={k} className="flex gap-3 px-2 py-1">
                <span className="font-mono text-zinc-500 shrink-0">{k}</span>
                <pre className="whitespace-pre-wrap break-all flex-1 min-w-0 text-zinc-800 dark:text-zinc-200">{stringify(val)}</pre>
              </div>
            ))}
          </div>
        </Section>
      )}
      <Section title="input">
        <pre className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded text-xs whitespace-pre-wrap">{stringify(s.input)}</pre>
      </Section>
      {s.target != null && (
        <Section title="target">
          <pre className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded text-xs whitespace-pre-wrap">{stringify(s.target)}</pre>
        </Section>
      )}
      {Array.isArray(s.messages) && s.messages.length > 0 && (
        <Section title={`messages (${s.messages.length})`}>
          <div className="space-y-2">
            {s.messages.map((m: any, i: number) => (
              <div key={i} className="border border-zinc-200 dark:border-zinc-800 rounded p-2">
                <div className="text-[10px] uppercase text-zinc-500 mb-1">{m.role}</div>
                <pre className="text-xs whitespace-pre-wrap">{stringify(m.content)}</pre>
              </div>
            ))}
          </div>
        </Section>
      )}
      {s.output && (
        <Section title="output">
          <pre className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 rounded text-xs whitespace-pre-wrap">{stringify(s.output?.completion ?? s.output)}</pre>
        </Section>
      )}
      {s.error && (
        <Section title="error">
          <pre className="bg-red-950/30 border border-red-900 p-2 rounded text-xs whitespace-pre-wrap">{stringify(s.error)}</pre>
        </Section>
      )}
      </>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="mb-3">
      <summary className="cursor-pointer text-[11px] uppercase text-zinc-500 mb-1">{title}</summary>
      {children}
    </details>
  );
}

function pickScore(s: any): unknown {
  const scores = s?.scores;
  if (!scores) return null;
  const first = Object.values(scores)[0] as any;
  return first?.value;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}
