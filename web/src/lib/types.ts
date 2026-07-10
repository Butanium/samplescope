// Backend-derived types are GENERATED from the FastAPI OpenAPI schema into
// ./api-types.gen.ts. Regenerate with `npm run gen:types` after changing any
// Pydantic model in src/samplescope/api/. Aliasing them here keeps the import
// surface stable (`import type { DatasetEntry } from "../lib/types"`) while
// making the wire shapes — and especially the `kind` / `view_kind` enums —
// impossible to drift from the Python source. tests/test_codegen.py fails if
// the committed api-types.gen.ts is stale.
//
// The hand-written block below the divider is intentional: either the client
// deliberately refines the wire shape (RowPage rows kept as `any` so views can
// index freely; HighlightRule.combinator narrowed to a union the backend types
// as a bare str) or there is no backend model at all (ViewerState is an SSE
// dataclass; JudgeResult / PlotTab / ChatBlock are not response models).

import type { components } from "./api-types.gen";

type Schemas = components["schemas"];

// ── Generated from backend Pydantic models ──────────────────────────────────

export type DatasetEntry = Schemas["DatasetEntry"];
export type DatasetInfo = Schemas["DatasetInfo"];
export type MarkRecord = Schemas["MarkRecord"];
export type JudgePreset = Schemas["JudgePreset"];
export type JudgeSettings = Schemas["JudgeSettings"];
export type GroupBucket = Schemas["GroupBucket"];
export type GroupsResponse = Schemas["GroupsResponse"];
export type ColumnStats = Schemas["ColumnStats"];
export type StatsResponse = Schemas["StatsResponse"];

/** File-tree classification, derived from a file's extension. */
export type FileKind = DatasetEntry["kind"];
/** The detected renderer for an opened dataset. */
export type ViewKind = DatasetInfo["view_kind"];
/**
 * Judge backend discriminator:
 * - "prompt": uses ``system_prompt`` + optional ``response_schema``.
 * - "scorer": uses ``scorer_import_path`` ("module.path:attr") to point at an
 *   inspect ``@scorer``-decorated factory, resolved server-side.
 */
export type JudgeKind = JudgePreset["kind"];

// ── Hand-written (deliberate client refinements / no backend model) ──────────

export type RowPage = {
  // Kept as `any` (not the generated `unknown`) so views can index/plot rows
  // freely. The backend shape is `dict[str, Any]` either way.
  rows: Record<string, any>[];
  indices: number[];
  offset: number;
  limit: number;
  total_filtered: number;
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

export type HighlightRule = {
  id: string;
  name: string;
  enabled: boolean;
  /** The patterns to match. Combined per `combinator`. */
  patterns: string[];
  /** Legacy single value (= patterns[0]); kept for back-compat. */
  pattern?: string;
  /**
   * "or" paints any match; "and" paints all only when every pattern is present.
   * Narrower than the backend (which types this as a bare str).
   */
  combinator: "or" | "and";
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
  view_kind: ViewKind | null;
  row_count: number;
  columns: string[];
  numeric_cols: string[];
  tabular: boolean;
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
