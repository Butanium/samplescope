"""Playwright smoke: click the main affordances of the packaged UI.

Hermetic — runs against the same live server fixture as the API tests,
serving the built frontend (web_dist / web/dist). Skipped with a clear
message if no frontend build exists.
"""
from __future__ import annotations

import json
import re
from urllib.parse import quote

import httpx
import pytest
from playwright.sync_api import Page, expect


@pytest.fixture(autouse=True)
def _require_built_ui(server: str):
    r = httpx.get(f"{server}/")
    if "<!doctype html>" not in r.text.lower():
        pytest.skip("no built frontend (run `make build` first)")


def open_file(page: Page, name: str) -> None:
    """Click a file in the tree. Scoped to the tree aside (role=complementary)
    because the header path display shows the *open* dataset's basename, which
    collides with `get_by_text(name)` once that file is open. `.first` because a
    file can also appear in the sidebar's "recent" section — the tree row sorts
    first in DOM order, so `.first` lands on it."""
    page.get_by_role("complementary").first.get_by_text(name, exact=True).first.click()


def test_open_chat_dataset_and_navigate(page: Page, server: str):
    page.goto(server)
    # Dataset tree lists the files; click the chat dataset.
    open_file(page, "chat.jsonl")
    # Chat view renders the first row's bubbles.
    expect(page.get_by_text("question 0", exact=True)).to_be_visible()
    expect(page.get_by_text("answer 0", exact=True)).to_be_visible()
    # `j` steps to the next row.
    page.keyboard.press("j")
    expect(page.get_by_text("question 1", exact=True)).to_be_visible()


def test_open_csv_renders_table(page: Page, server: str):
    page.goto(server)
    open_file(page, "plain.csv")
    # Scalar-only CSV (name,age,city) → the flat `table` view by default: its
    # column headers render. (`filter(visible=...)`: the names also appear in the
    # header's hidden sort/group/filter-column <option>s.)
    main = page.get_by_role("main")
    expect(main.get_by_text("name", exact=True).filter(visible=True).first).to_be_visible()
    expect(main.get_by_text("city", exact=True).filter(visible=True).first).to_be_visible()


def test_open_metrics_csv_renders_plot(page: Page, server: str):
    page.goto(server)
    open_file(page, "metrics.csv")
    # metrics.csv (numeric, unique `step`, no long text) detects as `metrics` →
    # the plot view is the default; toggling switches it to the flat table.
    main = page.get_by_role("main")
    expect(main.get_by_text(re.compile(r"numeric columns"))).to_be_visible()
    main.get_by_role("button", name="table", exact=True).click()
    expect(main.get_by_text(re.compile(r"click a row to expand"))).to_be_visible()


def test_json_field_hide_folds_and_persists(page: Page, server: str):
    page.goto(server)
    open_file(page, "records.jsonl")
    main = page.get_by_role("main")
    # json card view renders each top-level field as a `key:` label; no drawer yet.
    expect(main.get_by_text("response:", exact=True).first).to_be_visible()
    expect(main.get_by_text(re.compile("more field"))).to_have_count(0)
    # Hide the first field → it folds into a "1 more field" drawer.
    main.get_by_title(re.compile("^hide")).first.click()
    expect(main.get_by_text(re.compile("more field")).first).to_be_visible()
    # The choice is a schema-keyed pref: it survives a reload.
    page.reload()
    expect(main.get_by_text(re.compile("more field")).first).to_be_visible()


def test_json_field_pin_to_header(page: Page, server: str):
    page.goto(server)
    open_file(page, "records.jsonl")
    main = page.get_by_role("main")
    expect(main.get_by_text("response:", exact=True).first).to_be_visible()
    # Pin the first field into the header → an unpin affordance now exists.
    expect(main.get_by_title(re.compile("^unpin"))).to_have_count(0)
    main.get_by_title(re.compile("^pin to")).first.click()
    expect(main.get_by_title(re.compile("^unpin")).first).to_be_visible()
    page.reload()
    expect(main.get_by_title(re.compile("^unpin")).first).to_be_visible()


def test_json_field_layout_shared_across_same_schema(page: Page, server: str):
    page.goto(server)
    # Arrange records.jsonl: hide a field.
    open_file(page, "records.jsonl")
    main = page.get_by_role("main")
    expect(main.get_by_text("response:", exact=True).first).to_be_visible()
    main.get_by_title(re.compile("^hide")).first.click()
    expect(main.get_by_text(re.compile("more field")).first).to_be_visible()
    # records2.jsonl has the SAME field set → it inherits the layout, no edits.
    open_file(page, "records2.jsonl")
    expect(main.get_by_text("other-0").first).to_be_visible()  # records2's data loaded
    expect(main.get_by_text(re.compile("more field")).first).to_be_visible()


