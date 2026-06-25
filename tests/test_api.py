"""API integration tests against a live server (see conftest.server)."""
from __future__ import annotations

import httpx


def test_health(server: str):
    r = httpx.get(f"{server}/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "chat_available" in body


def test_list_datasets(server: str):
    items = httpx.get(f"{server}/api/datasets").json()
    by_name = {e["name"]: e for e in items}
    assert by_name["chat.jsonl"]["kind"] == "jsonl"
    assert by_name["metrics.csv"]["kind"] == "csv"
    assert by_name["flat.jsonl"]["kind"] == "jsonl"
    assert by_name["notes.md"]["kind"] == "markdown"
    # Paths are relative to the serving root and include nesting.
    assert by_name["flat.jsonl"]["path"].endswith("nested/flat.jsonl")


def test_markdown_info_and_raw(server: str):
    """A `.md` file detects as the markdown view kind and serves its raw text."""
    path = _path_of(server, "notes.md")
    info = httpx.get(f"{server}/api/datasets/info", params={"path": path}).json()
    assert info["view_kind"] == "markdown"
    # Markdown bypasses the row pipeline — no rows, no columns.
    assert info["row_count"] == 0
    assert info["columns"] == []
    raw = httpx.get(f"{server}/api/datasets/file", params={"path": path}).text
    assert "# Title" in raw and "**markdown**" in raw


def _path_of(server: str, name: str) -> str:
    items = httpx.get(f"{server}/api/datasets").json()
    return next(e["path"] for e in items if e["name"] == name)


def test_chat_jsonl_info_and_rows(server: str):
    path = _path_of(server, "chat.jsonl")
    info = httpx.get(f"{server}/api/datasets/info", params={"path": path}).json()
    assert info["view_kind"] == "chat"
    assert info["row_count"] == 20
    assert "messages" in info["columns"]

    page = httpx.get(
        f"{server}/api/datasets/rows", params={"path": path, "limit": 5}
    ).json()
    assert page["total_filtered"] == 20
    assert page["indices"] == [0, 1, 2, 3, 4]
    assert page["rows"][0]["messages"][0]["content"] == "question 0"


def test_regex_filter(server: str):
    path = _path_of(server, "chat.jsonl")
    page = httpx.get(
        f"{server}/api/datasets/rows",
        params={"path": path, "filter_regex": "question 1[0-9]", "limit": 50},
    ).json()
    assert page["total_filtered"] == 10  # questions 10..19
    # __idx is the original row index, stable under filtering.
    assert page["indices"][0] == 10

    page = httpx.get(
        f"{server}/api/datasets/rows",
        params={"path": path, "filter_regex": "odd", "filter_column": "label", "limit": 50},
    ).json()
    assert page["total_filtered"] == 10


def test_group_by_buckets_in_visible_order(server: str):
    path = _path_of(server, "chat.jsonl")
    g = httpx.get(
        f"{server}/api/datasets/groups", params={"path": path, "column": "label"}
    ).json()
    assert g["column"] == "label"
    assert g["total_groups"] == 2
    assert g["total_rows"] == 20
    assert not g["truncated"]
    # First appearance order: row 0 is "even", so the even bucket comes first;
    # within a bucket, members keep visible (row) order.
    buckets = {b["value"]: b["indices"] for b in g["groups"]}
    assert g["groups"][0]["value"] == "even"
    assert buckets["even"] == [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]
    assert buckets["odd"] == [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]


def test_group_by_composes_with_filter(server: str):
    path = _path_of(server, "chat.jsonl")
    g = httpx.get(
        f"{server}/api/datasets/groups",
        params={"path": path, "column": "label", "filter_regex": "question 1[0-9]"},
    ).json()
    # Only rows 10..19 are visible → grouping is computed over those.
    assert {b["value"]: b["indices"] for b in g["groups"]} == {
        "even": [10, 12, 14, 16, 18],
        "odd": [11, 13, 15, 17, 19],
    }


def test_group_by_unknown_column_is_400(server: str):
    path = _path_of(server, "chat.jsonl")
    r = httpx.get(f"{server}/api/datasets/groups", params={"path": path, "column": "nope"})
    assert r.status_code == 400


def test_group_by_synthetic_message_keys(server: str):
    """`message_1` / `message_2` extract messages[0]/[1].content for chat rows."""
    path = _path_of(server, "chat.jsonl")
    g1 = httpx.get(
        f"{server}/api/datasets/groups", params={"path": path, "column": "message_1"}
    ).json()
    assert g1["groups"][0]["value"] == "question 0"
    assert g1["groups"][0]["indices"] == [0]
    g2 = httpx.get(
        f"{server}/api/datasets/groups", params={"path": path, "column": "message_2"}
    ).json()
    assert g2["groups"][0]["value"] == "answer 0"
    # A non-chat file has no `messages`, so the synthetic key is rejected.
    csv = _path_of(server, "metrics.csv")
    r = httpx.get(f"{server}/api/datasets/groups", params={"path": csv, "column": "message_1"})
    assert r.status_code == 400


def test_csv_info_and_rows(server: str):
    path = _path_of(server, "metrics.csv")
    info = httpx.get(f"{server}/api/datasets/info", params={"path": path}).json()
    assert info["view_kind"] == "table"
    assert info["row_count"] == 10
    assert info["columns"] == ["step", "loss", "acc"]

    page = httpx.get(
        f"{server}/api/datasets/rows", params={"path": path, "limit": 3}
    ).json()
    assert page["rows"][0]["step"] == 0


def test_sql_over_csv(server: str):
    path = _path_of(server, "metrics.csv")
    r = httpx.post(
        f"{server}/api/datasets/sql",
        json={"sql": "SELECT __idx, step FROM t WHERE step >= 8", "path": path},
    ).json()
    assert r["columns"] == ["__idx", "step"]
    assert len(r["rows"]) == 2


def test_sql_rejects_writes(server: str):
    r = httpx.post(
        f"{server}/api/datasets/sql",
        json={"sql": "DROP TABLE t", "path": _path_of(server, "metrics.csv")},
    )
    assert r.status_code == 400


def test_shuffle_is_seed_stable(server: str):
    path = _path_of(server, "chat.jsonl")
    a = httpx.get(
        f"{server}/api/datasets/rows",
        params={"path": path, "shuffle_seed": 42, "limit": 20},
    ).json()
    b = httpx.get(
        f"{server}/api/datasets/rows",
        params={"path": path, "shuffle_seed": 42, "limit": 20},
    ).json()
    assert a["indices"] == b["indices"]
    assert a["indices"] != list(range(20))


def test_marks_roundtrip(server: str):
    path = _path_of(server, "chat.jsonl")
    put = httpx.put(
        f"{server}/api/marks/{path}/3",
        json={"tags": ["check"], "note": "from test"},
    )
    assert put.status_code == 200, put.text
    got = httpx.get(f"{server}/api/marks/{path}/3").json()
    assert got["tags"] == ["check"]
    assert got["note"] == "from test"
    listed = httpx.get(f"{server}/api/marks", params={"path": path}).json()
    assert any(m["row_idx"] == 3 for m in listed)


def test_path_escape_refused(server: str):
    r = httpx.get(f"{server}/api/datasets/info", params={"path": "../../etc/passwd"})
    assert r.status_code >= 400


def test_static_ui_served(server: str):
    r = httpx.get(f"{server}/")
    assert r.status_code == 200
    assert "<!doctype html>" in r.text.lower()
    # API precedence over the SPA mount.
    assert httpx.get(f"{server}/api/health").headers["content-type"].startswith("application/json")
