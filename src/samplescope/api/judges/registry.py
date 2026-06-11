"""DB-backed CRUD over judge presets.

All presets live in ``state.judge_presets`` — there is no code-resident tier.
The registry is intentionally thin: it reads/writes rows and hydrates them
into ``JudgeSpec`` instances. Resolving scorer import paths happens in the
runner, not here, so this module never imports user code.

Settings (currently only ``default_judge_model``) live in
``state.app_settings`` and are accessed via the small helpers at the bottom.
"""
from __future__ import annotations

import json

from ..duck import cursor
from .spec import JudgeKind, JudgeSpec


_COLUMNS = (
    "name, description, kind, scorer_import_path, system_prompt, "
    "score_field, response_schema, model"
)


def _row_to_spec(row: tuple) -> JudgeSpec:
    """Hydrate a ``state.judge_presets`` row into a ``JudgeSpec``."""
    (
        name,
        description,
        kind,
        scorer_import_path,
        system_prompt,
        score_field,
        response_schema,
        model,
    ) = row
    schema = json.loads(response_schema) if response_schema else None
    return JudgeSpec(
        name=name,
        description=description or "",
        kind=(kind or "prompt"),  # type: ignore[arg-type]
        scorer_import_path=scorer_import_path,
        system_prompt=system_prompt,
        score_field=score_field or "score",
        response_schema=schema,
        model=model,
    )


def list_all() -> list[JudgeSpec]:
    """Every preset, ordered by name."""
    with cursor() as cur:
        rows = cur.execute(
            f"SELECT {_COLUMNS} FROM state.judge_presets ORDER BY name"
        ).fetchall()
    return [_row_to_spec(r) for r in rows]


def get(name: str) -> JudgeSpec | None:
    """Resolve one preset by name."""
    with cursor() as cur:
        r = cur.execute(
            f"SELECT {_COLUMNS} FROM state.judge_presets WHERE name = ?",
            [name],
        ).fetchone()
    return _row_to_spec(r) if r else None


def upsert(spec: JudgeSpec) -> JudgeSpec:
    """Create or replace a preset.

    Caller is responsible for kind-appropriate validation
    (system_prompt non-empty for prompt; import path resolves for scorer);
    routes layer does this so 4xxs are surfaced cleanly.
    """
    schema_json = (
        json.dumps(spec.response_schema) if spec.response_schema is not None else None
    )
    with cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO state.judge_presets({_COLUMNS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET
                description = excluded.description,
                kind = excluded.kind,
                scorer_import_path = excluded.scorer_import_path,
                system_prompt = excluded.system_prompt,
                score_field = excluded.score_field,
                response_schema = excluded.response_schema,
                model = excluded.model
            """,
            [
                spec.name,
                spec.description,
                spec.kind,
                spec.scorer_import_path,
                spec.system_prompt or "",
                spec.score_field,
                schema_json,
                spec.model,
            ],
        )
    return spec


def delete(name: str) -> None:
    """Delete a preset; no-op if absent."""
    with cursor() as cur:
        cur.execute("DELETE FROM state.judge_presets WHERE name = ?", [name])


def get_default_model() -> str | None:
    """Read ``app_settings.default_judge_model``; ``None`` if unset."""
    with cursor() as cur:
        r = cur.execute(
            "SELECT value FROM state.app_settings WHERE key = 'default_judge_model'"
        ).fetchone()
    return r[0] if r else None


def set_default_model(model_id: str) -> None:
    """Upsert ``app_settings.default_judge_model``."""
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO state.app_settings(key, value) VALUES ('default_judge_model', ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value
            """,
            [model_id],
        )
