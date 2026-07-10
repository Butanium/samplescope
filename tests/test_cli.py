"""`sscope view` filter-list commands, exercised via real subprocesses.

Follows test_discovery.py's `_viewer` pattern: run the CLI as a subprocess
against the live `server` fixture, auto-discovered from cwd inside the scan
root.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def _viewer(args: list[str], cwd: Path, state_home: Path) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env.pop("SAMPLESCOPE_BASE_URL", None)
    env["XDG_STATE_HOME"] = str(state_home)
    return subprocess.run(
        [sys.executable, "-m", "samplescope.cli", "view", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_cli_filter_add_list_rm_clear(server: str, state_home: Path, dataset_dir: Path):
    """filter (×2) → filters shows 2 → rm-filter 0 → 1 → clear-filter → 0."""
    try:
        _viewer(["clear-filter"], dataset_dir, state_home)

        r = _viewer(["filter", "foo"], dataset_dir, state_home)
        assert r.returncode == 0, r.stderr
        r = _viewer(["filter", "bar", "--column", "label"], dataset_dir, state_home)
        assert r.returncode == 0, r.stderr

        r = _viewer(["filters"], dataset_dir, state_home)
        assert r.returncode == 0, r.stderr
        assert "2 filter(s)" in r.stdout
        assert "foo" in r.stdout and "bar" in r.stdout
        # Whole-row filter renders its column as a placeholder.
        assert "(whole row)" in r.stdout

        r = _viewer(["rm-filter", "0"], dataset_dir, state_home)
        assert r.returncode == 0, r.stderr
        r = _viewer(["filters"], dataset_dir, state_home)
        assert "1 filter(s)" in r.stdout
        assert "bar" in r.stdout

        # Out-of-range removal is a clean error, not a crash.
        r = _viewer(["rm-filter", "5"], dataset_dir, state_home)
        assert r.returncode != 0
        assert "no filter at index 5" in r.stderr

        r = _viewer(["clear-filter"], dataset_dir, state_home)
        assert r.returncode == 0, r.stderr
        r = _viewer(["filters"], dataset_dir, state_home)
        assert "0 filter(s)" in r.stdout
    finally:
        _viewer(["clear-filter"], dataset_dir, state_home)
