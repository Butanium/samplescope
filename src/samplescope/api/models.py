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


class RowPage(BaseModel):
    """Paged window into a JSONL file."""
    rows: list[dict[str, Any]]
    indices: list[int]
    offset: int
    limit: int
    total_filtered: int


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
