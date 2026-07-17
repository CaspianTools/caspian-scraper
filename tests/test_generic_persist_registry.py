"""Pure tests for aiconfig.persist (doc building) and the adapters registry."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import adapters  # noqa: E402
from adapters.base import FetchSpec  # noqa: E402
from aiconfig import persist  # noqa: E402


# ---------- schema hint ----------

def test_parse_schema_hint_required_marker():
    specs = persist.parse_schema_hint("title:string*, amount:number, url:url*")
    by = {s["name"]: s for s in specs}
    assert by["title"]["required"] is True
    assert by["title"]["type"] == "string"
    assert by["amount"]["required"] is False
    assert by["amount"]["type"] == "number"
    assert by["url"]["required"] is True and by["url"]["type"] == "url"


def test_parse_schema_hint_bad_type_defaults_string():
    specs = persist.parse_schema_hint("x:weird")
    assert specs[0]["type"] == "string"


# ---------- doc building ----------

def test_build_config_source_active_and_strategy():
    ext = {"link_discovery": {"mode": "css", "link_selector": "a"},
           "extractors": [{"type": "fields", "fields": {"title": "h1"},
                           "required_fields": ["title"]}]}
    doc = persist.build_generic_source_doc(
        name="My Blog Scraper", owner_uid="u1", start_urls=["https://x/blog"],
        extraction=ext, output_schema=["title", "author"],
    )
    assert doc["strategy"]["mode"] == "config"
    assert doc["strategy"]["extraction"] == ext
    assert doc["active"] is True
    assert doc["source_key"] == "my-blog-scraper"
    by = {s["name"]: s for s in doc["record_schema"]}
    assert by["title"]["required"] is True     # from extraction.required_fields
    assert by["author"]["required"] is False


def test_build_adapter_source_inactive():
    doc = persist.build_generic_source_doc(
        name="Hard Site", owner_uid="u1", start_urls=["https://x"],
        adapter_key="hard_site", adapter_pr_url="https://gh/pr/1",
        output_schema=["title"],
    )
    assert doc["strategy"]["mode"] == "adapter"
    assert doc["strategy"]["adapter_key"] == "hard_site"
    assert doc["strategy"]["adapter_pr_url"] == "https://gh/pr/1"
    assert doc["active"] is False   # cannot run until merged


def test_build_record_schema_never_empty():
    doc = persist.build_generic_source_doc(
        name="x", owner_uid="u", start_urls=["https://x"], extraction={},
        output_schema=[],
    )
    assert len(doc["record_schema"]) >= 1


def test_record_schema_name_truncated_to_60():
    # A >60-char field name must be truncated to satisfy GenericFieldSpecSchema
    # (name.max(60)) so proposed_config doesn't permanently fail approve.
    long = "very_" * 20  # 100 chars
    specs = persist.build_record_schema([long], {}, "")
    assert len(specs[0]["name"]) == 60


# ---------- adapters registry ----------

def test_available_is_list():
    assert isinstance(adapters.available(), list)


def test_build_rejects_invalid_key():
    with pytest.raises(ValueError):
        adapters.build("../evil")
    with pytest.raises(ValueError):
        adapters.build("base")     # reserved
    with pytest.raises(ValueError):
        adapters.build("")


def test_build_unknown_module_raises():
    with pytest.raises(Exception):
        adapters.build("definitely_not_a_real_adapter_xyz")


# ---------- FetchSpec ----------

def test_fetchspec_from_source_and_required():
    spec = FetchSpec.from_source({
        "start_urls": ["https://x"],
        "record_schema": [{"name": "title", "required": True},
                          {"name": "body", "required": False}],
        "max_records": 12,
    })
    assert spec.start_urls == ["https://x"]
    assert spec.max_records == 12
    assert spec.required_fields() == ["title"]
