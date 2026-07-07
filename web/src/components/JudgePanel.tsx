/**
 * Judges panel — list, expand-in-place, edit, run.
 *
 * Two judge backends, discriminated by `kind`:
 *
 *  - "prompt": system-prompt template + optional JSON schema for structured output.
 *  - "scorer": "module.path:attr" import path to an inspect @scorer factory
 *    (resolved server-side). For project-specific judges the user wants to
 *    surface in the viewer without bundling the code.
 *
 * Each preset is a clickable card; click expands a detail card with the
 * relevant fields (Collapsible + PreOrMarkdown for the prompt; raw <pre> for
 * the schema; mono-formatted import path for scorer kind). Edit happens in
 * place — no modal. The settings cog toggles a panel with the default-model
 * dropdown, persisted via PUT /api/judges/settings on every change.
 *
 * Live result rows render as structured cards: when output_json is present
 * (prompt+schema), every key/value is shown with a 0–100 sentiment colormap;
 * otherwise just the legacy score.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight, Pencil, Play, Plus, Settings, Trash2, X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { useViewerState } from "../lib/state";
import type { JudgeKind, JudgePreset } from "../lib/types";
import { cn, truncate } from "../lib/utils";
import { usePinHandler } from "../lib/pin";
import Collapsible from "./Collapsible";
import { PanelHeader } from "./MarkPanel";
import PreOrMarkdown from "./PreOrMarkdown";

type Scope = "current" | "sample" | "indices";

type ProgressRow = {
  idx: number;
  score: number | null;
  reasoning?: string | null;
  error?: string | null;
  output_json?: Record<string, unknown> | null;
};

/** Editable form state mirroring the JudgePreset shape. */
type Editing = {
  /** Original name when editing existing; null for a fresh draft. */
  originalName: string | null;
  name: string;
  description: string;
  kind: JudgeKind;
  scorer_import_path: string;
  system_prompt: string;
  score_field: string;
  response_schema: string; // raw text the user types; "" ⇒ no schema
  model: string; // "" ⇒ use default
};

const EMPTY_DRAFT: Editing = {
  originalName: null,
  name: "new_judge",
  description: "",
  kind: "prompt",
  scorer_import_path: "",
  system_prompt: "{question}\n\nAnswer to grade:\n{answer}\n\nReply with a number from 0 to 100.",
  score_field: "score",
  response_schema: "",
  model: "",
};

function presetToDraft(p: JudgePreset): Editing {
  return {
    originalName: p.name,
    name: p.name,
    description: p.description ?? "",
    kind: p.kind,
    scorer_import_path: p.scorer_import_path ?? "",
    system_prompt: p.system_prompt,
    score_field: p.score_field,
    response_schema: p.response_schema ?? "",
    model: p.model ?? "",
  };
}

