// Mirrors apps/samplescope/api/models.py.

export type DatasetEntry = {
  path: string;
  name: string;
  size_bytes: number;
  kind: "jsonl" | "csv" | "eval" | "json" | "pdf" | "image" | "other";
  parent: string;
};

export type DatasetInfo = {
  path: string;
  view_kind: "chat" | "table" | "metrics" | "eval_log" | "json";
  row_count: number;
  columns: string[];
  detect_meta: Record<string, unknown>;
};

export type RowPage = {
  rows: Record<string, any>[];
  indices: number[];
  offset: number;
  limit: number;
  total_filtered: number;
};

export type MarkRecord = {
  dataset_path: string;
  row_idx: number;
  row_hash: string;
  tags: string[];
  note: string;
};

export type JudgeKind = "prompt" | "scorer";

export type JudgePreset = {
  name: string;
  description?: string | null;
  /**
   * Backend discriminator:
   * - "prompt": uses ``system_prompt`` + optional ``response_schema``.
   * - "scorer": uses ``scorer_import_path`` ("module.path:attr") to point at
   *   an inspect ``@scorer``-decorated factory, resolved server-side.
   */
  kind: JudgeKind;
  /** Scorer kind only. */
  scorer_import_path?: string | null;
  /** Prompt kind: template with {question}/{answer} slots. */
  system_prompt: string;
  score_field: string;
  /** Prompt kind only; JSON-schema string. null/undefined ⇒ free-form numeric parse. */
  response_schema?: string | null;
  /** Inspect provider/model id, e.g. "openai/gpt-4.1-2025-04-14". */
  model?: string | null;
};

export type JudgeResult = {
  dataset_path: string;
  row_idx: number;
  preset_name: string;
  score: number | null;
  reasoning: string | null;
  error: string | null;
  /** Full structured response when the preset has a schema; null otherwise. */
  output_json?: Record<string, any> | null;
  created_at: string;
};

export type JudgeSettings = {
  default_judge_model: string;
};

export type HighlightRule = {
  id: string;
  name: string;
  enabled: boolean;
  pattern: string;
  is_regex: boolean;
  case_sensitive: boolean;
  /** Hex color, e.g. "#fde047". The frontend appends an alpha for the mark bg. */
  color: string;
  /** Restrict to one chat role (null = match any). */
  scope_role?: string | null;
  /** Restrict to one table column (null = match any). */
  scope_column?: string | null;
  /** JS expression eval'd via `new Function('row','msg', 'return (<expr>)')`. */
  condition?: string | null;
  sort_order: number;
};

export type PlotTabKind = "image" | "pdf" | "plotly";

export type PlotTab = {
  id: string;
  kind: PlotTabKind;
  title: string | null;
  /** Repo-rooted path for image/pdf tabs; null for plotly. */
  source_path: string | null;
  /** Plotly figure spec (data + layout) for plotly tabs; null otherwise. */
  payload: any | null;
  position: number;
  created_at: string;
};

export type ViewerState = {
  dataset_path: string | null;
  view_kind: string | null;
  row_count: number;
  columns: string[];
  row_idx: number;
  filter_regex: string | null;
  filter_column: string | null;
  shuffle_seed: number | null;
  sort_column: string | null;
  sort_desc: boolean;
  sql_query: string | null;
  /** "off" | "selection" | "view" */
  sql_mode: string;
  sql_selection_count: number | null;
  sample_n: number | null;
  last_event: string | null;
  last_event_ts: number;
};

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: any }
  | { type: "unknown"; repr: string };

export type ChatMessage =
  | { role: "user"; content: ChatBlock[] }
  | { role: "assistant"; model: string; content: ChatBlock[] }
  | { role: "system"; subtype?: string; data?: any }
  | {
      role: "result";
      subtype: string;
      duration_ms: number;
      is_error: boolean;
      num_turns: number;
      total_cost_usd: number | null;
    };
