import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useViewerState } from "../lib/state";
import { usePref } from "../lib/prefs";
import { PanelHeader } from "./MarkPanel";
import { Play, Filter, Eye, X, Sparkles, Check } from "lucide-react";
import { cn } from "../lib/utils";
import Collapsible from "./Collapsible";

const SQL_PLACEHOLDER = "SELECT __idx, * FROM t LIMIT 100";
const HISTORY_CAP = 50;

type NlModel = "sonnet" | "opus" | "haiku";
const NL_MODELS: NlModel[] = ["sonnet", "opus", "haiku"];
type NlDraft = { sql: string; explanation: string; model: string } | null;

/**
 * Unified SQL pad — NL prompt + manual editor live in the same surface (no
 * mode tab) because the NL flow always lands in the SQL editor for review
 * anyway. Layout from top to bottom:
 *   - NL prompt block (always visible; ignore it if you only want to type SQL)
 *   - Draft preview card (appears after Generate, with use/discard buttons)
 *   - SQL editor + Run / Apply selection / Apply view / Clear buttons
 *   - Result table (clickable rows with __idx → goto)
 *
 * The active query is mirrored to ViewerState on apply, so it's bookmarkable
 * via the URL (`?sql=...&sqlmode=selection|view`).
 */
export default function SqlPad({ onClose }: { onClose: () => void }) {
  const v = useViewerState();
  const [sql, setSql] = useState(v.sql_query ?? "");
  const [result, setResult] = useState<{ columns: string[]; rows: any[][] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const [nlPrompt, setNlPrompt] = useState("");
  const [nlDraft, setNlDraft] = useState<NlDraft>(null);
  const [generating, setGenerating] = useState(false);
  // Persisted across browsers via the prefs backend so the user's last pick sticks.
  const [nlModel, setNlModel] = usePref<NlModel>("sqlpad.nlModel", "sonnet");
  // Shell-style command history (MRU first). Persists cross-browser via the
  // prefs backend so a query you ran in Chrome shows up in Firefox too.
  const [history, setHistory] = usePref<string[]>("sqlpad.history", []);
  // null = not navigating history. Otherwise index into `history` (0 = MRU).
  // ArrowUp from an empty editor enters navigation; once in, typing exits.
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);

  // If state.sql_query changes from elsewhere (URL load, another tab), sync.
  useEffect(() => {
    if (v.sql_query && v.sql_query !== sql) setSql(v.sql_query);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.sql_query]);

  function pushHistory(entry: string) {
    const trimmed = entry.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      // Drop a consecutive duplicate at the top to avoid spam from re-runs.
      const filtered = prev[0] === trimmed ? prev.slice(1) : prev.filter((q) => q !== trimmed);
      return [trimmed, ...filtered].slice(0, HISTORY_CAP);
    });
    setHistoryIdx(null);
  }

  function handleSqlKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
      return;
    }
    // History navigation: only intercept when there's something to recall AND
    // we're either in an empty cell or already navigating (so a single-line
    // edit can still use arrow keys to move the caret in long queries).
    if (history.length === 0) return;
    if (e.key === "ArrowUp") {
      if (sql === "" && historyIdx === null) {
        e.preventDefault();
        setHistoryIdx(0);
        setSql(history[0]);
        return;
      }
      if (historyIdx !== null && historyIdx + 1 < history.length) {
        e.preventDefault();
        const next = historyIdx + 1;
        setHistoryIdx(next);
        setSql(history[next]);
        return;
      }
    } else if (e.key === "ArrowDown") {
      if (historyIdx !== null) {
        e.preventDefault();
        if (historyIdx === 0) {
          setHistoryIdx(null);
          setSql("");
        } else {
          const next = historyIdx - 1;
          setHistoryIdx(next);
          setSql(history[next]);
        }
      }
    }
  }

  function handleSqlChange(next: string) {
    setSql(next);
    // Once the user diverges from the recalled history entry, exit history
    // mode so subsequent ArrowUp doesn't jump past their edits.
    if (historyIdx !== null && next !== history[historyIdx]) {
      setHistoryIdx(null);
    }
  }

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const r = await api.sql(sql, v.dataset_path ?? undefined);
      setResult(r);
      pushHistory(sql);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  async function apply(mode: "selection" | "view") {
    setError(null);
    try {
      await api.sqlApply(mode, sql);
      pushHistory(sql);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function clearApplied() {
    try {
      await api.sqlApply("off");
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function generateFromNl() {
    setGenerating(true);
    setError(null);
    setNlDraft(null);
    try {
      const d = await api.sqlFromNl(nlPrompt, nlModel);
      setNlDraft(d);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setGenerating(false);
    }
  }

  function acceptDraft() {
    if (!nlDraft) return;
    setSql(nlDraft.sql);
    setNlDraft(null);
    setResult(null);
  }

  const idxColPos = result?.columns.indexOf("__idx") ?? -1;
  const canApplySelection = idxColPos >= 0;
  const isActive = v.sql_mode !== "off";

  return (
    <>
      <PanelHeader title="sql pad" onClose={onClose} />
      <NlPromptBlock
        prompt={nlPrompt}
        onPromptChange={setNlPrompt}
        onGenerate={generateFromNl}
        generating={generating}
        draft={nlDraft}
        onAccept={acceptDraft}
        onDiscard={() => setNlDraft(null)}
        model={nlModel}
        onModelChange={setNlModel}
      />
      <div className="p-2">
        <textarea
          value={sql}
          onChange={(e) => handleSqlChange(e.target.value)}
          onKeyDown={handleSqlKeyDown}
          rows={6}
          placeholder={SQL_PLACEHOLDER + (history.length > 0 ? "    ⟵ ↑/↓ for history" : "")}
          className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono text-xs outline-none focus:border-emerald-600 resize-none placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <button
            onClick={run}
            disabled={running}
            className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 text-zinc-50 rounded text-xs flex items-center gap-1 disabled:opacity-50"
          >
            <Play size={11} /> run <span className="opacity-70">⌘↵</span>
          </button>
          <button
            onClick={() => apply("selection")}
            disabled={!canApplySelection || running}
            title={canApplySelection
              ? "narrow main view to the __idx column from this query"
              : "add __idx to the SELECT to enable"}
            className={cn(
              "px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors",
              canApplySelection
                ? (v.sql_mode === "selection"
                    ? "bg-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                    : "bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700")
                : "bg-zinc-100 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-600 cursor-not-allowed",
            )}
          >
            <Filter size={11} /> apply as selection
          </button>
          <button
            onClick={() => apply("view")}
            disabled={running}
            title="replace the main view with this query's result"
            className={cn(
              "px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors",
              v.sql_mode === "view"
                ? "bg-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                : "bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700",
            )}
          >
            <Eye size={11} /> apply as view
          </button>
          {isActive && (
            <button
              onClick={clearApplied}
              title="drop the applied SQL, return to natural view"
              className="px-2 py-1 rounded text-xs flex items-center gap-1 bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
            >
              <X size={11} /> clear
            </button>
          )}
        </div>
        <div className="text-[10px] text-zinc-500 mt-1.5 leading-snug">
          <code className="font-mono">FROM t</code> = the open dataset.
          Selection mode needs <code className="font-mono">__idx</code> in the SELECT.
          {v.sql_mode === "selection" && v.sql_selection_count != null && (
            <span className="ml-1 text-emerald-600 dark:text-emerald-400">
              · selection active: {v.sql_selection_count} rows
            </span>
          )}
          {v.sql_mode === "view" && (
            <span className="ml-1 text-emerald-600 dark:text-emerald-400">
              · view mode active
            </span>
          )}
        </div>
      </div>
      {error && <pre className="text-xs text-red-400 p-2 whitespace-pre-wrap font-mono">{error}</pre>}
      {result && (
        <div className="flex-1 overflow-auto px-2 pb-2 text-xs font-mono">
          <table className="border-collapse">
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c} className={cn(
                    "text-left px-2 py-1 sticky top-0 bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400",
                    c === "__idx" && "text-emerald-700 dark:text-emerald-400",
                  )}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => {
                const rowIdx = idxColPos >= 0 ? Number(r[idxColPos]) : null;
                const clickable = rowIdx != null && Number.isFinite(rowIdx);
                return (
                  <tr
                    key={i}
                    onClick={clickable ? () => api.goto(rowIdx!) : undefined}
                    title={clickable ? `click to jump to row ${rowIdx}` : undefined}
                    className={cn(
                      "border-b border-zinc-100 dark:border-zinc-900",
                      clickable
                        ? "hover:bg-emerald-500/10 cursor-pointer"
                        : "hover:bg-white dark:bg-zinc-900/40",
                    )}
                  >
                    {r.map((cell, j) => (
                      <td key={j} className="px-2 py-1 text-zinc-700 dark:text-zinc-300 align-top max-w-md">
                        <Collapsible chars={80} lines={1}>
                          {typeof cell === "string" ? cell : JSON.stringify(cell)}
                        </Collapsible>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="text-[10px] text-zinc-500 mt-2">
            {result.rows.length} rows{canApplySelection && <span> · rows clickable → goto</span>}
          </div>
        </div>
      )}
    </>
  );
}

function NlPromptBlock({
  prompt, onPromptChange, onGenerate, generating, draft, onAccept, onDiscard,
  model, onModelChange,
}: {
  prompt: string;
  onPromptChange: (s: string) => void;
  onGenerate: () => void;
  generating: boolean;
  draft: NlDraft;
  onAccept: () => void;
  onDiscard: () => void;
  model: NlModel;
  onModelChange: (m: NlModel) => void;
}) {
  return (
    <div className="p-2 border-b border-zinc-200 dark:border-zinc-800 bg-emerald-50/40 dark:bg-emerald-950/15">
      <div className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400 mb-1 flex items-center gap-1">
        <Sparkles size={11} /> ask in plain English (optional)
      </div>
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (prompt.trim()) onGenerate();
          }
        }}
        rows={2}
        placeholder={'e.g. "rows where the alignment judge scored below 30" — leave blank to skip'}
        className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded text-xs outline-none focus:border-emerald-600 resize-none"
      />
      <div className="flex items-center gap-2 mt-1.5">
        <button
          onClick={onGenerate}
          disabled={generating || !prompt.trim()}
          className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 text-zinc-50 rounded text-xs flex items-center gap-1 disabled:opacity-50"
        >
          <Sparkles size={11} /> {generating ? "generating…" : "generate SQL"}
          <span className="opacity-70 ml-0.5">⌘↵</span>
        </button>
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value as NlModel)}
          className="px-1.5 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded text-[11px] outline-none focus:border-emerald-600 font-mono"
          title="Claude model alias — SDK resolves to the current default version"
        >
          {NL_MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>
      {draft && (
        <div className="mt-2 border border-emerald-500/40 rounded bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400 border-b border-emerald-500/30 flex items-center gap-1">
            <Sparkles size={10} /> draft · {draft.model}
          </div>
          <pre className="px-2 py-1.5 text-xs font-mono whitespace-pre-wrap bg-zinc-50 dark:bg-zinc-950 text-zinc-800 dark:text-zinc-200 border-b border-emerald-500/20 overflow-x-auto">
            {draft.sql}
          </pre>
          <div className="px-2 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 leading-snug">
            {draft.explanation}
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-emerald-500/20 bg-zinc-50/50 dark:bg-zinc-950/50">
            <button
              onClick={onAccept}
              className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 text-zinc-50 rounded text-xs flex items-center gap-1"
            >
              <Check size={11} /> use this
            </button>
            <button
              onClick={onDiscard}
              className="px-2 py-1 rounded text-xs flex items-center gap-1 bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
            >
              <X size={11} /> discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
