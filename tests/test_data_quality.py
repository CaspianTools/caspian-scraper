"""scripts/clean_companies.py — the "Data quality" migration — and the branch
details find_websites passes on."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import find_websites as fw  # noqa: E402
import findings_db as fdb  # noqa: E402

_spec = importlib.util.spec_from_file_location("clean_companies", REPO_ROOT / "scripts" / "clean_companies.py")
clean_companies = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(clean_companies)

MESSY = [
    {"id": "cleverest.az", "name": "CLEVEREST ACADEMY | Xaricdə Təhsil | YÖS Kursları",
     "website": "https://www.cleverest.az/az/kurslar", "countries": ["Azerbaijan"], "types": ["university"]},
    {"id": "aesma.az", "name": "Azerbaijan Academy of Labour and Social Affairs", "website": "http://www.aesma.az/",
     "countries": ["Azerbaijan"], "types": ["University"], "tags": ["University"]},
    {"id": "aesma.edu.az", "name": "Azerbaijan Academy of Labour and Social Affairs", "website": "https://aesma.edu.az/",
     "countries": ["Azerbaijan"], "types": ["university", "Educational institution"], "hidden": True},
    {"id": "stsoman.com", "name": "STS TRAINING CENTER", "website": "HTTP://STSOMAN.COM", "countries": ["Oman"],
     "types": ["educational institution", "Educational institution"]},
    {"id": "plain.com", "name": "Plain", "website": "https://plain.com/"},
]


@pytest.fixture
def messy_db(tmp_path, monkeypatch):
    db = tmp_path / "db"
    monkeypatch.setattr(fdb, "DB_DIR", db)
    db.mkdir()
    (db / "companies.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in MESSY),
                                        encoding="utf-8")
    return db


def test_dry_run_writes_nothing(messy_db):
    before = (messy_db / "companies.jsonl").read_bytes()
    s = clean_companies.run(dry_run=True)
    assert (messy_db / "companies.jsonl").read_bytes() == before
    assert s["pairs"] == [("aesma.az", "aesma.edu.az")] and s["after"] == 4
    assert {rid for rid, _, _ in s["names"]} == {"cleverest.az", "stsoman.com"}


def test_migration_cleans_merges_and_is_idempotent(messy_db):
    s = clean_companies.run()
    assert len(s["names"]) == 2 and s["websites_path"] == 1 and s["pairs"] == [("aesma.az", "aesma.edu.az")]
    recs = fdb.load()
    assert sorted(recs) == ["aesma.az", "cleverest.az", "plain.com", "stsoman.com"]
    assert recs["cleverest.az"]["name"] == "Cleverest Academy"
    assert recs["cleverest.az"]["website"] == "https://www.cleverest.az/"
    assert recs["cleverest.az"]["website_raw"] == "https://www.cleverest.az/az/kurslar"
    assert recs["cleverest.az"]["types"] == ["University"]
    assert recs["stsoman.com"]["types"] == ["Educational institution"]
    assert recs["stsoman.com"]["website"] == "http://stsoman.com/"
    assert recs["aesma.az"]["aliases"] == ["aesma.edu.az"] and recs["aesma.az"]["hidden"] is False
    assert recs["aesma.az"]["branches"] == [{"country": "Azerbaijan", "website": "https://aesma.edu.az/"}]
    assert recs["aesma.az"]["types"] == ["University", "Educational institution"]
    assert "branches" not in recs["plain.com"]                  # no country, no branch

    file_after = (messy_db / "companies.jsonl").read_bytes()
    again = clean_companies.run()
    assert again["changed"] == 0 and again["pairs"] == [] and again["names"] == []
    assert (messy_db / "companies.jsonl").read_bytes() == file_after   # the second run changes nothing


def test_main_prints_a_summary(messy_db, capsys):
    assert clean_companies.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "DRY RUN" in out and "duplicates merged:     1" in out and "aesma.edu.az → aesma.az" in out


def test_maps_card_address_goes_into_the_branch():
    lines = ["4.6(120)", "Training centre ·  · Al Quoz Industrial Area 3", "Open · Closes 6 pm"]
    assert fw._maps_address(lines, "Acme") == "Al Quoz Industrial Area 3"
    assert fw._maps_address(["4.6(120) · Training centre · Al Quoz"]) == "Al Quoz"
    assert fw._maps_address(["4.8(52) · Training centre", "Open 24 hours"]) == ""
    assert fw._maps_address(["Open · Closes 6 pm"]) == ""
    rec = fdb.merge(None, {"id": "acme.ae", "name": "Acme", "countries": ["United Arab Emirates"],
                           "address": "Al Quoz", "sources": ["google_maps"]})
    assert rec["branches"] == [{"country": "United Arab Emirates", "address": "Al Quoz", "source": "google_maps"}]


def test_hide_wikidata_only_tags_and_hides_but_keeps_them(tmp_path, monkeypatch):
    monkeypatch.setattr(fdb, "DB_DIR", tmp_path / "db")
    clean = clean_companies
    fdb.upsert([{"id": "uni.example", "name": "Uni", "sources": ["wikidata"]},
                {"id": "acme.example", "name": "Acme", "sources": ["wikidata", "google_maps"]}])
    s = clean.run(hide_wikidata_only=True)
    recs = fdb.load()
    assert s["wikidata_hidden"] == 1
    assert recs["uni.example"]["hidden"] is True and "Wikidata only" in recs["uni.example"]["tags"]
    assert not recs["acme.example"].get("hidden")
    assert clean.run(hide_wikidata_only=True)["wikidata_hidden"] == 0  # idempotent
