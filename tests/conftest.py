"""Shared fixtures: a live samplescope server over a tmp dataset dir.

Tests run against a real uvicorn server (not TestClient) so the same fixture
serves API tests, `viewer` CLI subprocess tests, and playwright tests —
exercising the instance registry and static serving exactly like production.

State isolation: XDG_STATE_HOME is pointed at a per-session tmp dir so tests
never touch ~/.local/state/samplescope.
"""
from __future__ import annotations

import csv
import io
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


@pytest.fixture(scope="session", autouse=True)
def _isolate_in_process_state(state_home: Path):
    """Point in-process samplescope imports (e.g. detect_view unit tests) at the
    same isolated XDG state dir the server subprocess uses, so they never touch
    ~/.local/state/samplescope. Subprocess fixtures set XDG_STATE_HOME
    explicitly anyway; this only matters for tests that import the package."""
    prev = os.environ.get("XDG_STATE_HOME")
    os.environ["XDG_STATE_HOME"] = str(state_home)
    yield
    if prev is None:
        os.environ.pop("XDG_STATE_HOME", None)
    else:
        os.environ["XDG_STATE_HOME"] = prev


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
    # Scalar-only, no step column: the one CSV that still detects as `table`
    # (metrics.csv → metrics, wide_text.csv → json), for table-default UI tests.
    (d / "plain.csv").write_text(
        "name,age,city\n" + "\n".join(f"person{i},{20 + i},city{i % 4}" for i in range(8)) + "\n"
    )
    sub = d / "nested"
    sub.mkdir()
    (sub / "flat.jsonl").write_text(
        "\n".join(json.dumps({"x": i, "y": i * i}) for i in range(5)) + "\n"
    )
    # Multi-field records with one long free-text field → detected as the `json`
    # per-sample card view (exercises the top-level field layout: hide / reorder /
    # header pin). `records2.jsonl` shares the SAME field set with different
    # values, so it must inherit `records.jsonl`'s schema-keyed layout.
    def _records(label_prefix: str) -> str:
        return (
            "\n".join(
                json.dumps(
                    {
                        "rid": i,
                        "label": f"{label_prefix}-{i}",
                        "score": round(i * 0.1, 2),
                        # 2-valued field so group-by has real buckets to cycle.
                        "bucket": "even" if i % 2 == 0 else "odd",
                        "response": "A deliberately long free-text response field so the "
                        "schema sniffer routes this file to the json card view. " * 3,
                    }
                )
                for i in range(6)
            )
            + "\n"
        )

    (d / "records.jsonl").write_text(_records("item"))
    (d / "records2.jsonl").write_text(_records("other"))
    # A >100-row json-card file so the infinite-scroll feed must paginate (the
    # frontend pulls 100 rows/page → this forces ≥3 pages).
    (d / "big.jsonl").write_text(
        "\n".join(
            json.dumps(
                {
                    "rid": i,
                    "label": f"big-{i}",
                    # >200 chars so _has_long_text routes this to the json card
                    # view (the infinite-scroll feed under test), not the table.
                    "response": "Long free-text so the json card view is selected. " * 6,
                }
            )
            for i in range(250)
        )
        + "\n"
    )
    # A wide CSV mixing an index column, long free-text, a JSON-object cell, a
    # float score, and a 3-way categorical. Long text routes detection to the
    # `json` card view (tabular still True); the JSON cell gives the frontend's
    # JSON-cell expansion a target; `id`/`score` are the numeric columns.
    cats = ["alpha", "beta", "gamma"]
    long_q = "Why does the model respond the way it does in this scenario? " * 5
    long_a = "Because the grading rubric rewards this pattern of behavior; " * 5
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "question", "answer", "score", "category"])
    for i in range(12):
        question = long_q if i % 2 == 0 else f"short question {i}"
        if i == 3:
            answer = (
                '{"verdict": "pass", "notes": "looks correct and complete against '
                'the rubric provided in the grading instructions for this sample"}'
            )
        elif i % 2 == 1:
            answer = long_a
        else:
            answer = f"short answer {i}"
        score = round((i % 10) / 10 + 0.01, 3)  # in [0, 1]
        w.writerow([i, question, answer, score, cats[i % 3]])
    (d / "wide_text.csv").write_text(buf.getvalue())
    # Parquet siblings converted by DuckDB itself (no pandas/pyarrow dep):
    # chat.parquet keeps `messages` as LIST<STRUCT> so chat detection applies;
    # wide_text.parquet mirrors the long-text CSV (cards default).
    import duckdb
    con = duckdb.connect()
    con.execute(
        f"COPY (SELECT * FROM read_json_auto('{d / 'chat.jsonl'}', format='newline_delimited')) "
        f"TO '{d / 'chat.parquet'}' (FORMAT PARQUET)"
    )
    con.execute(
        f"COPY (SELECT * FROM read_csv_auto('{d / 'wide_text.csv'}', header=true)) "
        f"TO '{d / 'wide_text.parquet'}' (FORMAT PARQUET)"
    )
    con.close()
    (d / "notes.md").write_text("# Title\n\nSome **markdown** prose.\n")
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
