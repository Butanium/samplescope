"""Judges package.

* ``spec.JudgeSpec`` is the single in-memory shape; ``kind`` discriminates
  ``"prompt"`` (system-prompt + optional JSON schema) from ``"scorer"``
  (a ``"module:attr"`` import path resolved via ``importlib``).
* ``registry`` is thin DB CRUD over ``state.judge_presets`` plus
  ``state.app_settings.default_judge_model``. It never imports user code.
* ``runner`` runs a spec against a row through ``inspect_ai`` — for scorer
  kinds it lazily resolves the import path and delegates to the user's
  ``@scorer`` factory.

The package itself does not import any project-specific judges. Seed your
preferred starter set via the CLI: ``sscope view add-judge <name> --import-path
mod.path:fn --description "…"``.
"""
from .registry import (
    delete,
    get,
    get_default_model,
    list_all,
    set_default_model,
    upsert,
)
from .runner import resolve_scorer_factory, run_judge
from .spec import JudgeKind, JudgeSpec

__all__ = [
    "JudgeKind",
    "JudgeSpec",
    "delete",
    "get",
    "get_default_model",
    "list_all",
    "resolve_scorer_factory",
    "run_judge",
    "set_default_model",
    "upsert",
]
