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
    assert rec["website"] == "https://acme.com/"         # filled, as the site root
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


def test_retag_adds_and_removes_case_insensitively(tmp_db):
    fdb.upsert([{"id": "a.com", "name": "A"}, {"id": "b.com", "name": "B"}])
    out = fdb.retag(["a.com", "b.com", "nope.com"], add=["  Priority ", "called  back"])
    assert out == {"a.com": ["called back", "Priority"], "b.com": ["called back", "Priority"]}
    # Same tag, other case: reuses the existing spelling instead of a second tag.
    assert fdb.retag(["a.com"], add=["PRIORITY", "Gulf"])["a.com"] == ["called back", "Gulf", "Priority"]
    assert fdb.retag(["a.com"], remove=["priority", "CALLED BACK"])["a.com"] == ["Gulf"]
    assert fdb.retag(["b.com"], remove=["Priority", "called back"])["b.com"] == []
    recs = fdb.load()
    assert recs["a.com"]["tags"] == ["Gulf"] and "tags" not in recs["b.com"]  # no empty lists saved
    assert "nope.com" not in recs


def test_tags_survive_later_searches(tmp_db):
    fdb.upsert([{"id": "a.com", "name": "A"}])
    fdb.retag(["a.com"], add=["priority"])
    fdb.upsert([{"id": "a.com", "name": "A", "sources": ["osm"]}])  # a search finds it again
    assert fdb.load()["a.com"]["tags"] == ["priority"]


# ---- normalised on the way in ---------------------------------------------------------

def test_upsert_cleans_names_and_keeps_the_original(tmp_db):
    fdb.upsert([{"id": "cleverest.az", "name": "CLEVEREST ACADEMY | Xaricə Təhsil | YÖS Kursları"}])
    rec = fdb.load()["cleverest.az"]
    assert rec["name"] == "Cleverest Academy"
    assert rec["name_raw"] == "CLEVEREST ACADEMY | Xaricə Təhsil | YÖS Kursları"
    # A clean name has no name_raw; a later name never replaces the first one.
    fdb.upsert([{"id": "acme.com", "name": "Acme"}, {"id": "cleverest.az", "name": "OTHER NAME | x"}])
    recs = fdb.load()
    assert "name_raw" not in recs["acme.com"]
    assert recs["cleverest.az"]["name"] == "Cleverest Academy"
    assert recs["cleverest.az"]["name_raw"].startswith("CLEVEREST")


def test_upsert_roots_websites_and_keeps_a_path(tmp_db):
    fdb.upsert([{"id": "51campus.org", "website": "https://51campus.org/rent-a-room/"},
                {"id": "b.com", "website": "HTTP://B.com"}])
    recs = fdb.load()
    assert recs["51campus.org"]["website"] == "https://51campus.org/"
    assert recs["51campus.org"]["website_raw"] == "https://51campus.org/rent-a-room/"
    assert recs["b.com"]["website"] == "http://b.com/" and "website_raw" not in recs["b.com"]
    # The same site found as https upgrades it; another site never replaces it.
    fdb.upsert([{"id": "b.com", "website": "https://b.com/en"}, {"id": "51campus.org", "website": "https://x.org"}])
    recs = fdb.load()
    assert recs["b.com"]["website"] == "https://b.com/"
    assert recs["51campus.org"]["website"] == "https://51campus.org/"


def test_upsert_gives_categories_one_spelling(tmp_db):
    fdb.upsert([{"id": "a.com", "types": ["university", "University", "College"]},
                {"id": "b.com", "types": ["IT company"]}])
    fdb.upsert([{"id": "a.com", "types": ["college", "Training centre"], "industries": ["education "]},
                {"id": "c.com", "types": ["it company"]}])
    recs = fdb.load()
    assert recs["a.com"]["types"] == ["University", "College", "Training center"]
    assert recs["a.com"]["industries"] == ["Education"]
    assert recs["c.com"]["types"] == ["IT company"]          # the spelling already in the database


def test_a_company_found_in_another_country_gets_a_branch(tmp_db):
    fdb.upsert([{"id": "acme.com", "name": "Acme", "website": "https://acme.com/", "countries": ["Qatar"],
                 "sources": ["wikidata"]}])
    fdb.upsert([{"id": "acme.com", "name": "Acme", "website": "https://acme.com/", "countries": ["Oman"],
                 "address": "Al Khuwair, Muscat", "sources": ["google_maps"]}])
    fdb.upsert([{"id": "acme.com", "countries": ["Qatar"], "city": "Doha", "sources": ["osm"]}])
    rec = fdb.load()["acme.com"]
    assert rec["countries"] == ["Qatar", "Oman"]              # still there for the filters
    assert rec["branches"] == [
        {"country": "Qatar", "city": "Doha", "source": "wikidata"},
        {"country": "Oman", "address": "Al Khuwair, Muscat", "source": "google_maps"},
    ]
    assert "address" not in rec and "city" not in rec          # only inside branches
    fdb.upsert([{"id": "acme.com", "countries": ["Qatar"], "city": "Al Khor", "sources": ["osm"]}])
    assert [b.get("city") for b in fdb.load()["acme.com"]["branches"]] == ["Doha", None, "Al Khor"]


