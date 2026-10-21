"""No-AI config builder tests (aiconfig.heuristic) with fake inspector/preview.

No network, no browser: canned PageEvidence stands in for the inspector and a
fake run_preview decides which link group "works".
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig.config_schema import validate_extraction  # noqa: E402
from aiconfig.evidence import FieldCandidate, PageEvidence, RepeatedBlock  # noqa: E402
from aiconfig.heuristic import (  # noqa: E402
    _semantic,
    build_fields,
    propose_without_ai,
    rank_blocks,
)

LISTING = "https://example.com/tenders"


def _listing(**kw) -> PageEvidence:
    ev = PageEvidence(url=LISTING, final_url=LISTING, http_status=200)
    ev.repeated_blocks = [
        RepeatedBlock("a[href*='/tag/']", "/tag/", 30,
                      [f"https://example.com/tag/t{i}/" for i in range(3)]),
        RepeatedBlock("a[href*='/tenders/']", "/tenders/", 12,
                      [f"https://example.com/tenders/{100 + i}" for i in range(3)]),
    ]
    ev.next_page_candidates = ["a[rel='next']"]
    for k, v in kw.items():
        setattr(ev, k, v)
    return ev


def _detail() -> PageEvidence:
    ev = PageEvidence(url="https://example.com/tenders/100")
    ev.field_candidates = {
        "title": [FieldCandidate("h1", 1, "Road works tender", "css")],
        "date": [FieldCandidate("time@datetime", 1, "2026-11-01", "css")],
        "price": [FieldCandidate(".amount", 1, "$40,000", "css")],
        "description": [
            FieldCandidate(".content", 9, "lots of text", "css"),
            FieldCandidate("article .content", 1, "The scope of work", "css"),
        ],
        "image": [FieldCandidate("img@src", 40, "/logo.png", "css")],
    }
    return ev


def _impl(listing: PageEvidence, good_href: str = "/tenders/"):
    calls = {"previews": [], "fetches": []}

    def fetch_page(url, kind):
        calls["fetches"].append((url, kind))
        return listing if kind == "listing" else _detail()

    def run_preview(extraction, start_url, detail_url="", **kw):
        calls["previews"].append(extraction)
        if extraction["link_discovery"]["href_includes"] == good_href:
            return ([{"title": f"T{i}"} for i in range(5)], {"links_discovered": 12})
        return ([], {"links_discovered": 0})

    return {"fetch_page": fetch_page, "run_preview": run_preview}, calls


def test_semantic_whole_words():
    assert _semantic("closing_date") == "date"
    assert _semantic("award_amount") == "price"
    assert _semantic("job_title") == "title"
    assert _semantic("body") == "description"  # not "by" → author
    assert _semantic("reference_no") is None


def test_rank_prefers_item_links_over_navigation():
    ranked = rank_blocks(_listing())
    assert ranked[0].href_includes == "/tenders/"


def test_rank_prefers_group_with_sample_detail_url():
    ranked = rank_blocks(_listing(), detail_url="https://example.com/tag/t1/")
    assert ranked[0].href_includes == "/tag/"


def test_build_fields_defaults_and_specificity():
    fields, required = build_fields(_detail())
    assert required == "title"
    assert fields["title"] == "h1"
    assert fields["date"] == "time@datetime"
    # One match beats nine.
    assert fields["description"] == "article .content"
    # Not requested and not a default field.
    assert "price" not in fields and "image" not in fields


def test_build_fields_follows_schema_hint_names():
    fields, required = build_fields(_detail(), "name:string*,deadline:string,value:number")
    assert required == "name"
    assert fields["name"] == "h1"
    assert fields["deadline"] == "time@datetime"
    assert fields["value"] == ".amount"


def test_propose_picks_working_group():
    impl, calls = _impl(_listing())
    r = propose_without_ai("tenders", LISTING, impl=impl)
    assert not r.incomplete, r.error
    assert r.path == "config"
    assert r.extraction["link_discovery"]["href_includes"] == "/tenders/"
    assert r.extraction["link_discovery"]["next_page_selector"] == "a[rel='next']"
    assert validate_extraction(r.extraction) == []
    assert len(r.sample_records) == 5
    assert "title" in r.output_schema
    assert r.cost_usd == 0
    # Stopped after the first full preview.
    assert len(calls["previews"]) == 1


def test_propose_fails_clearly_without_links():
    impl, _ = _impl(_listing(repeated_blocks=[]))
    r = propose_without_ai("tenders", LISTING, impl=impl)
    assert r.incomplete and r.extraction is None
    assert "Use AI" in r.error


def test_propose_fails_on_blocked_page():
    impl, calls = _impl(_listing(http_status=403))
    r = propose_without_ai("tenders", LISTING, impl=impl)
    assert r.incomplete and "403" in r.error
    assert calls["previews"] == []


def test_propose_fails_when_no_group_yields_records():
    impl, _ = _impl(_listing(), good_href="/nothing/")
    r = propose_without_ai("tenders", LISTING, impl=impl)
    assert r.incomplete and r.extraction is None