def test_group_by_grouped_feed_cycler(page: Page, server: str):
    page.goto(server)
    open_file(page, "records.jsonl")
    main = page.get_by_role("main")
    expect(main.get_by_text("response:", exact=True).first).to_be_visible()
    # Group by the even/odd bucket → the feed collapses to one card per group.
    page.get_by_title(re.compile("group samples")).select_option("bucket")
    expect(main.get_by_text(re.compile(r"2 groups"))).to_be_visible()
    # The first card (even bucket: rows 0,2,4) starts on row 0; its own cycler
    # swaps the member in place → row 2, without touching the second card.
    expect(main.get_by_text(re.compile(r"grp 1/2 · row 0"))).to_be_visible()
    main.get_by_title(re.compile(r"next in group")).first.click()
    expect(main.get_by_text(re.compile(r"grp 1/2 · row 2"))).to_be_visible()
    # Second group's card is independent — still on its first member.
    expect(main.get_by_text(re.compile(r"grp 2/2 · row 1"))).to_be_visible()


def test_group_by_chat_grouped_feed(page: Page, server: str):
    page.goto(server)
    open_file(page, "chat.jsonl")
    main = page.get_by_role("main")
    expect(page.get_by_text("question 0", exact=True)).to_be_visible()
    # Group the chat feed by the even/odd label → one card per group, each a
    # chat transcript with its own cycler (the same overlay the json view uses,
    # proving GroupedFeed is view-agnostic).
    page.get_by_title(re.compile("group samples")).select_option("label")
    expect(main.get_by_text(re.compile(r"2 groups"))).to_be_visible()
    # First card (even rows 0,2,…) starts on row 0 → its transcript shows q0.
    expect(main.get_by_text(re.compile(r"grp 1/2 · row 0"))).to_be_visible()
    expect(main.get_by_text("question 0", exact=True)).to_be_visible()
    # Cycle that card in place → row 2 (q2), without touching the odd card.
    main.get_by_title(re.compile(r"next in group")).first.click()
    expect(main.get_by_text(re.compile(r"grp 1/2 · row 2"))).to_be_visible()
    expect(main.get_by_text("question 2", exact=True)).to_be_visible()
    expect(main.get_by_text(re.compile(r"grp 2/2 · row 1"))).to_be_visible()


def test_json_feed_infinite_scroll(page: Page, server: str):
    page.goto(server)
    open_file(page, "big.jsonl")
    main = page.get_by_role("main")
    # First page is 100 of 250 rows.
    expect(main.get_by_text(re.compile(r"showing 100 of 250"))).to_be_visible()
    # Scrolling the feed to the bottom pulls the next pages until all are loaded.
    scroll_all = """() => {
      document.querySelectorAll('div').forEach(e => {
        if (e.scrollHeight > e.clientHeight && getComputedStyle(e).overflowY === 'auto')
          e.scrollTop = e.scrollHeight;
      });
    }"""
    for _ in range(8):
        if "showing 250 of 250" in main.inner_text():
            break
        page.evaluate(scroll_all)
        page.wait_for_timeout(300)
    expect(main.get_by_text(re.compile(r"showing 250 of 250"))).to_be_visible()


def test_tree_filter_autorefreshes_for_new_file(page: Page, server: str, dataset_dir):
    page.goto(server)
    aside = page.get_by_role("complementary").first
    # Wait for the initial scan so the new file is genuinely absent from the
    # cached list (created *after* the tree loaded).
    expect(aside.get_by_text("chat.jsonl", exact=True)).to_be_visible()
    new = dataset_dir / "surprise_new.jsonl"
    new.write_text('{"x": 1}\n')
    try:
        # Typing its name hits nothing in the stale list → the tree auto-rescans
        # and the file appears, no manual refresh-button click.
        aside.get_by_placeholder("filter…").fill("surprise_new")
        expect(aside.get_by_text("surprise_new.jsonl", exact=True)).to_be_visible(timeout=10000)
    finally:
        new.unlink(missing_ok=True)


