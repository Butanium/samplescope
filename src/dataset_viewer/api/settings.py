"""App-wide paths and config. Loaded once at startup."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
APP_ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = APP_ROOT / ".cache"
STATE_DB_PATH = CACHE_DIR / "state.duckdb"

# Last-resort grader model when the request, preset, and ``app_settings`` row
# are all silent. Inspect provider/model id (not the raw OpenAI model id).
FALLBACK_JUDGE_MODEL = "openai/gpt-4.1-2025-04-14"

load_dotenv(REPO_ROOT / ".env", override=False)


@dataclass(frozen=True)
class Settings:
    """Resolved runtime settings.

    The judge model is no longer pinned here — it's read live from
    ``state.app_settings.default_judge_model`` (see ``api/judges/registry.py``).
    """

    repo_root: Path
    scan_roots: tuple[Path, ...]
    state_db: Path
    chat_model: str | None
    openai_api_key: str | None
    anthropic_api_key: str | None


def load_settings() -> Settings:
    """Build a Settings from env + defaults. Idempotent."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    scan_env = os.environ.get("DATASET_VIEWER_SCAN_ROOTS")
    if scan_env:
        roots = tuple(Path(p).resolve() for p in scan_env.split(":") if p)
    else:
        roots = (REPO_ROOT / "experiments",)
    return Settings(
        repo_root=REPO_ROOT,
        scan_roots=roots,
        state_db=STATE_DB_PATH,
        chat_model=os.environ.get("DATASET_VIEWER_CHAT_MODEL"),
        openai_api_key=os.environ.get("OPENAI_API_KEY"),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
    )


SETTINGS = load_settings()