/** Sentiment color for a 0–100-ish numeric. Falls through to neutral for non-numeric. */
function valueColor(v: unknown): string {
  if (typeof v !== "number" || Number.isNaN(v)) return "text-zinc-700 dark:text-zinc-300";
  if (v >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (v >= 40) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export default function JudgePanel({ onClose }: { onClose: () => void }) {
  const v = useViewerState();
  const pin = usePinHandler();
  const qc = useQueryClient();

  const { data: presets } = useQuery({ queryKey: ["presets"], queryFn: () => api.listPresets() });
  const { data: results } = useQuery({
    queryKey: ["judge-results", v.dataset_path],
    queryFn: () => api.judgeResults(v.dataset_path ?? undefined),
    enabled: !!v.dataset_path,
  });
  const { data: models } = useQuery({ queryKey: ["judge-models"], queryFn: () => api.listJudgeModels() });
  const { data: settings } = useQuery({ queryKey: ["judge-settings"], queryFn: () => api.getJudgeSettings() });

  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [scope, setScope] = useState<Scope>("current");
  const [n, setN] = useState(10);
  const [progress, setProgress] = useState<Record<string, ProgressRow[]>>({});
  const [running, setRunning] = useState<string | null>(null);

  const upsert = useMutation({
    mutationFn: async (e: Editing) => {
      const body: Partial<JudgePreset> = {
        description: e.description || null,
        kind: e.kind,
        scorer_import_path: e.kind === "scorer" ? e.scorer_import_path.trim() : null,
        system_prompt: e.kind === "prompt" ? e.system_prompt : "",
        score_field: e.score_field || "score",
        response_schema: e.kind === "prompt" && e.response_schema.trim()
          ? e.response_schema
          : null,
        model: e.model || null,
      };
      // If renaming, delete the old name first so the new row stands alone.
      if (e.originalName && e.originalName !== e.name) {
        await api.deletePreset(e.originalName);
      }
      return api.upsertPreset(e.name, body as Omit<JudgePreset, "name">);
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["presets"] });
      setEditing(null);
      setActivePreset(p.name);
    },
  });
  const del = useMutation({
    mutationFn: (name: string) => api.deletePreset(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["presets"] }),
  });
  const saveSettings = useMutation({
    mutationFn: (model: string) => api.setJudgeSettings({ default_judge_model: model }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["judge-settings"] }),
  });

  async function runBatch(presetName: string) {
    if (!v.dataset_path) return;
    setRunning(presetName);
    setProgress((prev) => ({ ...prev, [presetName]: [] }));
    const indices: number[] = scope === "current" ? [v.row_idx]
      : scope === "sample" ? (await api.sample(v.dataset_path, n)).indices
      : (await api.rows({ path: v.dataset_path, offset: 0, limit: n, shuffle_seed: v.shuffle_seed ?? null })).indices;
    const r = await fetch("/api/judges/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preset_name: presetName, dataset_path: v.dataset_path, indices }),
    });
    if (!r.body) { setRunning(null); return; }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const block of events) {
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          const obj = JSON.parse(dataLine.slice(6));
          if ("idx" in obj) {
            setProgress((prev) => ({
              ...prev,
              [presetName]: [...(prev[presetName] ?? []), obj as ProgressRow],
            }));
          }
        } catch {}
      }
    }
    setRunning(null);
    qc.invalidateQueries({ queryKey: ["judge-results"] });
  }

  return (
    <>
      <PanelHeader title="judges" onClose={onClose}>
        <button
          onClick={() => setShowSettings((s) => !s)}
          title="settings"
          className={cn(
            "p-1 rounded text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-800",
            showSettings && "bg-zinc-200 dark:bg-zinc-800",
          )}
        >
          <Settings size={12} />
        </button>
        <button
          onClick={() => setEditing({ ...EMPTY_DRAFT })}
          className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded"
        ><Plus size={10} /> new</button>
      </PanelHeader>

      {showSettings && (
        <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 text-xs">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">default model</div>
          <select
            value={settings?.default_judge_model ?? ""}
            onChange={(e) => saveSettings.mutate(e.target.value)}
            className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono text-xs"
          >
            {(models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            {settings && models && !models.includes(settings.default_judge_model) && (
              <option value={settings.default_judge_model}>{settings.default_judge_model}</option>
            )}
          </select>
          <div className="mt-1 text-[10px] text-zinc-500">
            applied when a preset has no per-judge model set
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto text-xs">
        {(presets ?? []).length === 0 && !editing && (
          <div className="p-3 text-zinc-500 text-[11px] leading-relaxed">
            no judge presets yet — click <span className="font-mono">new</span> above, or
            seed via CLI:
            <pre className="mt-2 p-2 bg-zinc-100 dark:bg-zinc-900 rounded text-[10px] overflow-x-auto">{`sscope view add-judge alignment \\
  --import-path my_project.judges:alignment_judge \\
  --description "0-100 alignment via top-20 logprobs E[rating]"`}</pre>
          </div>
        )}

        {(presets ?? []).map((p) => {
          const expanded = activePreset === p.name;
          const isEditing = editing?.originalName === p.name;
          return (
            <div key={p.name} className="border-b border-zinc-100 dark:border-zinc-900">
              <button
                onClick={() => setActivePreset(expanded ? null : p.name)}
                className={cn(
                  "w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-950",
                  expanded && "bg-zinc-50 dark:bg-zinc-950",
                )}
              >
                <ChevronRight
                  size={10}
                  className={cn(
                    "shrink-0 transition-transform text-zinc-400",
                    expanded && "rotate-90",
                  )}
                />
                <span className={cn(
                  "font-mono",
                  expanded ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-800 dark:text-zinc-200",
                )}>{p.name}</span>
                <KindBadge kind={p.kind} />
                {p.kind === "prompt" && p.response_schema && (
                  <span className="text-[9px] uppercase tracking-wider px-1.5 py-px rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                    schema
                  </span>
                )}
                <span className="ml-auto text-[10px] text-zinc-400 dark:text-zinc-600 font-mono truncate max-w-[40%]">
                  {p.model ?? "(default)"}
                </span>
              </button>

              {expanded && !isEditing && (
                <PresetDetail
                  p={p}
                  scope={scope}
                  setScope={setScope}
                  n={n}
                  setN={setN}
                  progress={progress[p.name] ?? []}
                  running={running === p.name}
                  onRun={() => runBatch(p.name)}
                  onEdit={() => setEditing(presetToDraft(p))}
                  onDelete={() => {
                    if (confirm(`Delete preset "${p.name}"?`)) del.mutate(p.name);
                  }}
                />
              )}

              {isEditing && editing && (
                <PresetEditor
                  draft={editing}
                  setDraft={setEditing}
                  models={models ?? []}
                  onSave={() => upsert.mutate(editing)}
                  onCancel={() => setEditing(null)}
                  saving={upsert.isPending}
                  error={upsert.error ? String(upsert.error) : null}
                />
              )}
            </div>
          );
        })}

        {editing && editing.originalName === null && (
          <div className="border-b-2 border-emerald-500 dark:border-emerald-700 bg-emerald-50/30 dark:bg-emerald-950/30">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
              <Plus size={10} /> new judge
            </div>
            <PresetEditor
              draft={editing}
              setDraft={setEditing}
              models={models ?? []}
              onSave={() => upsert.mutate(editing)}
              onCancel={() => setEditing(null)}
              saving={upsert.isPending}
              error={upsert.error ? String(upsert.error) : null}
            />
          </div>
        )}
      </div>

      {results && results.length > 0 && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 max-h-40 overflow-y-auto p-2 text-[10px]">
          <div className="text-zinc-500 mb-1 uppercase tracking-wider">recent results</div>
          {results.slice(0, 30).map((r, i) => (
            <button
              key={i}
              onClick={(e) => {
                if (pin(e, {
                  kind: "judge_result",
                  path: r.dataset_path,
                  idx: r.row_idx,
                  preset: r.preset_name,
                  score: r.score,
                  reasoning: r.reasoning,
                })) return;
                api.goto(r.row_idx);
              }}
              title="shift+click to pin to chat"
              className="w-full text-left flex justify-between gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-900 px-1 py-0.5"
            >
              <span className="text-zinc-700 dark:text-zinc-300 font-mono">#{r.row_idx} {r.preset_name}</span>
              {r.error ? (
                <span className="text-rose-500">{truncate(r.error, 30)}</span>
              ) : r.output_json ? (
                <span className="font-mono text-zinc-600 dark:text-zinc-400 truncate max-w-[60%]">
                  {Object.entries(r.output_json).slice(0, 3).map(([k, v]) => `${k}=${fmtVal(v)}`).join(" · ")}
                </span>
              ) : (
                <span className={cn("font-mono", valueColor(r.score))}>
                  {r.score == null ? "—" : fmtVal(r.score)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---- Subcomponents ----

function KindBadge({ kind }: { kind: JudgeKind }) {
  const styles = kind === "scorer"
    ? "bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300"
    : "bg-zinc-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400";
  return (
    <span className={cn(
      "text-[9px] uppercase tracking-wider px-1.5 py-px rounded border border-transparent",
      styles,
    )}>{kind}</span>
  );
}

function PresetDetail(props: {
  p: JudgePreset;
  scope: Scope;
  setScope: (s: Scope) => void;
  n: number;
  setN: (n: number) => void;
  progress: ProgressRow[];
  running: boolean;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { p, scope, setScope, n, setN, progress, running, onRun, onEdit, onDelete } = props;
  const prettyJson = useMemo(() => {
    if (!p.response_schema) return null;
    try { return JSON.stringify(JSON.parse(p.response_schema), null, 2); }
    catch { return p.response_schema; }
  }, [p.response_schema]);

  return (
    <div className="px-3 pb-3 space-y-3 bg-zinc-50/50 dark:bg-zinc-950/50">
      {p.description && (
        <div className="text-zinc-600 dark:text-zinc-400 italic">{p.description}</div>
      )}

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <Field label="model">
          <span className="font-mono text-zinc-700 dark:text-zinc-300">{p.model ?? "(default)"}</span>
        </Field>
        <Field label="score field">
          <span className="font-mono text-zinc-700 dark:text-zinc-300">{p.score_field}</span>
        </Field>
      </div>

      {p.kind === "scorer" ? (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">import path</div>
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded px-2 py-1 font-mono text-[11px] text-zinc-700 dark:text-zinc-300 break-all">
            {p.scorer_import_path}
          </div>
          <div className="text-[10px] text-zinc-500 mt-1">
            resolved server-side via <span className="font-mono">importlib</span>; expects an inspect <span className="font-mono">@scorer</span> factory
          </div>
        </div>
      ) : (
        <>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">system prompt</div>
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded px-2 py-1">
              <Collapsible lines={4} chars={300}>
                <PreOrMarkdown text={p.system_prompt} defaultMode="pre" />
              </Collapsible>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">response schema</div>
            {prettyJson ? (
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded px-2 py-1">
                <Collapsible lines={4} chars={300}>
                  <pre className="whitespace-pre-wrap font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                    {prettyJson}
                  </pre>
                </Collapsible>
              </div>
            ) : (
              <div className="text-zinc-500 italic px-2 py-1 text-[11px]">
                (no schema — free-form numeric parse)
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onEdit}
          className="text-[10px] flex items-center gap-1 px-2 py-1 bg-zinc-200 dark:bg-zinc-800 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700"
        ><Pencil size={10} /> edit</button>
        <button
          onClick={onDelete}
          className="text-[10px] flex items-center gap-1 px-2 py-1 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950 rounded"
        ><Trash2 size={10} /> delete</button>
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-800 pt-2">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">run</div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(["current", "sample", "indices"] as Scope[]).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={cn(
                  "px-2 py-0.5 text-[10px] rounded",
                  scope === s ? "bg-emerald-600 text-white" : "bg-zinc-200 dark:bg-zinc-800",
                )}
              >{s}</button>
            ))}
          </div>
          {scope !== "current" && (
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-zinc-500">n =</span>
              <input
                type="number"
                value={n}
                onChange={(e) => setN(Number(e.target.value))}
                className="w-14 px-1 py-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded"
              />
            </div>
          )}
          <button
            onClick={onRun}
            disabled={running}
            className="ml-auto px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded flex items-center gap-1 disabled:opacity-50 text-[10px]"
          >
            <Play size={10} /> {running ? "running…" : "run"}
          </button>
        </div>

        {progress.length > 0 && (
          <div className="mt-2 space-y-1 max-h-60 overflow-y-auto">
            {progress.map((r, i) => <ResultRow key={i} r={r} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultRow({ r }: { r: ProgressRow }) {
  if (r.error) {
    return (
      <div className="flex justify-between items-start text-[10px] font-mono px-2 py-1 bg-rose-50 dark:bg-rose-950/30 rounded">
        <span className="text-zinc-500">#{r.idx}</span>
        <span className="text-rose-500 max-w-[70%] truncate">{r.error}</span>
      </div>
    );
  }
  if (r.output_json) {
    return (
      <div className="px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded">
        <div className="text-[10px] font-mono text-zinc-500 mb-0.5">#{r.idx}</div>
        <div className="space-y-0.5">
          {Object.entries(r.output_json).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[10px] font-mono">
              <span className="text-zinc-500 shrink-0">{k}:</span>
              <span className={cn("min-w-0 break-words", valueColor(v))}>
                {typeof v === "string" ? v : fmtVal(v)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-between text-[10px] font-mono px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded">
      <span className="text-zinc-500">#{r.idx}</span>
      <span className={valueColor(r.score)}>
        {r.score == null ? "—" : fmtVal(r.score)}
      </span>
    </div>
  );
}

function PresetEditor(props: {
  draft: Editing;
  setDraft: (d: Editing) => void;
  models: string[];
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const { draft, setDraft, models, onSave, onCancel, saving, error } = props;
  const [schemaCheck, setSchemaCheck] = useState<{ ok: boolean; msg: string } | null>(null);

  function validateSchema() {
    const txt = draft.response_schema.trim();
    if (!txt) {
      setSchemaCheck({ ok: true, msg: "(empty — free-form mode)" });
      return;
    }
    try {
      const obj = JSON.parse(txt);
      if (typeof obj !== "object" || obj == null || Array.isArray(obj)) {
        setSchemaCheck({ ok: false, msg: "must be a JSON object" });
        return;
      }
      if (!("type" in obj)) {
        setSchemaCheck({ ok: false, msg: "missing top-level 'type'" });
        return;
      }
      setSchemaCheck({ ok: true, msg: "valid JSON object" });
    } catch (e) {
      setSchemaCheck({ ok: false, msg: String(e) });
    }
  }

  // Disable save unless required fields per kind are filled in.
  const saveDisabled = saving
    || !draft.name
    || (draft.kind === "prompt" && !draft.system_prompt)
    || (draft.kind === "scorer" && !draft.scorer_import_path.trim());

  return (
    <div className="px-3 py-3 space-y-2 text-xs bg-zinc-50 dark:bg-zinc-950">
      {/* Kind toggle. */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">backend</div>
        <div className="flex gap-1">
          {(["prompt", "scorer"] as JudgeKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setDraft({ ...draft, kind: k })}
              className={cn(
                "px-2 py-1 text-[10px] rounded font-mono flex-1",
                draft.kind === k
                  ? "bg-emerald-600 text-white"
                  : "bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300",
              )}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-zinc-500 mt-1">
          {draft.kind === "prompt"
            ? "system prompt template + optional JSON schema"
            : "import path to an inspect @scorer factory (resolved server-side)"}
        </div>
      </div>

      <Labeled label="name">
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono outline-none focus:border-emerald-500"
        />
      </Labeled>

      <Labeled label="description">
        <input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="one-line summary shown next to the name"
          className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded outline-none focus:border-emerald-500"
        />
      </Labeled>

      <div className="grid grid-cols-2 gap-2">
        <Labeled label="model">
          <select
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono outline-none focus:border-emerald-500"
          >
            <option value="">(default)</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Labeled>
        <Labeled label="score field">
          <input
            value={draft.score_field}
            onChange={(e) => setDraft({ ...draft, score_field: e.target.value })}
            placeholder="score"
            className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono outline-none focus:border-emerald-500"
          />
        </Labeled>
      </div>

      {draft.kind === "scorer" ? (
        <Labeled label="import path">
          <input
            value={draft.scorer_import_path}
            onChange={(e) => setDraft({ ...draft, scorer_import_path: e.target.value })}
            placeholder="my_project.judges:alignment_judge"
            spellCheck={false}
            className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono text-[11px] outline-none focus:border-emerald-500"
          />
          <div className="text-[10px] text-zinc-500 mt-1">
            <span className="font-mono">module.path:attr</span> · validated on save
          </div>
        </Labeled>
      ) : (
        <>
          <Labeled label="system prompt">
            <textarea
              value={draft.system_prompt}
              onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
              rows={10}
              placeholder="use {question} and {answer} placeholders"
              className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono text-[11px] outline-none focus:border-emerald-500 resize-y"
            />
          </Labeled>

          <Labeled label="response schema (optional)">
            <textarea
              value={draft.response_schema}
              onChange={(e) => {
                setDraft({ ...draft, response_schema: e.target.value });
                setSchemaCheck(null);
              }}
              rows={6}
              placeholder='{"type":"object","properties":{"score":{"type":"integer"},"reasoning":{"type":"string"}},"required":["score"]}'
              className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono text-[11px] outline-none focus:border-emerald-500 resize-y"
            />
            <div className="flex items-center gap-2 mt-1">
              <button
                onClick={validateSchema}
                type="button"
                className="text-[10px] px-2 py-0.5 bg-zinc-200 dark:bg-zinc-800 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700"
              >validate</button>
              {schemaCheck && (
                <span className={cn(
                  "text-[10px]",
                  schemaCheck.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500",
                )}>
                  {schemaCheck.ok ? "✓" : "✗"} {schemaCheck.msg}
                </span>
              )}
              <span className="ml-auto text-[10px] text-zinc-500">
                blank ⇒ free-form numeric parse
              </span>
            </div>
          </Labeled>
        </>
      )}

      {error && (
        <div className="text-[10px] text-rose-500 px-2 py-1 bg-rose-50 dark:bg-rose-950/30 rounded">
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={saveDisabled}
          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded disabled:opacity-50 text-[11px]"
        >{saving ? "saving…" : "save"}</button>
        <button
          onClick={onCancel}
          className="px-3 py-1 bg-zinc-200 dark:bg-zinc-800 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-[11px] flex items-center gap-1"
        ><X size={10} /> cancel</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">{label}</div>
      {children}
    </label>
  );
}
