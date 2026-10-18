"""Pure tests for aiconfig.config_schema.validate_extraction / derive_output_schema."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig.config_schema import (  # noqa: E402
    derive_output_schema,
    validate_extraction,
)


def test_valid_jsonld_config():
    cfg = {
        "link_discovery": {"mode": "css", "link_selector": "a[href*='/p/']"},
        "extractors": [{"type": "jsonld_product"}, {"type": "og_meta"}],
        "request_delay_ms": 1500,
    }
    assert validate_extraction(cfg) == []


def test_valid_fields_config():
    cfg = {
        "link_discovery": {"mode": "css", "link_selector": "a[href*='/post/']"},
        "extractors": [
            {
                "type": "fields",
                "fields": {"title": "h1", "date": "time@datetime"},
                "required_fields": ["title"],
            }
        ],
    }
    assert validate_extraction(cfg) == []


def test_unknown_extractor_type_rejected():
    cfg = {
        "link_discovery": {"mode": "css", "link_selector": "a"},
        "extractors": [{"type": "bogus"}],
    }
    errs = validate_extraction(cfg)
    assert any("extractors[0].type" in e for e in errs)


def test_empty_fields_rejected():
    cfg = {
        "link_discovery": {"mode": "css", "link_selector": "a"},
        "extractors": [{"type": "fields", "fields": {}}],
    }
    errs = validate_extraction(cfg)
    assert any("fields must be a non-empty object" in e for e in errs)


def test_required_fields_must_be_declared():
    cfg = {
        "link_discovery": {"mode": "css", "link_selector": "a"},
        "extractors": [
            {"type": "fields", "fields": {"title": "h1"},
             "required_fields": ["title", "ghost"]},
        ],
    }
    errs = validate_extraction(cfg)
    assert any("undeclared fields" in e for e in errs)


def test_bad_link_discovery_mode_rejected():
    cfg = {
        "link_discovery": {"mode": "telepathy"},
        "extractors": [{"type": "jsonld_product"}],
    }
    errs = validate_extraction(cfg)
    assert any("link_discovery.mode" in e for e in errs)


def test_sitemap_requires_url():
    cfg = {
        "link_discovery": {"mode": "sitemap"},
        "extractors": [{"type": "jsonld_product"}],
    }
    errs = validate_extraction(cfg)
    assert any("sitemap_url" in e for e in errs)


def test_css_extractor_needs_name_price_currency():
    cfg = {
        "link_discovery": {"mode": "css", "link_selector": "a"},
        "extractors": [{"type": "css"}],
    }
    errs = validate_extraction(cfg)
    assert any("name_selector" in e for e in errs)
    assert any("price_selector" in e for e in errs)
    assert any("currency" in e for e in errs)


def test_extractors_count_bounds():
    assert any("1..6" in e for e in validate_extraction(
        {"link_discovery": {"mode": "css", "link_selector": "a"}, "extractors": []}
    ))


def test_oversize_selector_rejected():
    cfg = {
        "link_discovery": {"mode": "css", "link_selector": "a"},
        "extractors": [{"type": "fields", "fields": {"x": "y" * 600}}],
    }
    assert validate_extraction(cfg) != []


def test_derive_output_schema_fields():
    cfg = {"extractors": [{"type": "fields",
                           "fields": {"title": "h1", "author": ".by"}}]}
    assert derive_output_schema(cfg) == ["title", "author"]


def test_derive_output_schema_product():
    cfg = {"extractors": [{"type": "jsonld_product"}]}
    out = derive_output_schema(cfg)
    assert "name" in out and "price_value" in out


def test_category_seeds_max_pages_bounds():
    cfg = {
        "link_discovery": {
            "mode": "category_seeds",
            "seed_urls": ["https://x"],
            "link_selector": "a",
            "max_pages": 999,
        },
        "extractors": [{"type": "jsonld_product"}],
    }
    assert any("max_pages" in e for e in validate_extraction(cfg))
