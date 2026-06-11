"""App-wide paths and config. Loaded once at startup.

The `samplescope` entry point (`serve.py`) translates CLI args into the
`SAMPLESCOPE_*` env vars before importing this module, so env vars remain
the single configuration surface (and survive uvicorn --reload re-imports).

State (marks, judge results, prefs) and caches (materialized .eval views)
live under `~/.local/state/samplescope/<key>/`, keyed by the resolved
scan-root set — annotations survive across runs and the viewed repos stay
clean.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

from ..paths import STATE_HOME

# Last-resort grader model when the request, preset, and ``app_settings`` row
# are all silent. Inspect provider/model id (not the raw OpenAI model id).
FALLBACK_JUDGE_MODEL = "openai/gpt-4.1-2025-04-14"

# Pick up a .env from the directory the server was launched in, if present.
load_dotenv(override=False)


@dataclass(frozen=True)
class Settings:
    """Resolved runtime settings.

    `root` is the common ancestor of all scan roots; every dataset path the
    API exchanges with clients is relative to it (and `safe_path` refuses
    escapes above it). The judge model is read live from
    ``state.app_settings.default_judge_model`` (see ``api/judges/registry.py``).
    """

    root: Path
    scan_roots: tuple[Path, ...]
    state_dir: Path
    state_db: Path
    cache_dir: Path
    host: str
    port: int
    chat_model: str | None
    openai_api_key: str | None
    anthropic_api_key: str | None

    @property
    def base_url(self) -> str:
        """The URL this server instance is reachable at (self-target)."""
        return f"http://{self.host}:{self.port}"


def scan_roots_key(roots: tuple[Path, ...]) -> str:
    """Stable short key for a scan-root set; names the per-set state dir."""
    blob = "\n".join(sorted(str(r) for r in roots))
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def load_settings() -> Settings:
    """Build a Settings from env + defaults. Idempotent."""
    scan_env = os.environ.get("SAMPLESCOPE_SCAN_ROOTS")
    if scan_env:
        roots = tuple(Path(p).expanduser().resolve() for p in scan_env.split(":") if p)
    else:
        roots = (Path.cwd().resolve(),)
    root = Path(os.path.commonpath([str(r) for r in roots]))
    state_dir = STATE_HOME / scan_roots_key(roots)
    cache_dir = state_dir / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        root=root,
        scan_roots=roots,
        state_dir=state_dir,
        state_db=state_dir / "state.duckdb",
        cache_dir=cache_dir,
        host=os.environ.get("SAMPLESCOPE_HOST", "127.0.0.1"),
        port=int(os.environ.get("SAMPLESCOPE_PORT", "8765")),
        chat_model=os.environ.get("SAMPLESCOPE_CHAT_MODEL"),
        openai_api_key=os.environ.get("OPENAI_API_KEY"),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
    )


SETTINGS = load_settings()