def test_merge_is_unchanged_by_merging_a_record_into_itself():
    rec = fdb.merge(None, {"id": "a.com", "name": "A", "website": "https://a.com/x", "countries": ["Qatar", "Oman"],
                           "types": ["school"], "address": "Doha"})
    assert fdb.merge(rec, rec) == rec
    assert rec["branches"] == [{"country": "Qatar"}, {"country": "Oman"}]  # address only with one country


# ---- duplicates ------------------------------------------------------------------------

def _two_global_knowledges():
    fdb.upsert([
        {"id": "globalknowledge.com", "name": "Global Knowledge", "website": "http://www.globalknowledge.com/",
         "countries": ["United States"], "types": ["Training center"], "sources": ["wikidata"],
         "first_seen": "2026-02-01T00:00:00Z"},
        {"id": "globalknowledge.com.eg", "name": "GLOBAL KNOWLEDGE", "website": "https://www.globalknowledge.com.eg/ar",
         "countries": ["Egypt"], "types": ["training center", "Corporate office"], "sources": ["google_maps"],
         "careers_url": "https://www.globalknowledge.com.eg/careers", "first_seen": "2026-01-01T00:00:00Z"},
        {"id": "other.com", "name": "Other", "countries": ["Egypt"]},
    ])
    fdb.retag(["globalknowledge.com"], add=["Priority"])
    fdb.retag(["globalknowledge.com.eg"], add=["priority", "Called"])


def test_merge_duplicates_keeps_the_generic_domain_with_branches(tmp_db):
    _two_global_knowledges()
    assert fdb.merge_duplicates() == [("globalknowledge.com", "globalknowledge.com.eg")]
    recs = fdb.load()
    assert sorted(recs) == ["globalknowledge.com", "other.com"]
    rec = recs["globalknowledge.com"]
    assert rec["aliases"] == ["globalknowledge.com.eg"]
    assert rec["website"] == "http://www.globalknowledge.com/"
    assert rec["countries"] == ["United States", "Egypt"]
    assert rec["branches"] == [
        {"country": "United States", "source": "wikidata"},
        {"country": "Egypt", "website": "https://www.globalknowledge.com.eg/", "source": "google_maps"},
    ]
    assert rec["types"] == ["Training center", "Corporate office"]
    assert sorted(rec["tags"]) == ["Called", "Priority"]       # unioned, one "priority"
    assert rec["careers_url"] == "https://www.globalknowledge.com.eg/careers"
    assert rec["first_seen"] == "2026-01-01T00:00:00Z"
    assert "hidden" not in rec
    assert fdb.merge_duplicates() == []                        # nothing left to merge


def test_merged_hidden_only_if_both_were_hidden(tmp_db):
    fdb.upsert([{"id": "aesma.az", "name": "Azerbaijan Academy of Labour", "hidden": True},
                {"id": "aesma.edu.az", "name": "Azerbaijan Academy of Labour"},
                {"id": "xcel.az", "name": "Xcellent Academy", "hidden": True},
                {"id": "xcel.edu.az", "name": "Xcellent Academy", "hidden": True}])
    assert fdb.merge_duplicates() == [("aesma.az", "aesma.edu.az"), ("xcel.az", "xcel.edu.az")]
    recs = fdb.load()
    assert recs["aesma.az"]["hidden"] is False and recs["xcel.az"]["hidden"] is True


def test_a_later_find_of_a_merged_domain_lands_on_the_kept_record(tmp_db):
    _two_global_knowledges()
    fdb.merge_duplicates()
    saved = fdb.upsert([{"id": "globalknowledge.com.eg", "name": "Global Knowledge Egypt",
                         "website": "https://globalknowledge.com.eg/", "countries": ["Saudi Arabia"],
                         "sources": ["osm"], "found_by": ["it training"]}])
    assert saved["globalknowledge.com.eg"]["id"] == "globalknowledge.com"   # returned under the id asked for
    recs = fdb.load()
    assert sorted(recs) == ["globalknowledge.com", "other.com"]             # the duplicate didn't come back
    rec = recs["globalknowledge.com"]
    assert rec["name"] == "Global Knowledge" and "it training" in rec["found_by"]
    assert rec["branches"][-1] == {"country": "Saudi Arabia", "website": "https://globalknowledge.com.eg/",
                                   "source": "osm"}


def test_a_duplicate_that_comes_back_through_git_is_merged_again(tmp_db):
    _two_global_knowledges()
    fdb.merge_duplicates()
    # Another computer (without the merge) still writes the old record.
    fdb.put({"globalknowledge.com.eg": {"id": "globalknowledge.com.eg", "name": "Global Knowledge Egypt",
                                        "countries": ["Egypt"]}})
    assert fdb.merge_duplicates() == [("globalknowledge.com", "globalknowledge.com.eg")]
    assert "globalknowledge.com.eg" not in fdb.load()
