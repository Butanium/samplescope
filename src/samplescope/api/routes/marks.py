"""Marks: per-row tags + free-text notes, persisted in state.duckdb."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException

from ..duck import cursor, row_hash
from ..models import MarkRecord
from ..routes.datasets import read_one_row

router = APIRouter(prefix="/api/marks", tags=["marks"])


@router.get("", response_model=list[MarkRecord])
def list_marks(dataset_path: str | None = None) -> list[MarkRecord]:
    """All marks, optionally narrowed to one dataset."""
    sql = "SELECT dataset_path, row_idx, row_hash, tags, note FROM state.marks"
    params: list = []
    if dataset_path:
        sql += " WHERE dataset_path = ?"
        params.append(dataset_path)
    sql += " ORDER BY dataset_path, row_idx"
    with cursor() as cur:
        rows = cur.execute(sql, params).fetchall()
    return [
        MarkRecord(
            dataset_path=r[0],
            row_idx=r[1],
            row_hash=r[2],
            tags=json.loads(r[3]) if isinstance(r[3], str) else (r[3] or []),
            note=r[4] or "",
        )
        for r in rows
    ]


@router.get("/{path:path}/{idx}")
def get_mark(path: str, idx: int) -> MarkRecord | None:
    """Return the single mark for (path, idx) or null if unmarked."""
    with cursor() as cur:
        r = cur.execute(
            "SELECT dataset_path, row_idx, row_hash, tags, note FROM state.marks WHERE dataset_path = ? AND row_idx = ?",
            [path, idx],
        ).fetchone()
    if r is None:
        return None
    return MarkRecord(
        dataset_path=r[0],
        row_idx=r[1],
        row_hash=r[2],
        tags=json.loads(r[3]) if isinstance(r[3], str) else (r[3] or []),
        note=r[4] or "",
    )


@router.put("/{path:path}/{idx}", response_model=MarkRecord)
def upsert_mark(path: str, idx: int, payload: dict) -> MarkRecord:
    """Create or replace a mark. The row hash is recomputed each time."""
    tags = payload.get("tags", []) or []
    note = payload.get("note", "") or ""
    if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        raise HTTPException(400, "tags must be list[str]")
    row = read_one_row(path=path, idx=idx)
    rh = row_hash(row)
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO state.marks(dataset_path, row_idx, row_hash, tags, note, updated_at)
            VALUES (?, ?, ?, ?, ?, current_timestamp)
            ON CONFLICT (dataset_path, row_idx) DO UPDATE
              SET row_hash = excluded.row_hash,
                  tags = excluded.tags,
                  note = excluded.note,
                  updated_at = now()
            """,
            [path, idx, rh, json.dumps(tags), note],
        )
    return MarkRecord(dataset_path=path, row_idx=idx, row_hash=rh, tags=tags, note=note)


@router.delete("/{path:path}/{idx}")
def delete_mark(path: str, idx: int) -> dict:
    with cursor() as cur:
        cur.execute(
            "DELETE FROM state.marks WHERE dataset_path = ? AND row_idx = ?",
            [path, idx],
        )
    return {"ok": True}
