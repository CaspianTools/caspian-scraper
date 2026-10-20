"""findings_db.py — the committed findings database (db/companies.jsonl)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import findings_db as fdb  # noqa: E402


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(fdb, "DB_DIR", tmp_path / "db")
    return tmp_path / "db"


def test_company_id_is_the_site_domain():
    assert fdb.company_id("https://www.adnoc.ae/en/careers") == "adnoc.ae"
    assert fdb.company_id("https://careers.slb.com/") == "slb.com"
    assert fdb.company_id("http://jobs.acme.co.uk/x") == "acme.co.uk"
    assert fdb.company_id("acme.com") == "acme.com"
    assert fdb.company_id("https://careers.example") == "careers.example"  # nothing to strip


def test_upsert_only_ever_adds(tmp_db):
    fdb.upsert([{"id": "acme.com", "name": "Acme", "countries": ["Qatar"], "sources": ["wikidata"],
                 "found_by": ["oil"]}])
    fdb.upsert([{"id": "acme.com", "name": "", "website": "https://acme.com", "countries": ["Oman"],
                 "sources": ["google_maps"], "found_by": ["gas"]}])
    rec = fdb.load()["acme.com"]
    assert rec["name"] == "Acme"                         # not blanked
    assert rec["website"] == "https://acme.com"          # filled
    assert rec["countries"] == ["Qatar", "Oman"]         # unioned
    assert rec["sources"] == ["wikidata", "google_maps"]
    assert rec["found_by"] == ["gas", "oil"]             # newest first
    assert rec["first_seen"] <= rec["last_seen"]


def test_newer_careers_check_replaces_older():
    old = {"id": "a.com", "careers_url": "https://a.com/careers", "ats": "unknown",
           "reachable": False, "checked_at": "2026-01-01T00:00:00Z"}
    newer = {"id": "a.com", "careers_url": "https://jobs.a.com", "ats": "jibe",
             "reachable": True, "checked_at": "2026-02-01T00:00:00Z"}
    stale = {"id": "a.com", "ats": "successfactors", "checked_at": "2025-12-01T00:00:00Z"}
    rec = fdb.merge(fdb.merge(old, newer), stale)
    assert (rec["careers_url"], rec["ats"], rec["reachable"]) == ("https://jobs.a.com", "jibe", True)


def test_file_is_sorted_one_json_per_line(tmp_db):
    fdb.upsert([{"id": "b.com", "name": "B"}, {"id": "a.com", "name": "Ä"}])
    lines = (tmp_db / "companies.jsonl").read_text(encoding="utf-8").splitlines()
    assert [l.split('"id": "')[1].split('"')[0] for l in lines] == ["a.com", "b.com"]
    assert "Ä" in lines[0]  # stays readable in diffs


def test_a_broken_line_doesnt_sink_the_file(tmp_db):
    tmp_db.mkdir(parents=True)
    (tmp_db / "companies.jsonl").write_text('{"id": "a.com"}\n<<<<<<< HEAD\n{"id": "b.com"}\n',
                                            encoding="utf-8")
    assert sorted(fdb.load()) == ["a.com", "b.com"]


def test_hidden_is_a_decision_the_latest_value_wins():
    rec = fdb.merge({"id": "a.com", "hidden": True}, {"id": "a.com", "hidden": False})
    assert rec["hidden"] is False
    assert fdb.merge(rec, {"id": "a.com", "name": "A"})["hidden"] is False  # untouched by other saves


def test_saved_with_lf_line_endings_on_every_os(tmp_db):
    fdb.upsert([{"id": "a.com"}, {"id": "b.com"}])
    raw = (tmp_db / "companies.jsonl").read_bytes()
    assert b"\r\n" not in raw and raw.count(b"\n") == 2
