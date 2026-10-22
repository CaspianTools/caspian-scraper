"""Shared pytest fixtures: a single Chromium browser per test session, a
fresh BrowserContext + Page per test."""

from __future__ import annotations

from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def playwright_browser():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        yield browser
        browser.close()


@pytest.fixture
def page(playwright_browser):
    context = playwright_browser.new_context()
    p = context.new_page()
    yield p
    context.close()


def fixture_url(name: str) -> str:
    return (FIXTURES_DIR / name).resolve().as_uri()


# ---- the SQLite record store ------------------------------------------------

import recordstore  # noqa: E402


import findings_db  # noqa: E402


@pytest.fixture(autouse=True)
def _tmp_record_store(tmp_path, monkeypatch):
    """Never touch the real SQLite working database (local-data/scraper.db)
    or the committed databases (db/*.jsonl): every test gets its own."""
    monkeypatch.setattr(recordstore, "DB_PATH", tmp_path / "scraper.db")
    monkeypatch.setattr(findings_db, "DB_DIR", tmp_path / "db")
