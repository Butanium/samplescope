"""Instance registry + `viewer` CLI discovery, exercised via real subprocesses."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

REPO = Path(__file__).resolve().parents[1]


def _viewer(args: list[str], cwd: Path, state_home: Path, **env_extra) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env.pop("VIEWER_BASE_URL", None)
    env["XDG_STATE_HOME"] = str(state_home)
    env.update(env_extra)
    return subprocess.run(
        [sys.executable, "-m", "samplescope.cli", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_registry_has_server(server: str, state_home: Path, dataset_dir: Path):
    registry = json.loads((state_home / "samplescope" / "instances.json").read_text())
    ours = [i for i in registry if str(dataset_dir) in i["scan_roots"]]
    assert len(ours) == 1
    assert f"http://{ours[0]['host']}:{ours[0]['port']}" == server


def test_cli_discovers_from_inside_scan_root(server: str, state_home: Path, dataset_dir: Path):
    r = _viewer(["ls"], cwd=dataset_dir, state_home=state_home)
    assert r.returncode == 0, r.stderr
    assert "chat.jsonl" in r.stdout
    assert "metrics.csv" in r.stdout


def test_cli_single_instance_fallback(server: str, state_home: Path, tmp_path: Path):
    """cwd outside any scan root, but only one instance running → use it."""
    r = _viewer(["state"], cwd=tmp_path, state_home=state_home)
    assert r.returncode == 0, r.stderr


def test_cli_base_url_override(server: str, state_home: Path, tmp_path: Path):
    r = _viewer(["--base-url", server, "ls"], cwd=tmp_path, state_home=state_home)
    assert r.returncode == 0, r.stderr
    assert "chat.jsonl" in r.stdout


def test_cli_env_override(server: str, state_home: Path, tmp_path: Path):
    r = _viewer(["ls"], cwd=tmp_path, state_home=state_home, VIEWER_BASE_URL=server)
    assert r.returncode == 0, r.stderr
    assert "chat.jsonl" in r.stdout


def test_two_instances_route_by_cwd(server: str, state_home: Path, dataset_dir: Path, tmp_path: Path):
    """The motivating scenario: two servers on two dirs, CLI picks by cwd."""
    second_dir = tmp_path / "second"
    second_dir.mkdir()
    (second_dir / "other.jsonl").write_text('{"a": 1}\n{"a": 2}\n')

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = os.environ.copy()
    env["XDG_STATE_HOME"] = str(state_home)
    proc = subprocess.Popen(
        [sys.executable, "-m", "samplescope.serve", str(second_dir), "--port", str(port)],
        env=env,
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            assert proc.poll() is None, "second server died at startup"
            try:
                if httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        else:
            pytest.fail("second server never came up")

        # cwd inside each scan root resolves to that instance.
        r1 = _viewer(["ls"], cwd=dataset_dir, state_home=state_home)
        assert "chat.jsonl" in r1.stdout and "other.jsonl" not in r1.stdout
        r2 = _viewer(["ls"], cwd=second_dir, state_home=state_home)
        assert "other.jsonl" in r2.stdout and "chat.jsonl" not in r2.stdout, r2.stderr

        # cwd outside both, two instances running → explicit ambiguity error.
        r3 = _viewer(["ls"], cwd=tmp_path, state_home=state_home)
        assert r3.returncode != 0
        assert "running instances" in r3.stderr
    finally:
        proc.terminate()
        proc.wait(timeout=10)

    # After termination the dead instance is pruned lazily and the survivor
    # becomes the single-instance fallback again.
    r4 = _viewer(["ls"], cwd=tmp_path, state_home=state_home)
    assert r4.returncode == 0, r4.stderr
    assert "chat.jsonl" in r4.stdout


def test_same_roots_relaunch_is_idempotent(server: str, state_home: Path, dataset_dir: Path):
    """A second launch on the same scan roots points at the running instance
    instead of crashing on the DuckDB state-DB lock."""
    env = os.environ.copy()
    env["XDG_STATE_HOME"] = str(state_home)
    r = subprocess.run(
        [sys.executable, "-m", "samplescope.serve", str(dataset_dir)],
        env=env,
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode == 0, r.stderr
    assert "already serving" in r.stdout
    assert server in r.stdout
