"""Playwright smoke: click the main affordances of the packaged UI.

Hermetic — runs against the same live server fixture as the API tests,
serving the built frontend (web_dist / web/dist). Skipped with a clear
message if no frontend build exists.
"""
from __future__ import annotations

import httpx
import pytest
from playwright.sync_api import Page, expect


@pytest.fixture(autouse=True)
def _require_built_ui(server: str):
    r = httpx.get(f"{server}/")
    if "<!doctype html>" not in r.text.lower():
        pytest.skip("no built frontend (run `make build` first)")


def test_open_chat_dataset_and_navigate(page: Page, server: str):
    page.goto(server)
    # Dataset tree lists the files; click the chat dataset.
    page.get_by_text("chat.jsonl", exact=True).click()
    # Chat view renders the first row's bubbles.
    expect(page.get_by_text("question 0", exact=True)).to_be_visible()
    expect(page.get_by_text("answer 0", exact=True)).to_be_visible()
    # `j` steps to the next row.
    page.keyboard.press("j")
    expect(page.get_by_text("question 1", exact=True)).to_be_visible()


def test_open_csv_renders_table(page: Page, server: str):
    page.goto(server)
    page.get_by_text("metrics.csv", exact=True).click()
    # Table view shows the CSV's column headers. (`filter(visible=...)`:
    # the column names also appear in a hidden filter-column <option>.)
    expect(page.get_by_text("loss", exact=True).filter(visible=True)).to_be_visible()
    expect(page.get_by_text("acc", exact=True).filter(visible=True)).to_be_visible()


def test_regex_filter_narrows_rows(page: Page, server: str):
    page.goto(server)
    page.get_by_text("chat.jsonl", exact=True).click()
    expect(page.get_by_text("question 0", exact=True)).to_be_visible()
    # `/` focuses the regex filter input.
    page.keyboard.press("/")
    page.keyboard.type("question 7")
    page.keyboard.press("Enter")
    expect(page.get_by_text("question 7", exact=True)).to_be_visible()
    expect(page.get_by_text("question 0", exact=True)).not_to_be_visible()
