"""Run one ``JudgeSpec`` against one row through ``inspect_ai``.

Two paths, dispatched on ``spec.kind``:

* ``"scorer"`` — the spec carries a ``"module:attr"`` import path. The runner
  resolves it lazily via ``importlib`` (so the viewer stays project-agnostic),
  builds a minimal ``TaskState`` from the row, pins the inspect "grader" role
  to the resolved model so the scorer's ``get_model(role="grader", ...)`` call
  picks up our model, and awaits the inner ``score(state, target)``. Refusal
  (NaN ``Score.value`` or ``None`` return) maps to ``score=None`` with an
  ``error`` flag.
* ``"prompt"`` — the spec carries a ``system_prompt`` template (with
  ``{question}/{answer}`` slots) and an optional ``response_schema``. Sent to
  ``get_model(...).generate(...)`` with structured-output config when a schema
  is set; parsed back into ``output_json`` plus ``score`` plucked from
  ``score_field``.

Model resolution (both paths):
    ``model_override > spec.model > app_settings.default_judge_model > FALLBACK_JUDGE_MODEL``

The grader role used for the scorer path is the inspect convention ``"grader"``
(see e.g. ``model_graded_qa``'s ``model_role`` default). It's hardcoded here on
purpose — keeping it configurable per-judge is a future feature, not a current
need.
"""
from __future__ import annotations

import importlib
import json
import math
import re
from typing import Any, Callable

from inspect_ai.model import (
    ChatMessageSystem,
    ChatMessageUser,
    GenerateConfig,
    ModelName,
    ModelOutput,
    ResponseSchema,
    get_model,
)
from inspect_ai.model._model import init_model_roles  # not in the public surface
from inspect_ai.scorer import Target
from inspect_ai.solver import TaskState

from ..settings import FALLBACK_JUDGE_MODEL
from .registry import get_default_model
from .spec import JudgeSpec


GRADER_ROLE = "grader"


_SCORE_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _row_to_qa(row: dict[str, Any]) -> tuple[str, str]:
    """Pull a ``(question, answer)`` pair out of a row, regardless of shape.

    - chat-format: last user message → question, last assistant message → answer
    - flat: try common fields; fall back to a JSON dump for the question.
    """
    msgs = row.get("messages")
    if isinstance(msgs, list) and msgs:
        question = next(
            (m.get("content", "") for m in reversed(msgs) if m.get("role") == "user"),
            "",
        )
        answer = next(
            (m.get("content", "") for m in reversed(msgs) if m.get("role") == "assistant"),
            "",
        )
        return str(question), str(answer)
    q = row.get("question") or row.get("prompt") or row.get("input") or ""
    a = row.get("answer") or row.get("response") or row.get("output") or ""
    if q or a:
        return str(q), str(a)
    return "", json.dumps(row, indent=2, default=str)[:4000]


def _parse_score(text: str, score_field: str) -> tuple[float | None, str]:
    """Free-form score extraction. The rest of the response becomes reasoning.

    Order of attempts:
    1. JSON object containing ``score_field``
    2. ``score_field: <num>`` substring
    3. The last number anywhere in the text (matches llmcomp judges that
       end with just a number).
    """
    s = text.strip()
    if s.upper().startswith("REFUSAL"):
        return None, "judge refused"
    try:
        obj = json.loads(s)
        if isinstance(obj, dict) and score_field in obj:
            val = obj[score_field]
            return (
                float(val) if isinstance(val, (int, float)) else None,
                obj.get("reasoning", "") or "",
            )
    except json.JSONDecodeError:
        pass
    field_re = re.compile(
        rf"{re.escape(score_field)}\s*[:=]\s*(-?\d+(?:\.\d+)?)", re.IGNORECASE
    )
    m = field_re.search(s)
    if m:
        return float(m.group(1)), s
    nums = _SCORE_RE.findall(s)
    if nums:
        return float(nums[-1]), s
    return None, s


def _resolve_model(spec: JudgeSpec, override: str | None) -> str:
    """Pick the inspect provider/model id for this run.

    Order: explicit ``override`` arg → ``spec.model`` → app_settings default → constant.
    """
    return override or spec.model or get_default_model() or FALLBACK_JUDGE_MODEL


def resolve_scorer_factory(import_path: str) -> Callable:
    """Resolve ``"module.path:attr"`` to a callable factory.

    Raises ``ValueError`` with a clear message on bad syntax, missing module,
    missing attribute, or non-callable target. The string format mirrors
    Python entrypoint convention (``setuptools``, ``importlib.metadata``).
    """
    if ":" not in import_path:
        raise ValueError(
            f"import path must be 'module.path:attr', got: {import_path!r}"
        )
    module_path, attr = import_path.split(":", 1)
    module_path = module_path.strip()
    attr = attr.strip()
    if not module_path or not attr:
        raise ValueError(f"empty module or attr in import path: {import_path!r}")
    try:
        mod = importlib.import_module(module_path)
    except ImportError as e:
        raise ValueError(f"could not import {module_path!r}: {e}") from e
    if not hasattr(mod, attr):
        raise ValueError(f"{attr!r} not found in {module_path}")
    fn = getattr(mod, attr)
    if not callable(fn):
        raise ValueError(f"{import_path!r} resolved to a non-callable ({type(fn).__name__})")
    return fn


