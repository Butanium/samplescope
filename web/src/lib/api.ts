import type {
  DatasetEntry, DatasetInfo, RowPage, MarkRecord, JudgePreset, JudgeResult,
  JudgeSettings, ViewerState, HighlightRule, PlotTab,
} from "./types";

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  health: () => j<{ ok: boolean; chat_available?: boolean }>("/api/health"),
  // datasets
  listDatasets: () => j<DatasetEntry[]>("/api/datasets"),
  datasetInfo: (path: string) =>
    j<DatasetInfo>(`/api/datasets/info?path=${encodeURIComponent(path)}`),
  rows: (q: {
    path: string; offset?: number; limit?: number;
    filter_regex?: string | null; filter_column?: string | null;
    shuffle_seed?: number | null;
    sort_column?: string | null; sort_desc?: boolean;
  }) => {
    const p = new URLSearchParams();
    p.set("path", q.path);
    if (q.offset != null) p.set("offset", String(q.offset));
    if (q.limit != null) p.set("limit", String(q.limit));
    if (q.filter_regex) p.set("filter_regex", q.filter_regex);
    if (q.filter_column) p.set("filter_column", q.filter_column);
    if (q.shuffle_seed != null) p.set("shuffle_seed", String(q.shuffle_seed));
    if (q.sort_column) p.set("sort_column", q.sort_column);
    if (q.sort_desc) p.set("sort_desc", "true");
    return j<RowPage>(`/api/datasets/rows?${p}`);
  },
  row: (path: string, idx: number) =>
    j<Record<string, any>>(`/api/datasets/row?path=${encodeURIComponent(path)}&idx=${idx}`),
  sample: (path: string, n: number) =>
    j<RowPage>(`/api/datasets/sample?path=${encodeURIComponent(path)}&n=${n}`),
  openDataset: (path: string) =>
    j<DatasetInfo>("/api/datasets/open", { method: "POST", body: JSON.stringify({ path }) }),
  goto: (idx: number) =>
    j<unknown>("/api/datasets/goto", { method: "POST", body: JSON.stringify({ idx }) }),
  setFilter: (regex: string | null, column: string | null) =>
    j<unknown>("/api/datasets/filter", { method: "POST", body: JSON.stringify({ regex, column }) }),
  shuffle: (seed?: number) =>
    j<{ seed: number }>("/api/datasets/shuffle", { method: "POST", body: JSON.stringify({ seed }) }),
  setSort: (column: string | null, desc = false) =>
    j<{ ok: true; column: string | null; desc: boolean }>("/api/datasets/sort", {
      method: "POST", body: JSON.stringify({ column, desc }),
    }),
  sql: (sql: string, path?: string) =>
    j<{ columns: string[]; rows: any[][] }>("/api/datasets/sql", {
      method: "POST", body: JSON.stringify({ sql, path }),
    }),
  sqlApply: (mode: "off" | "selection" | "view", sql?: string) =>
    j<{ ok: true; mode: string; selection_count: number | null }>("/api/datasets/sql_apply", {
      method: "POST", body: JSON.stringify({ mode, sql }),
    }),
  sqlFromNl: (prompt: string, model: "sonnet" | "opus" | "haiku" = "sonnet") =>
    j<{ sql: string; explanation: string; model: string }>("/api/datasets/sql_nl", {
      method: "POST", body: JSON.stringify({ prompt, model }),
    }),
  // marks
  listMarks: (datasetPath?: string) => {
    const q = datasetPath ? `?dataset_path=${encodeURIComponent(datasetPath)}` : "";
    return j<MarkRecord[]>(`/api/marks${q}`);
  },
  getMark: (path: string, idx: number) =>
    j<MarkRecord | null>(`/api/marks/${encodeURIComponent(path)}/${idx}`),
  upsertMark: (path: string, idx: number, body: { tags: string[]; note: string }) =>
    j<MarkRecord>(`/api/marks/${encodeURIComponent(path)}/${idx}`, {
      method: "PUT", body: JSON.stringify(body),
    }),
  deleteMark: (path: string, idx: number) =>
    j<unknown>(`/api/marks/${encodeURIComponent(path)}/${idx}`, { method: "DELETE" }),
  // judges
  listPresets: () => j<JudgePreset[]>("/api/judges/presets"),
  upsertPreset: (name: string, body: Omit<JudgePreset, "name">) =>
    j<JudgePreset>(`/api/judges/presets/${encodeURIComponent(name)}`, {
      method: "PUT", body: JSON.stringify(body),
    }),
  deletePreset: (name: string) =>
    j<unknown>(`/api/judges/presets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  judgeResults: (datasetPath?: string, presetName?: string) => {
    const p = new URLSearchParams();
    if (datasetPath) p.set("dataset_path", datasetPath);
    if (presetName) p.set("preset_name", presetName);
    return j<JudgeResult[]>(`/api/judges/results?${p}`);
  },
  getJudgeSettings: () => j<JudgeSettings>("/api/judges/settings"),
  setJudgeSettings: (body: JudgeSettings) =>
    j<JudgeSettings>("/api/judges/settings", { method: "PUT", body: JSON.stringify(body) }),
  listJudgeModels: () => j<string[]>("/api/judges/models"),
  // highlights
  listHighlights: () => j<HighlightRule[]>("/api/highlights"),
  upsertHighlight: (id: string, body: Omit<HighlightRule, "id">) =>
    j<HighlightRule>(`/api/highlights/${encodeURIComponent(id)}`, {
      method: "PUT", body: JSON.stringify({ id, ...body }),
    }),
  deleteHighlight: (id: string) =>
    j<unknown>(`/api/highlights/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reorderHighlights: (ids: string[]) =>
    j<{ ok: true; n: number }>("/api/highlights/reorder", {
      method: "POST", body: JSON.stringify({ ids }),
    }),
  // eval logs
  evalHeader: (path: string) =>
    j<any>(`/api/eval-logs/header?path=${encodeURIComponent(path)}`),
  evalSamples: (path: string, offset = 0, limit = 50) =>
    j<{ samples: any[]; offset: number; limit: number; total: number }>(
      `/api/eval-logs/samples?path=${encodeURIComponent(path)}&offset=${offset}&limit=${limit}`,
    ),
  // metrics
  metrics: (path: string, columns?: string[]) => {
    const c = columns?.length ? `&columns=${encodeURIComponent(columns.join(","))}` : "";
    return j<{ columns: string[]; rows: any[] }>(
      `/api/metrics?path=${encodeURIComponent(path)}${c}`,
    );
  },
  // state
  state: () => j<ViewerState>("/api/state"),
  // chat
  createSession: (label?: string, permission_mode = "acceptEdits") =>
    j<{ session_id: string; permission_mode: string }>("/api/chat/sessions", {
      method: "POST", body: JSON.stringify({ label, permission_mode }),
    }),
  closeSession: (id: string) =>
    j<unknown>(`/api/chat/sessions/${id}`, { method: "DELETE" }),
  sessionHistory: (id: string) =>
    j<{ seq: number; role: string; payload: any; created_at: string }[]>(
      `/api/chat/sessions/${id}/history`,
    ),
  sendMessage: (id: string, body: { text: string; inject_current_row?: boolean; permission_mode?: string }) =>
    j<{ ok: true; mid_turn: boolean }>(`/api/chat/sessions/${id}/messages`, {
      method: "POST", body: JSON.stringify({ inject_current_row: true, permission_mode: "acceptEdits", ...body }),
    }),
  interruptSession: (id: string) =>
    j<{ ok: boolean }>(`/api/chat/sessions/${id}/interrupt`, { method: "POST" }),
  resumeSession: (id: string) =>
    j<{ ok: boolean; resumed: boolean; already_live?: boolean }>(
      `/api/chat/sessions/${id}/resume`, { method: "POST" },
    ),
  setPermissionMode: (id: string, mode: string) =>
    j<{ ok: true; permission_mode: string }>(`/api/chat/sessions/${id}/permission_mode`, {
      method: "POST", body: JSON.stringify({ permission_mode: mode }),
    }),
  listSessions: () =>
    j<{ id: string; label: string | null; created_at: string; live: boolean }[]>("/api/chat/sessions"),
  // plots
  listPlots: () => j<PlotTab[]>("/api/plots"),
  addPlot: (body: { kind: "image" | "pdf" | "plotly"; title?: string; source_path?: string; payload?: any }) =>
    j<{ id: string; existing: boolean }>("/api/plots", { method: "POST", body: JSON.stringify(body) }),
  deletePlot: (id: string) => j<unknown>(`/api/plots/${id}`, { method: "DELETE" }),
  closePlots: (body: { mode: "all" | "others" | "selection"; keep?: string; ids?: string[] }) =>
    j<unknown>("/api/plots/close", { method: "POST", body: JSON.stringify(body) }),
  reorderPlots: (ids: string[]) =>
    j<{ ok: true; n: number }>("/api/plots/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  /** URL for serving a repo-rooted image/PDF directly to <img> / <embed>. */
  fileUrl: (path: string) => `/api/datasets/file?path=${encodeURIComponent(path)}`,
};

/**
 * Open an SSE connection. Returns an unsubscribe function.
 * Each delivered event is `{ event, data }` — `data` is parsed JSON when possible.
 */
export function sse(
  path: string,
  onEvent: (event: string, data: any) => void,
  onError?: (e: Event) => void,
): () => void {
  const es = new EventSource(path);
  const handler = (event: string) => (e: MessageEvent) => {
    let parsed: any = e.data;
    try { parsed = JSON.parse(e.data); } catch {}
    onEvent(event, parsed);
  };
  // Generic types we use; EventSource only fires named events if you addEventListener for them.
  for (const evt of [
    "snapshot", "patch", "ping",
    "message", "user_input", "error", "turn_start", "turn_end",
    "result", "done",
    "tabs",
  ]) {
    es.addEventListener(evt, handler(evt) as any);
  }
  es.onerror = (e) => onError?.(e);
  return () => es.close();
}
