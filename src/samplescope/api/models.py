"""Pydantic request/response models — kept thin; mirrored on the TS side."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel

from .schema_detect import FileKind, ViewKind


class DatasetEntry(BaseModel):
    """One discoverable file in the scan roots."""
    path: str
    name: str
    size_bytes: int
    kind: FileKind
    parent: str


class DatasetInfo(BaseModel):
    """Resolved metadata after opening a file."""
    path: str
    view_kind: ViewKind
    row_count: int
    columns: list[str]
    detect_meta: dict[str, Any] = {}


class FilterSpec(BaseModel):
    """One regex filter. ``column=None`` matches anywhere in the row (to_json);
    otherwise the regex is applied to that column CAST to VARCHAR."""
    column: str | None = None
    regex: str


class FilterUpdate(BaseModel):
    """Full-replace payload for ``POST /api/datasets/filter``. An empty list
    clears all filters. The active list is AND-composed on every read."""
    filters: list[FilterSpec] = []


class RowPage(BaseModel):
    """Paged window into a JSONL file."""
    rows: list[dict[str, Any]]
    indices: list[int]
    offset: int
    limit: int
    total_filtered: int


class GroupBucket(BaseModel):
    """One group: a distinct value of the group-by column + its member row idxs,
    in visible order."""
    value: str | None
    indices: list[int]


class GroupsResponse(BaseModel):
    """Samples bucketed by a column's value, over the current filter/sort/shuffle.
    Groups are ordered by first appearance in the visible order."""
    column: str
    groups: list[GroupBucket]
    total_groups: int
    total_rows: int
    truncated: bool


class ColumnHistogram(BaseModel):
    bin_edges: list[float]   # len == len(counts) + 1, monotone
    counts: list[int]
    is_length: bool = False  # histogram of string/list LENGTHS, not values


class TopValue(BaseModel):
    value: str
    count: int


class ColumnStats(BaseModel):
    name: str
    dtype: Literal["numeric", "boolean", "categorical", "text", "list", "struct", "other"]
    count: int               # non-null count
    nulls: int
    distinct: int | None = None   # None where DISTINCT is not computable (structs)
    index_like: bool = False
    min: float | None = None
    max: float | None = None
    mean: float | None = None
    median: float | None = None
    histogram: ColumnHistogram | None = None
    top_values: list[TopValue] | None = None  # top 20 by count, desc
    other_count: int = 0     # non-null rows not covered by top_values


class StatsResponse(BaseModel):
    path: str
    total_rows: int          # rows AFTER filter/selection
    columns: list[ColumnStats]


class MarkRecord(BaseModel):
    dataset_path: str
    row_idx: int
    row_hash: str
    tags: list[str] = []
    note: str = ""


class JudgePreset(BaseModel):
    """Wire shape for a judge preset.

    ``kind`` discriminates two backends:

    * ``"prompt"`` — uses ``system_prompt`` + optional ``response_schema``.
      ``response_schema`` is a JSON-encoded JSON-Schema string (opaque on the
      wire; the server parses + validates it).
    * ``"scorer"`` — uses ``scorer_import_path`` (``"module.path:attr"``)
      pointing at an inspect ``@scorer``-decorated factory.

    All presets are user-editable; there is no protected built-in tier.
    """
    name: str
    description: Optional[str] = None
    kind: Literal["prompt", "scorer"] = "prompt"
    scorer_import_path: Optional[str] = None
    system_prompt: str = ""
    score_field: str = "score"
    response_schema: Optional[str] = None
    model: Optional[str] = None


class JudgeRunRequest(BaseModel):
    preset_name: str
    dataset_path: str
    indices: list[int]
    model: Optional[str] = None


class JudgeSettings(BaseModel):
    """Single-key settings payload. Currently only ``default_judge_model``."""
    default_judge_model: str


class ChatMessageRequest(BaseModel):
    text: str
    inject_current_row: bool = True
    permission_mode: Literal["acceptEdits", "default", "bypassPermissions"] = "acceptEdits"


class HighlightRule(BaseModel):
    """A user-defined highlight rule.

    Substring or regex pattern, optionally scoped by message role or table
    column, and optionally gated by a JS expression evaluated client-side
    against ``(row, msg)``. Stored verbatim; condition strings are intentionally
    eval'd in the browser via ``new Function`` (single-user local app).
    """
    id: str
    name: str
    enabled: bool = True
    # `patterns` is the source of truth; `pattern` is kept as the legacy single
    # value (= patterns[0]) for back-compat with anything still reading it.
    patterns: list[str] = []
    pattern: str = ""
    # How multiple patterns combine: "or" paints any match; "and" paints all
    # matches only when every pattern is present in the scoped text.
    combinator: str = "or"
    is_regex: bool = False
    case_sensitive: bool = False
    color: str
    scope_role: Optional[str] = None
    scope_column: Optional[str] = None
    condition: Optional[str] = None
    sort_order: int = 0
