"""Judges: presets CRUD, settings, model picker, batch runner.

Layout:
- ``GET /api/judges/presets`` lists everything (alphabetical).
- ``PUT/DELETE /api/judges/presets/{name}`` mutate.
- ``GET/PUT /api/judges/settings`` reads/writes ``state.app_settings.default_judge_model``.
- ``GET /api/judges/models`` returns a curated provider/model id list for the UI dropdown.
- ``POST /api/judges/run`` streams per-row results over SSE; persists ``output_json``
  alongside the legacy ``score`` so renderers can show every schema field.

There is no built-in tier — the package is project-agnostic. Seed your
preferred starter judges with ``viewer add-judge … --import-path …`` after a
fresh DB.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from ..duck import cursor, row_hash
from ..judges import (
    JudgeSpec,
    delete as registry_delete,
    get as registry_get,
    get_default_model,
    list_all,
    resolve_scorer_factory,
    run_judge,
    set_default_model,
    upsert as registry_upsert,
)
from ..models import JudgePreset, JudgeRunRequest, JudgeSettings
from ..routes.datasets import read_one_row

router = APIRouter(prefix="/api/judges", tags=["judges"])


# Hardcoded for now — dynamic provider discovery is out of scope. Order matters:
# the first entry is the suggested default the UI dropdown highlights.
CURATED_MODELS: list[str] = [
    "openai/gpt-4.1-2025-04-14",
    "openai/gpt-4o-2024-08-06",
    "anthropic/claude-opus-4-7",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5-20251001",
]


def _spec_to_preset(s: JudgeSpec) -> JudgePreset:
    """Wire-format a JudgeSpec, serialising the parsed schema dict back to JSON."""
    return JudgePreset(
        name=s.name,
        description=s.description or None,
        kind=s.kind,
        scorer_import_path=s.scorer_import_path,
        system_prompt=s.system_prompt or "",
        score_field=s.score_field,
        response_schema=json.dumps(s.response_schema, indent=2) if s.response_schema else None,
        model=s.model,
    )


def _payload_to_spec(name: str, payload: dict) -> JudgeSpec:
    """Hydrate a PUT payload into a JudgeSpec, parsing schema string → dict.

    Validates kind-specific fields and import-path resolution. Raises
    ``HTTPException(400)`` on shape errors so the editor UI surfaces a clean
    message rather than a 500 at run time.
    """
    kind = payload.get("kind") or "prompt"
    if kind not in ("prompt", "scorer"):
        raise HTTPException(400, f"unknown kind: {kind!r}")

    schema_str = payload.get("response_schema")
    if schema_str:
        try:
            schema = json.loads(schema_str)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"response_schema is not valid JSON: {e}")
        if not isinstance(schema, dict):
            raise HTTPException(400, "response_schema must encode a JSON object")
    else:
        schema = None

    import_path = (payload.get("scorer_import_path") or "").strip() or None
    system_prompt = payload.get("system_prompt") or ""

    if kind == "scorer":
        if not import_path:
            raise HTTPException(400, "scorer kind requires scorer_import_path")
        try:
            resolve_scorer_factory(import_path)  # eager validation
        except ValueError as e:
            raise HTTPException(400, f"scorer_import_path failed to resolve: {e}")
    else:  # prompt
        if not system_prompt:
            raise HTTPException(400, "prompt kind requires a non-empty system_prompt")

    return JudgeSpec(
        name=name,
        description=payload.get("description") or "",
        kind=kind,
        scorer_import_path=import_path if kind == "scorer" else None,
        system_prompt=system_prompt if kind == "prompt" else None,
        score_field=payload.get("score_field") or "score",
        response_schema=schema if kind == "prompt" else None,
        model=payload.get("model") or None,
    )


@router.get("/presets", response_model=list[JudgePreset])
def list_presets() -> list[JudgePreset]:
    return [_spec_to_preset(s) for s in list_all()]


@router.get("/presets/{name}", response_model=JudgePreset)
def get_preset(name: str) -> JudgePreset:
    spec = registry_get(name)
    if spec is None:
        raise HTTPException(404, f"preset '{name}' not found")
    return _spec_to_preset(spec)


@router.put("/presets/{name}", response_model=JudgePreset)
def upsert_preset(name: str, payload: dict) -> JudgePreset:
    """Create or replace a preset. Validates kind-specific fields."""
    spec = _payload_to_spec(name, payload)
    registry_upsert(spec)
    return _spec_to_preset(spec)


@router.delete("/presets/{name}")
def delete_preset(name: str) -> dict:
    registry_delete(name)
    return {"ok": True}


@router.get("/settings", response_model=JudgeSettings)
def read_settings() -> JudgeSettings:
    """Currently only ``default_judge_model``. Falls through to the curated head if unset."""
    val = get_default_model() or CURATED_MODELS[0]
    return JudgeSettings(default_judge_model=val)


@router.put("/settings", response_model=JudgeSettings)
def write_settings(payload: JudgeSettings) -> JudgeSettings:
    set_default_model(payload.default_judge_model)
    return payload


@router.get("/models")
def list_models() -> list[str]:
    """Curated model list for the UI picker."""
    return list(CURATED_MODELS)


@router.get("/results")
def list_results(dataset_path: str | None = None, preset_name: str | None = None) -> list[dict]:
    """Saved scores, optionally filtered. ``output_json`` is parsed back to a dict if present."""
    sql = (
        "SELECT dataset_path, row_idx, preset_name, score, reasoning, error, "
        "output_json, created_at FROM state.judge_results"
    )
    where: list[str] = []
    params: list = []
    if dataset_path:
        where.append("dataset_path = ?")
        params.append(dataset_path)
    if preset_name:
        where.append("preset_name = ?")
        params.append(preset_name)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC"
    with cursor() as cur:
        rows = cur.execute(sql, params).fetchall()
    out: list[dict] = []
    for r in rows:
        try:
            output_json = json.loads(r[6]) if r[6] else None
        except json.JSONDecodeError:
            output_json = None
        out.append({
            "dataset_path": r[0],
            "row_idx": r[1],
            "preset_name": r[2],
            "score": r[3],
            "reasoning": r[4],
            "error": r[5],
            "output_json": output_json,
            "created_at": str(r[7]),
        })
    return out


@router.post("/run")
async def run_batch(req: JudgeRunRequest) -> EventSourceResponse:
    """Stream judge results one row at a time. Errors are surfaced per-row."""
    spec = registry_get(req.preset_name)
    if spec is None:
        raise HTTPException(404, f"preset '{req.preset_name}' not found")

    async def gen():
        for i, idx in enumerate(req.indices):
            try:
                row = read_one_row(path=req.dataset_path, idx=idx)
            except Exception as e:
                yield {"event": "result", "data": json.dumps({"idx": idx, "error": str(e)})}
                continue
            result = await run_judge(spec=spec, row=row, model_override=req.model)
            rh = row_hash(row)
            output_json_str = (
                json.dumps(result["output_json"]) if result.get("output_json") else None
            )
            with cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO state.judge_results(dataset_path, row_idx, row_hash, preset_name,
                        score, reasoning, raw_response, error, output_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp)
                    ON CONFLICT (dataset_path, row_idx, preset_name) DO UPDATE
                      SET row_hash = excluded.row_hash,
                          score = excluded.score,
                          reasoning = excluded.reasoning,
                          raw_response = excluded.raw_response,
                          error = excluded.error,
                          output_json = excluded.output_json,
                          created_at = now()
                    """,
                    [
                        req.dataset_path,
                        idx,
                        rh,
                        req.preset_name,
                        result.get("score"),
                        result.get("reasoning"),
                        result.get("raw_response"),
                        result.get("error"),
                        output_json_str,
                    ],
                )
            yield {
                "event": "result",
                "data": json.dumps({
                    "idx": idx,
                    "progress": (i + 1) / len(req.indices),
                    **result,
                }),
            }
            await asyncio.sleep(0)
        yield {"event": "done", "data": json.dumps({"total": len(req.indices)})}

    return EventSourceResponse(gen())