def test_tree_recent_and_only_opened(page: Page, server: str):
    # The shared backend state dir leaks prefs across tests, so reset the
    # opened-files history + filter deterministically (and pre-expand recent).
    # Leave only-opened OFF in finally so later tests see the full tree.
    def setpref(key: str, value) -> None:
        httpx.put(f"{server}/api/prefs/{key}", json={"value": json.dumps(value)})

    setpref("tree.openedFiles", [])
    setpref("tree.onlyOpened", False)
    setpref("tree.recentOpen", True)
    try:
        page.goto(server)
        aside = page.get_by_role("complementary").first
        # Open two files → both land in the history (recorded from dataset_path).
        open_file(page, "records.jsonl")
        expect(page.get_by_role("main").get_by_text("response:", exact=True).first).to_be_visible()
        open_file(page, "chat.jsonl")
        expect(page.get_by_text("question 0", exact=True)).to_be_visible()
        # chat.jsonl now shows BOTH in the tree and in the (expanded) recent
        # section → 2 occurrences proves the recent section rendered it.
        expect(aside.get_by_text("chat.jsonl", exact=True)).to_have_count(2)
        # "only opened" hides never-opened files (metrics.csv) from the tree;
        # it isn't in recent either, so it vanishes entirely.
        aside.get_by_title(re.compile(r"only files you've opened")).click()
        expect(aside.get_by_text("metrics.csv", exact=True)).to_have_count(0)
        expect(aside.get_by_text("chat.jsonl", exact=True)).to_have_count(2)
        expect(aside.get_by_text("records.jsonl", exact=True)).to_have_count(2)
    finally:
        # Restore defaults so later tests don't inherit a filtered tree or an
        # expanded recent section (which would double file rows in the sidebar).
        setpref("tree.onlyOpened", False)
        setpref("tree.recentOpen", False)


def test_regex_filter_narrows_rows(page: Page, server: str):
    page.goto(server)
    open_file(page, "chat.jsonl")
    expect(page.get_by_text("question 0", exact=True)).to_be_visible()
    # `/` focuses the regex filter input.
    page.keyboard.press("/")
    page.keyboard.type("question 7")
    page.keyboard.press("Enter")
    expect(page.get_by_text("question 7", exact=True)).to_be_visible()
    expect(page.get_by_text("question 0", exact=True)).not_to_be_visible()


# ── wide-CSV view modes (samples/table/stats) + JSON-string expansion ─────────
# These deep-link `?path=…` (the URL is the full view state) rather than clicking
# the tree: it forces the bridge's openDataset on mount, so the render is
# deterministic regardless of what the shared session server had open before.


def test_wide_csv_defaults_to_cards_and_toggles_table(page: Page, server: str):
    page.goto(f"{server}/?path={quote('wide_text.csv')}")
    main = page.get_by_role("main")
    # Long free-text CSV → json card view by default (not the truncating table):
    # top-level fields render as `key:` labels.
    expect(main.get_by_text("category:", exact=True).first).to_be_visible()
    # The samples/table/stats mode toggle bar is present (no plot: no `step`).
    expect(main.get_by_role("button", name="samples", exact=True)).to_be_visible()
    expect(main.get_by_role("button", name="table", exact=True)).to_be_visible()
    expect(main.get_by_role("button", name="stats", exact=True)).to_be_visible()
    # Switch to the table → the spreadsheet header appears; URL carries view=table.
    main.get_by_role("button", name="table", exact=True).click()
    expect(main.get_by_text(re.compile(r"click a row to expand"))).to_be_visible()
    expect(page).to_have_url(re.compile(r"view=table"))


def test_stats_deeplink_renders_grid(page: Page, server: str):
    page.goto(f"{server}/?path={quote('wide_text.csv')}&view=stats")
    main = page.get_by_role("main")
    # StatsView header (12 rows, unfiltered) + a per-column card for `category`.
    # `filter(visible=True)`: `category` also appears in the header's hidden
    # sort/group/filter-column <option>s, which sort first in the DOM.
    expect(main.get_by_text(re.compile(r"12\s*rows"))).to_be_visible()
    expect(main.get_by_text("category", exact=True).filter(visible=True).first).to_be_visible()
    # `id` is a contiguous index → excluded from the grid, named in the footer.
    expect(main.get_by_text(re.compile(r"skipped index-like:.*id"))).to_be_visible()


def test_json_string_cell_expands(page: Page, server: str, dataset_dir):
    # The frontend seam only matters for a JSON-object string the backend leaves
    # as a string: `_jsonify` parses TOP-LEVEL cells server-side (so wide_text's
    # `answer` arrives pre-parsed), but not values NESTED inside an object. So
    # this uses `meta.grade` — a nested JSON string — which reaches the client as
    # a raw string and is expanded in-place by jsonCards' StringLeaf.
    f = dataset_dir / "nested_json_cell.jsonl"
    f.write_text(json.dumps({"id": 0, "meta": {"grade": '{"verdict": "pass"}', "other": "plain"}}) + "\n")
    try:
        page.goto(f"{server}/?path={quote('nested_json_cell.jsonl')}&view=samples&mode=single&idx=0")
        main = page.get_by_role("main")
        # `verdict:` only renders as a field if StringLeaf parsed the nested
        # string; without the seam it would show the raw `{"verdict": …}` text.
        expect(main.get_by_text("verdict:", exact=True)).to_be_visible()
    finally:
        f.unlink(missing_ok=True)