def _make_task_state(question: str, answer: str, model_id: str) -> TaskState:
    """Minimal TaskState so a scorer can be invoked outside an eval context."""
    output = ModelOutput.from_content(model=model_id, content=answer)
    user_msg = ChatMessageUser(content=question)
    return TaskState(
        model=ModelName(model_id),
        sample_id=0,
        epoch=0,
        input=[user_msg],
        messages=[user_msg],
        output=output,
    )


async def _run_scorer(spec: JudgeSpec, row: dict[str, Any], model_id: str) -> dict[str, Any]:
    """Resolve ``spec.scorer_import_path`` and call the resulting inspect scorer."""
    assert spec.scorer_import_path
    try:
        factory = resolve_scorer_factory(spec.scorer_import_path)
    except ValueError as e:
        return {
            "score": None,
            "reasoning": "",
            "raw_response": "",
            "output_json": None,
            "error": str(e),
        }
    question, answer = _row_to_qa(row)
    state = _make_task_state(question, answer, model_id)
    init_model_roles({GRADER_ROLE: get_model(model_id)})
    try:
        score_fn = factory()
        result = await score_fn(state, Target(""))
    except Exception as e:
        return {
            "score": None,
            "reasoning": "",
            "raw_response": "",
            "output_json": None,
            "error": f"{type(e).__name__}: {e}",
        }
    if result is None:
        return {
            "score": None,
            "reasoning": "",
            "raw_response": "",
            "output_json": None,
            "error": "refusal",
        }
    val = result.value
    if isinstance(val, float) and math.isnan(val):
        score, error = None, "refusal (NaN rating)"
    elif isinstance(val, (int, float, bool)):
        score, error = float(val), None
    else:
        score, error = None, None
    return {
        "score": score,
        "reasoning": "",
        "raw_response": str(result.answer or ""),
        "output_json": None,
        "error": error,
    }


async def _run_prompt(spec: JudgeSpec, row: dict[str, Any], model_id: str) -> dict[str, Any]:
    """Call ``get_model(...).generate(...)`` with the user-defined prompt template."""
    assert spec.system_prompt is not None
    question, answer = _row_to_qa(row)
    rendered = spec.system_prompt.format(question=question, answer=answer)
    if spec.response_schema is not None:
        config = GenerateConfig(
            temperature=0.0,
            max_tokens=400,
            response_schema=ResponseSchema(
                name="judge", json_schema=spec.response_schema, strict=True,
            ),
        )
    else:
        config = GenerateConfig(temperature=0.0, max_tokens=400)
    try:
        out = await get_model(model_id).generate(
            input=[ChatMessageSystem(content=rendered), ChatMessageUser(content="")],
            config=config,
        )
    except Exception as e:
        return {
            "score": None,
            "reasoning": "",
            "raw_response": "",
            "output_json": None,
            "error": f"{type(e).__name__}: {e}",
        }
    text = (out.completion or "").strip()
    if spec.response_schema is not None:
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as e:
            return {
                "score": None,
                "reasoning": "",
                "raw_response": text,
                "output_json": None,
                "error": f"schema parse failed: {e}",
            }
        val = obj.get(spec.score_field)
        score = float(val) if isinstance(val, (int, float, bool)) else None
        return {
            "score": score,
            "reasoning": str(obj.get("reasoning", "") or ""),
            "raw_response": text,
            "output_json": obj,
            "error": None,
        }
    score, reasoning = _parse_score(text, spec.score_field)
    return {
        "score": score,
        "reasoning": reasoning,
        "raw_response": text,
        "output_json": None,
        "error": None,
    }


async def run_judge(
    spec: JudgeSpec,
    row: dict[str, Any],
    model_override: str | None = None,
) -> dict[str, Any]:
    """Score one row. Returns ``{score, reasoning, raw_response, output_json, error}``.

    All inspect / parse / import failures populate ``error`` rather than raise.
    """
    model_id = _resolve_model(spec, model_override)
    if spec.kind == "scorer":
        if not spec.scorer_import_path:
            return {
                "score": None,
                "reasoning": "",
                "raw_response": "",
                "output_json": None,
                "error": "scorer kind requires scorer_import_path",
            }
        return await _run_scorer(spec, row, model_id)
    if spec.kind == "prompt":
        if not spec.system_prompt:
            return {
                "score": None,
                "reasoning": "",
                "raw_response": "",
                "output_json": None,
                "error": "prompt kind requires a non-empty system_prompt",
            }
        return await _run_prompt(spec, row, model_id)
    return {
        "score": None,
        "reasoning": "",
        "raw_response": "",
        "output_json": None,
        "error": f"unknown judge kind: {spec.kind!r}",
    }
