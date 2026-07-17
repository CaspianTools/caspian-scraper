"""Live preview: run the REAL generic engine against a target with tight caps.

This is the agent's ground-truth feedback signal — the same
ConfigurableProductParser the cron uses, so a config that previews clean will
scrape clean. No persistence, capped to 1 discovery page and a handful of
detail pages so authoring a config never hammers a site.
"""

from __future__ import annotations

import copy
from typing import Any


def run_preview(
    extraction: dict,
    start_url: str,
    detail_url: str = "",
    *,
    max_pages: int = 1,
    max_items: int = 5,
) -> tuple[list[dict], dict]:
    """Return (sample_records, diagnostics). sample_records are normalised flat
    dicts (via scrape._generic_record_to_data). Never raises — engine errors are
    surfaced through diagnostics.http_errors / an empty record list."""
    # Import here so the module stays cheap to import (scrape pulls in firebase).
    from playwright.sync_api import sync_playwright

    from scrape import (
        ConfigurableProductParser,
        _DEFAULT_UA,
        _generic_record_to_data,
    )

    # Cap discovery to one page for the preview without mutating the caller's dict.
    cfg = copy.deepcopy(extraction or {})
    ld = cfg.get("link_discovery")
    if isinstance(ld, dict):
        ld["max_pages"] = 1
    # A short delay keeps the preview snappy but still polite.
    cfg["request_delay_ms"] = min(int(cfg.get("request_delay_ms") or 300), 500)

    records: list[dict] = []
    parser: Any = None
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ua = str(cfg.get("user_agent") or _DEFAULT_UA)
        context = browser.new_context(user_agent=ua)
        page = context.new_page()
        try:
            parser = ConfigurableProductParser(
                page, cfg, retailer_id="(preview)", retailer_name="(preview)"
            )
            links = parser.discover_links(start_url)
            parser.diagnostics["links_discovered"] += len(links)
            links = links[:max_items]
            if detail_url and detail_url not in links:
                links = [detail_url] + links[: max_items - 1]
            for link in links:
                try:
                    rec = parser.parse_one(link)
                except Exception:  # noqa: BLE001 — preview must never crash
                    continue
                if rec is not None:
                    records.append(_generic_record_to_data(rec))
        finally:
            try:
                browser.close()
            except Exception:
                pass

    diagnostics = parser.diagnostics if parser is not None else {}
    return records, diagnostics
