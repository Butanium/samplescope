"""Shared fixtures: a live samplescope server over a tmp dataset dir.

Tests run against a real uvicorn server (not TestClient) so the same fixture
serves API tests, `viewer` CLI subprocess tests, and playwright tests —
exercising the instance registry and static serving exactly like production.

State isolation: XDG_STATE_HOME is pointed at a per-session tmp dir so tests
never touch ~/.local/state/samplescope.
"""
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


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def state_home(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("xdg-state")


@pytest.fixture(scope="session")
def dataset_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A directory with one chat JSONL, one flat-table JSONL, and one CSV."""
    d = tmp_path_factory.mktemp("datasets")
    chat = d / "chat.jsonl"
    chat.write_text(
        "\n".join(
            json.dumps(
                {
                    "messages": [
                        {"role": "user", "content": f"question {i}"},
                        {"role": "assistant", "content": f"answer {i}"},
                    ],
                    "score": i,
                    "label": "even" if i % 2 == 0 else "odd",
                }
            )
            for i in range(20)
        )
        + "\n"
    )
    (d / "metrics.csv").write_text(
        "step,loss,acc\n" + "\n".join(f"{i},{1.0 / (i + 1):.3f},{i * 0.05:.2f}" for i in range(10)) + "\n"
    )
    sub = d / "nested"
    sub.mkdir()
    (sub / "flat.jsonl").write_text(
        "\n".join(json.dumps({"x": i, "y": i * i}) for i in range(5)) + "\n"
    )
    return d


@pytest.fixture(scope="session")
def server(dataset_dir: Path, state_home: Path):
    """Launch `samplescope <dataset_dir>` as a subprocess; yield its base URL."""
    port = _free_port()
    env = os.environ.copy()
    env["XDG_STATE_HOME"] = str(state_home)
    proc = subprocess.Popen(
        [sys.executable, "-m", "samplescope.serve", str(dataset_dir), "--port", str(port)],
        env=env,
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 30
    last_err: Exception | None = None
    while time.time() < deadline:
        if proc.poll() is not None:
            out = proc.stdout.read() if proc.stdout else ""
            raise RuntimeError(f"server died at startup (exit {proc.returncode}):\n{out}")
        try:
            r = httpx.get(f"{base}/api/health", timeout=2)
            if r.status_code == 200:
                break
        except httpx.HTTPError as e:
            last_err = e
        time.sleep(0.2)
    else:
        proc.terminate()
        raise RuntimeError(f"server never came up on {base}: {last_err}")
    yield base
    proc.terminate()
    proc.wait(timeout=10)
