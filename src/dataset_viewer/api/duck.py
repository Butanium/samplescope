"""DuckDB connection layer.

Two responsibilities:
1. A single shared in-memory DuckDB connection used to query JSONL files via
   `read_json_auto(...)`. Schema inference is on; results are paginated.
2. A persistent state DB at `~/.local/state/dataset-viewer/<key>/` holding
   marks, judge presets, judge results, and chat session metadata.
"""
from __future__ import annotations

import hashlib
import json
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import duckdb

from .settings import SETTINGS

_CONN_LOCK = threading.Lock()
_CONN: duckdb.DuckDBPyConnection | None = None


def get_conn() -> duckdb.DuckDBPyConnection:
    """Return the shared DuckDB connection. ATTACHes the persistent state DB."""
    global _CONN
    with _CONN_LOCK:
        if _CONN is not None:
            return _CONN
        conn = duckdb.connect(database=":memory:")
        SETTINGS.state_db.parent.mkdir(parents=True, exist_ok=True)
        conn.execute(f"ATTACH '{SETTINGS.state_db}' AS state")
        _init_state_schema(conn)
        _CONN = conn
        return conn


def _init_state_schema(conn: duckdb.DuckDBPyConnection) -> None:
    """Create state tables if missing. Idempotent."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.marks (
            dataset_path VARCHAR NOT NULL,
            row_idx BIGINT NOT NULL,
            row_hash VARCHAR NOT NULL,
            tags JSON NOT NULL DEFAULT '[]',
            note VARCHAR NOT NULL DEFAULT '',
            updated_at TIMESTAMP DEFAULT current_timestamp,
            PRIMARY KEY (dataset_path, row_idx)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.judge_presets (
            name VARCHAR PRIMARY KEY,
            system_prompt VARCHAR NOT NULL,
            score_field VARCHAR NOT NULL DEFAULT 'score',
            model VARCHAR,
            description VARCHAR,
            response_schema VARCHAR,
            kind VARCHAR NOT NULL DEFAULT 'prompt',
            scorer_import_path VARCHAR,
            created_at TIMESTAMP DEFAULT current_timestamp
        )
    """)
    # Idempotent migrations for older state.duckdb files that pre-date these columns.
    # DuckDB ALTER does not accept NOT NULL DEFAULT, so we add the column then
    # backfill old rows below.
    for ddl in (
        "ALTER TABLE state.judge_presets ADD COLUMN description VARCHAR",
        "ALTER TABLE state.judge_presets ADD COLUMN response_schema VARCHAR",
        "ALTER TABLE state.judge_presets ADD COLUMN kind VARCHAR",
        "ALTER TABLE state.judge_presets ADD COLUMN scorer_import_path VARCHAR",
    ):
        try:
            conn.execute(ddl)
        except duckdb.CatalogException:
            pass  # already added on a previous boot
    # Backfill: rows from the pre-kind era are all prompt-template judges.
    conn.execute("UPDATE state.judge_presets SET kind = 'prompt' WHERE kind IS NULL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.judge_results (
            dataset_path VARCHAR NOT NULL,
            row_idx BIGINT NOT NULL,
            row_hash VARCHAR NOT NULL,
            preset_name VARCHAR NOT NULL,
            score DOUBLE,
            reasoning VARCHAR,
            raw_response VARCHAR,
            error VARCHAR,
            output_json VARCHAR,
            created_at TIMESTAMP DEFAULT current_timestamp,
            PRIMARY KEY (dataset_path, row_idx, preset_name)
        )
    """)
    try:
        conn.execute("ALTER TABLE state.judge_results ADD COLUMN output_json VARCHAR")
    except duckdb.CatalogException:
        pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.app_settings (
            key VARCHAR PRIMARY KEY,
            value VARCHAR NOT NULL
        )
    """)
    conn.execute("""
        INSERT INTO state.app_settings(key, value)
        SELECT 'default_judge_model', 'openai/gpt-4.1-2025-04-14'
        WHERE NOT EXISTS (SELECT 1 FROM state.app_settings WHERE key = 'default_judge_model')
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.highlight_rules (
            id VARCHAR PRIMARY KEY,
            name VARCHAR NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT true,
            pattern VARCHAR NOT NULL,
            is_regex BOOLEAN NOT NULL DEFAULT false,
            case_sensitive BOOLEAN NOT NULL DEFAULT false,
            color VARCHAR NOT NULL,
            scope_role VARCHAR,
            scope_column VARCHAR,
            condition VARCHAR,
            created_at TIMESTAMP DEFAULT current_timestamp,
            sort_order INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.chat_sessions (
            session_id VARCHAR PRIMARY KEY,
            created_at TIMESTAMP DEFAULT current_timestamp,
            label VARCHAR
        )
    """)
    # `sdk_session_id` is the UUID the claude-agent-sdk subprocess assigned;
    # captured from the SystemMessage init event. We use it to resume the
    # underlying Claude Code session when the user reopens an old chat tab.
    try:
        conn.execute("ALTER TABLE state.chat_sessions ADD COLUMN sdk_session_id VARCHAR")
    except duckdb.CatalogException:
        pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.chat_messages (
            session_id VARCHAR NOT NULL,
            seq BIGINT NOT NULL,
            role VARCHAR NOT NULL,
            payload JSON NOT NULL,
            created_at TIMESTAMP DEFAULT current_timestamp,
            PRIMARY KEY (session_id, seq)
        )
    """)
    # Plot panel tabs — global gallery of images / PDFs / plotly figures the
    # user (or Claude, via the CLI) has pinned. `source_path` is set for
    # filesystem-backed tabs (repo-rooted, validated via safe_path); `payload`
    # holds the plotly figure JSON inline. `position` orders the tabstrip.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.plot_tabs (
            id VARCHAR PRIMARY KEY,
            kind VARCHAR NOT NULL,
            title VARCHAR,
            source_path VARCHAR,
            payload VARCHAR,
            position INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT current_timestamp
        )
    """)
    # Frontend user preferences (tree fold state, default-expand toggles, etc.).
    # Per-clone, per-branch — sharing the `.cache/state.duckdb` across browsers
    # is the point. Distinct from `app_settings` (which is server-owned config
    # like default_judge_model). Values are stored as JSON-encoded strings so a
    # pref can hold any shape the UI wants.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS state.user_prefs (
            key VARCHAR PRIMARY KEY,
            value VARCHAR NOT NULL,
            updated_at TIMESTAMP DEFAULT current_timestamp
        )
    """)


@contextmanager
def cursor() -> Iterator[duckdb.DuckDBPyConnection]:
    """Yield a fresh cursor that shares the underlying connection. Threadsafe-ish."""
    conn = get_conn()
    cur = conn.cursor()
    try:
        yield cur
    finally:
        cur.close()


def row_hash(row: dict[str, Any]) -> str:
    """Stable content hash for a row. Used to keep marks attached across renames."""
    blob = json.dumps(row, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def safe_path(path: str) -> Path:
    """Resolve a user-supplied relative path against the serving root, refusing escapes."""
    p = (SETTINGS.root / path).resolve()
    if SETTINGS.root not in p.parents and p != SETTINGS.root:
        raise ValueError(f"path escapes serving root: {path}")
    if not p.exists():
        raise FileNotFoundError(p)
    return p
