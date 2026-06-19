"""Highlight rules: per-row visual annotations applied at render time.

Mirrors the shape of ``judges.py`` — list / upsert-by-id / delete / reorder.
The ``id`` in the URL is authoritative on PUT (creates if missing). Rules are
returned ordered by ``sort_order`` ascending so the frontend can resolve
overlapping highlights deterministically (earlier rule wins).
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException

from ..duck import cursor
from ..models import HighlightRule

router = APIRouter(prefix="/api/highlights", tags=["highlights"])


# New columns (patterns, combinator) appended at the end so the leading indices
# match the legacy layout.
_COLUMNS = (
    "id, name, enabled, pattern, is_regex, case_sensitive, color, "
    "scope_role, scope_column, condition, sort_order, patterns, combinator"
)


def _row_to_rule(r: tuple) -> HighlightRule:
    """Hydrate a DB row tuple into a HighlightRule."""
    patterns: list[str] = []
    if r[11]:
        try:
            parsed = json.loads(r[11])
            if isinstance(parsed, list):
                patterns = [str(p) for p in parsed if str(p)]
        except (json.JSONDecodeError, TypeError):
            patterns = []
    if not patterns and r[3]:
        patterns = [r[3]]  # legacy single-pattern row
    return HighlightRule(
        id=r[0],
        name=r[1],
        enabled=bool(r[2]),
        pattern=r[3] or "",
        patterns=patterns,
        combinator=(r[12] or "or"),
        is_regex=bool(r[4]),
        case_sensitive=bool(r[5]),
        color=r[6],
        scope_role=r[7],
        scope_column=r[8],
        condition=r[9],
        sort_order=int(r[10] or 0),
    )


@router.get("", response_model=list[HighlightRule])
def list_rules() -> list[HighlightRule]:
    """All rules, sort_order-ascending then created_at as a stable tiebreak."""
    sql = f"SELECT {_COLUMNS} FROM state.highlight_rules ORDER BY sort_order, created_at"
    with cursor() as cur:
        rows = cur.execute(sql).fetchall()
    return [_row_to_rule(r) for r in rows]


@router.put("/{rule_id}", response_model=HighlightRule)
def upsert_rule(rule_id: str, payload: dict) -> HighlightRule:
    """Create or replace a rule. ``rule_id`` in the URL wins over body.id."""
    name = (payload.get("name") or "").strip()
    color = payload.get("color") or "#fde047"
    # `patterns` (list) is authoritative; fall back to a single `pattern` for
    # older clients. Empty strings are dropped.
    raw_patterns = payload.get("patterns")
    if isinstance(raw_patterns, list):
        patterns = [str(p) for p in raw_patterns if str(p).strip() != ""]
    else:
        single = payload.get("pattern") or ""
        patterns = [single] if single else []
    combinator = "and" if payload.get("combinator") == "and" else "or"
    if not name:
        raise HTTPException(400, "name required")
    if not patterns:
        raise HTTPException(400, "at least one pattern required")
    pattern = patterns[0]  # legacy column mirror

    with cursor() as cur:
        existing_order = cur.execute(
            "SELECT sort_order FROM state.highlight_rules WHERE id = ?",
            [rule_id],
        ).fetchone()
        if existing_order is None:
            max_order = cur.execute(
                "SELECT COALESCE(MAX(sort_order), -1) FROM state.highlight_rules"
            ).fetchone()
            sort_order = int(max_order[0]) + 1 if max_order else 0
        else:
            sort_order = int(payload.get("sort_order", existing_order[0]))

        cur.execute(
            """
            INSERT INTO state.highlight_rules(
                id, name, enabled, pattern, patterns, combinator, is_regex,
                case_sensitive, color, scope_role, scope_column, condition,
                sort_order, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp)
            ON CONFLICT (id) DO UPDATE SET
                name = excluded.name,
                enabled = excluded.enabled,
                pattern = excluded.pattern,
                patterns = excluded.patterns,
                combinator = excluded.combinator,
                is_regex = excluded.is_regex,
                case_sensitive = excluded.case_sensitive,
                color = excluded.color,
                scope_role = excluded.scope_role,
                scope_column = excluded.scope_column,
                condition = excluded.condition,
                sort_order = excluded.sort_order
            """,
            [
                rule_id,
                name,
                bool(payload.get("enabled", True)),
                pattern,
                json.dumps(patterns),
                combinator,
                bool(payload.get("is_regex", False)),
                bool(payload.get("case_sensitive", False)),
                color,
                payload.get("scope_role") or None,
                payload.get("scope_column") or None,
                payload.get("condition") or None,
                sort_order,
            ],
        )
        row = cur.execute(
            f"SELECT {_COLUMNS} FROM state.highlight_rules WHERE id = ?",
            [rule_id],
        ).fetchone()
    if row is None:
        raise HTTPException(500, "row missing post-upsert")
    return _row_to_rule(row)


@router.delete("/{rule_id}")
def delete_rule(rule_id: str) -> dict:
    """Drop one rule. Idempotent — missing ids return ok."""
    with cursor() as cur:
        cur.execute("DELETE FROM state.highlight_rules WHERE id = ?", [rule_id])
    return {"ok": True}


@router.post("/reorder")
def reorder_rules(payload: dict) -> dict:
    """Set sort_order to the index of each id in ``ids``. Unlisted ids are unchanged."""
    ids = payload.get("ids") or []
    if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
        raise HTTPException(400, "ids must be list[str]")
    with cursor() as cur:
        for i, rid in enumerate(ids):
            cur.execute(
                "UPDATE state.highlight_rules SET sort_order = ? WHERE id = ?",
                [i, rid],
            )
    return {"ok": True, "n": len(ids)}
