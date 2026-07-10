"""Unit tests for detect_view's CSV/TSV row-sniffing (Feature 1).

These call detect_view in-process; the session-autouse `_isolate_in_process_state`
fixture (conftest) keeps the DuckDB state dir off ~/.local/state."""
from __future__ import annotations

from samplescope.api.schema_detect import detect_view


def _write(tmp_path, name, text):
    p = tmp_path / name
    p.write_text(text)
    return p


def test_csv_long_text_is_json(tmp_path):
    p = _write(tmp_path, "lt.csv", 'id,text\n0,"' + "x" * 250 + '"\n1,short\n')
    kind, meta = detect_view(p)
    assert kind == "json"
    assert meta["tabular"] is True
    assert meta["numeric_cols"] == ["id"]
    assert meta["format"] == "csv"


def test_csv_scalar_only_is_table(tmp_path):
    p = _write(tmp_path, "flat.csv", "name,age,city\nalice,30,paris\nbob,25,rome\n")
    kind, meta = detect_view(p)
    assert kind == "table"
    assert meta["tabular"] is True
    assert meta["numeric_cols"] == ["age"]
    assert meta["format"] == "csv"


def test_csv_step_curve_is_metrics(tmp_path):
    rows = "\n".join(f"{i},{1.0 / (i + 1):.3f},{i * 0.05:.2f}" for i in range(10))
    p = _write(tmp_path, "curve.csv", "step,loss,acc\n" + rows + "\n")
    kind, meta = detect_view(p)
    assert kind == "metrics"
    assert set(meta["numeric_cols"]) == {"step", "loss", "acc"}
    assert meta["tabular"] is True
    assert meta["format"] == "csv"


def test_tsv_detection(tmp_path):
    p = _write(tmp_path, "flat.tsv", "name\tage\nalice\t30\nbob\t25\n")
    kind, meta = detect_view(p)
    assert kind == "table"
    assert meta["numeric_cols"] == ["age"]
    assert meta["format"] == "tsv"


def test_csv_dates_do_not_break_flatness_or_count_numeric(tmp_path):
    # A DATE column must not be counted numeric nor break the table verdict.
    p = _write(tmp_path, "dated.csv", "day,n\n2020-01-01,1\n2020-01-02,2\n")
    kind, meta = detect_view(p)
    assert kind == "table"
    assert meta["numeric_cols"] == ["n"]  # `day` (DATE) excluded


def test_malformed_csv_falls_back_to_table(tmp_path):
    # A .csv path DuckDB can't read (e.g. the file was removed after the scan
    # listed it — a real TOCTOU) must not raise; detect_view degrades to the
    # plain table view instead of 500-ing discovery.
    missing = tmp_path / "gone.csv"
    kind, meta = detect_view(missing)
    assert kind == "table"
    assert meta == {"format": "csv"}
