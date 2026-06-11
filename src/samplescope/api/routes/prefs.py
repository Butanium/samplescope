"""Cross-browser user preferences.

Tiny key/value store backed by the persistent DuckDB state DB. Values are
opaque JSON strings as far as the backend is concerned; the frontend wraps
them with `usePref` and decides the shape per key.

Distinct from `app_settings`:
  - `app_settings` = server-owned config (default judge model, …) edited via
    its own typed endpoints.
  - `user_prefs`   = client UI state the user wants persisted across browsers
    (tree fold map, theme override, …). Free-form keys.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..duck import cursor

router = APIRouter(prefix="/api/prefs", tags=["prefs"])


@router.get("")
def list_prefs() -> dict[str, str]:
    """Return every persisted pref as `{key: json_string_value}`.

    The frontend `JSON.parse`s each value itself — keeping the wire format
    opaque means we don't need a schema migration when a new pref shape
    appears.
    """
    with cursor() as cur:
        rows = cur.execute("SELECT key, value FROM state.user_prefs").fetchall()
    return {r[0]: r[1] for r in rows}


@router.put("/{key:path}")
def set_pref(key: str, payload: dict) -> dict:
    """Upsert a pref. `payload.value` is a string (the frontend pre-encodes JSON)."""
    if "value" not in payload:
        raise HTTPException(400, "missing 'value' in body")
    value = payload["value"]
    if not isinstance(value, str):
        raise HTTPException(400, "'value' must be a string (pre-encoded JSON)")
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO state.user_prefs(key, value, updated_at)
            VALUES (?, ?, now())
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = now()
            """,
            [key, value],
        )
    return {"ok": True, "key": key}


@router.delete("/{key:path}")
def delete_pref(key: str) -> dict:
    """Forget a pref entirely (resets to its frontend default on next load)."""
    with cursor() as cur:
        cur.execute("DELETE FROM state.user_prefs WHERE key = ?", [key])
    return {"ok": True, "key": key}
