"""Tests for the generic (any-schema) `fields` extractor added to
ConfigurableProductParser, plus a back-compat check proving the product
(jsonld_product) path still returns a ProductListing.

Browser-backed, hermetic: a real headless Chromium loads static fixtures off
disk via file:// (mirrors tests/test_parsers.py). No network.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scrape import (  # noqa: E402  (sys.path tweak before import)
    ConfigurableProductParser,
    GenericRecord,
    ProductListing,
)
from tests.conftest import fixture_url  # noqa: E402


def _parser(page, extraction: dict) -> ConfigurableProductParser:
    return ConfigurableProductParser(
        page, extraction, retailer_id="test_src", retailer_name="Test Source"
    )


# ---------- generic `fields` extractor ----------

def test_fields_extractor_text_and_attribute(page):
    extraction = {
        "extractors": [
            {
                "type": "fields",
                "fields": {
                    "title": "h1.headline",
                    "published": "time.published@datetime",
                    "author": "a.byline",
                    "body": "div.content",
                },
            }
        ]
    }
    rec = _parser(page, extraction).parse_one(fixture_url("aiconfig/blog_detail.html"))
    assert isinstance(rec, GenericRecord)
    assert rec.fields["title"] == "Understanding HSE Compliance"
    # attribute extraction via `@datetime`, not the visible "May 1, 2026"
    assert rec.fields["published"] == "2026-05-01T09:00:00Z"
    assert rec.fields["author"] == "Jane Doe"
    assert "safety on site" in rec.fields["body"]


def test_fields_extractor_html_suffix(page):
    extraction = {
        "extractors": [
            {"type": "fields", "fields": {"body_html": "div.content@html"}}
        ]
    }
    rec = _parser(page, extraction).parse_one(fixture_url("aiconfig/blog_detail.html"))
    assert isinstance(rec, GenericRecord)
    assert "<p>" in rec.fields["body_html"]


def test_fields_required_gating_returns_none(page):
    # A required field whose selector matches nothing → no record at all,
    # rather than a record with a blank field.
    extraction = {
        "extractors": [
            {
                "type": "fields",
                "fields": {
                    "title": "h1.headline",
                    "missing": "span.does-not-exist",
                },
                "required_fields": ["title", "missing"],
            }
        ]
    }
    rec = _parser(page, extraction).parse_one(fixture_url("aiconfig/blog_detail.html"))
    assert rec is None


def test_fields_optional_field_allowed_blank(page):
    # `missing` is present in fields but NOT required → record still returned,
    # with the optional field blank.
    extraction = {
        "extractors": [
            {
                "type": "fields",
                "fields": {
                    "title": "h1.headline",
                    "missing": "span.does-not-exist",
                },
                "required_fields": ["title"],
            }
        ]
    }
    rec = _parser(page, extraction).parse_one(fixture_url("aiconfig/blog_detail.html"))
    assert isinstance(rec, GenericRecord)
    assert rec.fields["title"] == "Understanding HSE Compliance"
    assert rec.fields["missing"] == ""


def test_fields_extractor_records_diagnostic_hit(page):
    extraction = {
        "extractors": [{"type": "fields", "fields": {"title": "h1.headline"}}]
    }
    parser = _parser(page, extraction)
    parser.parse_one(fixture_url("aiconfig/blog_detail.html"))
    assert parser.diagnostics["extractor_hits"]["fields"] == 1


# ---------- back-compat: product extractor unchanged ----------

def test_jsonld_product_still_returns_product_listing(page):
    extraction = {"extractors": [{"type": "jsonld_product"}]}
    rec = _parser(page, extraction).parse_one(fixture_url("aiconfig/shop_detail.html"))
    assert isinstance(rec, ProductListing)
    assert rec.name == "Widget X"
    assert rec.price_value == 12.5
    assert rec.price_currency == "AED"
    assert rec.brand == "Acme"
    assert rec.in_stock is True
