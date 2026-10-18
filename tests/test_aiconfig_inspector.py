"""Tests for aiconfig.inspector.

The pure core build_evidence_from_html runs over fixture strings (no network).
One live test drives inspect_url against a file:// fixture to exercise the
query_selector match-count enrichment.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig.inspector import (  # noqa: E402
    _css_href_selector,
    build_evidence_from_html,
    inspect_url,
)
from tests.conftest import fixture_url  # noqa: E402

FIX = REPO_ROOT / "tests" / "fixtures" / "aiconfig"


def _html(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


# ---------- pure core ----------

def test_detects_jsonld_product():
    ev = build_evidence_from_html(_html("shop_detail.html"), "https://x/p/1")
    assert ev.jsonld_product_present is True
    assert "Product" in ev.jsonld_types
    assert ev.detected_currency == "AED"
    assert ev.jsonld_sample and ev.jsonld_sample.get("name") == "Widget X"


def test_detects_next_data():
    ev = build_evidence_from_html(_html("next_data_listing.html"), "https://x/list")
    assert ev.has_next_data is True
    assert "items" in ev.next_data_keys


def test_detects_og_meta():
    ev = build_evidence_from_html(_html("shop_listing.html"), "https://x/shop")
    assert ev.og_meta.get("og:title") == "Acme Shop"


def test_detects_repeated_block_grid():
    ev = build_evidence_from_html(_html("shop_listing.html"), "https://x/shop")
    assert ev.repeated_blocks, "should find a repeated /p/ link group"
    top = ev.repeated_blocks[0]
    assert "/p/" in top.href_includes
    assert top.count >= 3
    assert "href*='/p/'" in top.link_selector


def test_blog_has_no_product_and_an_excerpt():
    ev = build_evidence_from_html(_html("blog_detail.html"), "https://x/post")
    assert ev.jsonld_product_present is False
    assert "HSE Compliance" in ev.html_excerpt


def test_never_raises_on_garbage():
    ev = build_evidence_from_html("<html><body>no data", "https://x")
    assert ev.url == "https://x"
    assert ev.jsonld_product_present is False


def test_css_href_selector_escapes_apostrophe():
    # No quote -> plain single-quoted.
    assert _css_href_selector("/p/") == "a[href*='/p/']"
    # Apostrophe in the path -> switch to double quotes (still valid CSS).
    assert _css_href_selector("/o'reilly/") == 'a[href*="/o\'reilly/"]'


# ---------- live enrichment ----------

def test_inspect_url_live_field_candidates():
    ev = inspect_url(fixture_url("aiconfig/shop_detail.html"), kind="detail")
    # h1 "Widget X" is on the page → a title candidate with a live match count.
    assert "title" in ev.field_candidates
    titles = ev.field_candidates["title"]
    assert any(c.match_count >= 1 for c in titles)
    assert any("Widget X" in c.sample_text for c in titles)
