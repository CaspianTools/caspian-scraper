"""Shared Playwright helper.

Several sites (OpenSooq, Dubizzle, Facebook) are JS apps and/or sit
behind Cloudflare, so a real browser is the robust way to fetch their
HTML. This wraps launch + context creation, including the pinned-revision
fallback used on the managed runners (PLAYWRIGHT_BROWSERS_PATH).
"""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
from typing import Iterator

from playwright.sync_api import Browser, BrowserContext, sync_playwright

from .http import DEFAULT_UA


def _launch(pw):
    try:
        return pw.chromium.launch(headless=True)
    except Exception:
        # Managed runners ship a browser at a revision that may differ
        # from the pip playwright pin; fall back to the on-disk binary.
        exe = os.environ.get("CHROMIUM_EXECUTABLE_PATH")
        if not exe:
            base = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
            cand = Path(base) / "chromium"
            exe = str(cand) if cand.exists() else None
        return pw.chromium.launch(headless=True, executable_path=exe)


def _load_cookies(context: BrowserContext, cookies_path: str) -> None:
    """Accept either a Playwright storage_state file (has 'cookies' key) or
    a flat cookie-editor export (a JSON array of cookie objects)."""
    data = json.loads(Path(cookies_path).read_text())
    raw = data["cookies"] if isinstance(data, dict) else data
    cookies = []
    for c in raw:
        cookie = {
            "name": c["name"],
            "value": c["value"],
            "domain": c.get("domain", ".facebook.com"),
            "path": c.get("path", "/"),
        }
        if c.get("expirationDate"):
            cookie["expires"] = int(c["expirationDate"])
        cookies.append(cookie)
    context.add_cookies(cookies)


@contextlib.contextmanager
def browser_context(
    *, cookies_path: str = "", locale: str = "en-US"
) -> Iterator[BrowserContext]:
    with sync_playwright() as pw:
        browser: Browser = _launch(pw)
        context = browser.new_context(
            user_agent=DEFAULT_UA,
            locale=locale,
            viewport={"width": 1366, "height": 900},
        )
        context.set_default_timeout(45_000)
        if cookies_path:
            _load_cookies(context, cookies_path)
        try:
            yield context
        finally:
            context.close()
            browser.close()


def fetch_html(context: BrowserContext, url: str, *, wait_selector: str = "") -> str:
    """Navigate and return the fully-rendered HTML."""
    page = context.new_page()
    try:
        page.goto(url, wait_until="domcontentloaded")
        if wait_selector:
            with contextlib.suppress(Exception):
                page.wait_for_selector(wait_selector, timeout=15_000)
        else:
            with contextlib.suppress(Exception):
                page.wait_for_load_state("networkidle", timeout=15_000)
        return page.content()
    finally:
        page.close()
