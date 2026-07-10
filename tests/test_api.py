"""API integration tests against a live server (see conftest.server)."""
from __future__ import annotations

import json

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


def test_multi_filter_and_composes(server: str):
    """Two filters in the `filters` JSON param AND-compose: category=^alpha$ AND
    question~short → strictly fewer rows than either alone."""
    path = _path_of(server, "wide_text.csv")
    both = json.dumps([
        {"column": "category", "regex": "^alpha$"},
        {"column": "question", "regex": "short"},
    ])
    page = httpx.get(
        f"{server}/api/datasets/rows", params={"path": path, "filters": both, "limit": 50}
    ).json()
    # alpha rows are i=0,3,6,9; "short question {i}" only on odd i → 3 & 9.
    assert page["total_filtered"] == 2
    assert page["indices"] == [3, 9]

    alpha = httpx.get(
        f"{server}/api/datasets/rows",
        params={"path": path, "filters": json.dumps([{"column": "category", "regex": "^alpha$"}]), "limit": 50},
    ).json()
    short = httpx.get(
        f"{server}/api/datasets/rows",
        params={"path": path, "filters": json.dumps([{"column": "question", "regex": "short"}]), "limit": 50},
    ).json()
    assert alpha["total_filtered"] == 4
    assert short["total_filtered"] == 6
    assert page["total_filtered"] < alpha["total_filtered"]
    assert page["total_filtered"] < short["total_filtered"]


def test_filters_param_composes_on_stats_and_groups(server: str):
    """`/stats` and `/groups` accept the same `filters` JSON param and shrink."""
    csv_path = _path_of(server, "wide_text.csv")
    st = httpx.get(
        f"{server}/api/datasets/stats",
        params={"path": csv_path, "filters": json.dumps([{"column": "category", "regex": "^alpha$"}])},
    ).json()
    assert st["total_rows"] == 4

    chat = _path_of(server, "chat.jsonl")
    g = httpx.get(
        f"{server}/api/datasets/groups",
        params={"path": chat, "column": "label", "filters": json.dumps([{"regex": "question 1[0-9]"}])},
    ).json()
    assert {b["value"]: b["indices"] for b in g["groups"]} == {
        "even": [10, 12, 14, 16, 18],
        "odd": [11, 13, 15, 17, 19],
    }


def test_filter_post_roundtrip(server: str):
    """POST /filter replaces the list; state serializes `filters`, not `filter_regex`."""
    r = httpx.post(
        f"{server}/api/datasets/filter",
        json={"filters": [{"column": "label", "regex": "odd"}, {"regex": "question"}]},
    )
    assert r.status_code == 200, r.text
    st = httpx.get(f"{server}/api/state").json()
    assert "filter_regex" not in st
    assert "filter_column" not in st
    assert st["filters"] == [
        {"column": "label", "regex": "odd"},
        {"column": None, "regex": "question"},
    ]
    # Empty list clears.
    httpx.post(f"{server}/api/datasets/filter", json={"filters": []})
    assert httpx.get(f"{server}/api/state").json()["filters"] == []


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


def test_group_by_cap_marks_truncated(server: str):
    path = _path_of(server, "chat.jsonl")
    g = httpx.get(
        f"{server}/api/datasets/groups", params={"path": path, "column": "label", "cap": 5}
    ).json()
    # Only the first 5 rows get bucketed; the flag surfaces the cap to the UI.
    assert g["truncated"] is True
    assert g["total_rows"] == 5


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
    # A step curve (unique `step`, ≥3 numeric cols, no long text) now sniffs as
    # the metrics view — CSVs get the same row-level detection JSONL gets.
    assert info["view_kind"] == "metrics"
    assert info["detect_meta"]["tabular"] is True
    assert set(info["detect_meta"]["numeric_cols"]) == {"step", "loss", "acc"}
    assert info["detect_meta"]["format"] == "csv"
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


def test_stats_wide_text_csv(server: str):
    path = _path_of(server, "wide_text.csv")
    st = httpx.get(f"{server}/api/datasets/stats", params={"path": path}).json()
    assert st["total_rows"] == 12
    cols = {c["name"]: c for c in st["columns"]}
    assert "__idx" not in cols

    # `id` is an integer 0..11 → index_like; its histogram covers every row.
    idc = cols["id"]
    assert idc["dtype"] == "numeric"
    assert idc["index_like"] is True
    hist = idc["histogram"]
    assert len(hist["bin_edges"]) == len(hist["counts"]) + 1
    assert hist["bin_edges"] == sorted(hist["bin_edges"])  # monotone
    assert sum(hist["counts"]) == idc["count"]  # counts sum to non-null count

    # `score` is a float in [0, 1]; not index_like (not integer).
    sc = cols["score"]
    assert sc["dtype"] == "numeric"
    assert sc["index_like"] is False
    assert 0.0 <= sc["min"] <= sc["max"] <= 1.0

    # `category` cycles through exactly 3 values, 4 each → 12.
    cat = cols["category"]
    assert cat["dtype"] == "categorical"
    assert cat["distinct"] == 3
    assert {t["value"] for t in cat["top_values"]} == {"alpha", "beta", "gamma"}
    assert sum(t["count"] for t in cat["top_values"]) == 12
    assert cat["other_count"] == 0

    # `question`/`answer` are long free-text: low distinct (12 rows) must NOT
    # make them categorical — value-length beats cardinality for text.
    for name in ("question", "answer"):
        c = cols[name]
        assert c["dtype"] == "text", name
        assert c["top_values"] is None, name
        assert c["histogram"]["is_length"] is True, name


def test_stats_composes_with_filter(server: str):
    path = _path_of(server, "wide_text.csv")
    st = httpx.get(
        f"{server}/api/datasets/stats", params={"path": path, "filter_regex": "alpha"}
    ).json()
    # Only the 4 category=alpha rows survive the filter (same semantics as /groups).
    assert st["total_rows"] == 4
    cat = {c["name"]: c for c in st["columns"]}["category"]
    assert {t["value"]: t["count"] for t in cat["top_values"]} == {"alpha": 4}


def test_stats_jsonl_text_histogram_and_index(server: str):
    # big.jsonl: `label` is high-cardinality (250 distinct) → text with a
    # length histogram; `rid` is a contiguous 0-based index.
    path = _path_of(server, "big.jsonl")
    st = httpx.get(f"{server}/api/datasets/stats", params={"path": path}).json()
    assert st["total_rows"] == 250
    cols = {c["name"]: c for c in st["columns"]}
    assert cols["rid"]["index_like"] is True
    label = cols["label"]
    assert label["dtype"] == "text"
    assert label["distinct"] == 250
    assert label["histogram"]["is_length"] is True
    assert sum(label["histogram"]["counts"]) == label["count"]


def test_stats_list_dtype_and_categorical(server: str):
    # chat.jsonl: `messages` is a LIST → length histogram; `label` categorical.
    path = _path_of(server, "chat.jsonl")
    st = httpx.get(f"{server}/api/datasets/stats", params={"path": path}).json()
    cols = {c["name"]: c for c in st["columns"]}
    assert cols["messages"]["dtype"] == "list"
    assert cols["messages"]["histogram"]["is_length"] is True
    assert cols["score"]["dtype"] == "numeric"
    label = cols["label"]
    assert label["dtype"] == "categorical"
    assert {t["value"] for t in label["top_values"]} == {"even", "odd"}


def test_stats_rejects_markdown(server: str):
    path = _path_of(server, "notes.md")
    r = httpx.get(f"{server}/api/datasets/stats", params={"path": path})
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
