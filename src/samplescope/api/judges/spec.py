"""Single in-memory shape for every judge preset.

A ``JudgeSpec`` carries one of two backends, discriminated by ``kind``:

* ``"prompt"`` — system prompt (with ``{question}/{answer}`` slots) sent to
  ``inspect_ai.model.get_model().generate()``, with optional JSON-schema
  structured output.
* ``"scorer"`` — a fully-qualified import path (``"module.path:attr"``) to an
  inspect ``@scorer``-decorated factory. Resolved lazily by the runner via
  ``importlib`` so the viewer stays project-agnostic.

Every preset lives in DuckDB; there is no code-resident "built-in" tier.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


JudgeKind = Literal["prompt", "scorer"]


@dataclass(frozen=True)
class JudgeSpec:
    """One judge preset."""

    name: str
    description: str = ""
    kind: JudgeKind = "prompt"

    # Scorer kind: fully-qualified import path "module.submodule:attr".
    scorer_import_path: str | None = None

    # Prompt kind: template with ``{question}`` / ``{answer}`` slots.
    system_prompt: str | None = None
    score_field: str = "score"
    # Parsed JSON-schema dict; None ⇒ free-form numeric parse.
    response_schema: dict[str, Any] | None = None

    # Optional inspect provider/model override (e.g. "openai/gpt-4.1-2025-04-14").
    # None falls through to ``app_settings.default_judge_model`` → ``FALLBACK_JUDGE_MODEL``.
    model: str | None = None
