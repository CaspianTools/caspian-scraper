"""job_results.py — one results store per job, across engines."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import findings_db as fdb  # noqa: E402
import job_results as jr  # noqa: E402
import localdb  # noqa: E402
import recordstore  # noqa: E402
import scrape  # noqa: E402


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(localdb, "CONFIG_ROOT", tmp_path / "data")
    monkeypatch.setattr(localdb, "LOCAL_ROOT", tmp_path / "local-data")
    monkeypatch.setattr(fdb, "DB_DIR", tmp_path / "db")
    d = localdb.LocalDB()
    d.collection("projects").document("j").set({"name": "J", "enabled": True})
    d.collection("car_sources").document("cs").set({"name": "OpenSooq", "project_id": "j", "active": True})
    d.collection("car_sources").document("other").set({"name": "Other", "project_id": "x", "active": True})
    return d


def vacancy(d, slug, title, seen):
    d.collection("projects").document("j").collection("findings").document(slug).set({
        "title": title, "employer": "Acme", "location": "Doha", "source_id": "s1",
        "source_name": "Acme careers", "source_url": f"https://acme.com/jobs/{slug}",
        "first_seen_at": "2026-10-01T00:00:00Z", "last_seen_at": seen})


def car(d, uid, price, seen, source="cs"):
    d.collection("car_listings").document(uid).set({
        "title": "Land Cruiser", "price_value": price, "currency": "OMR", "url": f"https://os.com/{uid}",
        "site": "opensooq", "source_id": source, "attributes": {"year": "2020"},
        "first_seen_at": "2026-10-01T00:00:00Z", "last_seen_at": seen})


def test_collect_marks_new_changed_unchanged_and_gone(db):
    vacancy(db, "hse-1", "HSE Officer", "2026-10-10T00:00:00Z")
    car(db, "os:1", 9000, "2026-10-10T00:00:00Z")
    car(db, "os:9", 1, "2026-10-10T00:00:00Z", source="other")  # another job's
    assert jr.collect(db, "j", ran_sources={"s1", "cs"}, run_started="2026-10-10T00:00:00Z") == \
        {"new": 2, "changed": 0, "unchanged": 0, "gone": 0}
    recs = recordstore.load("job:j")
    assert recs["v:hse-1"]["company"] == "Acme" and recs["c:os:1"]["year"] == "2020"
    assert recs["c:os:1"]["engine"] == "classifieds" and "c:os:9" not in recs

    # People tag a record; the next run sees the car's price drop and no vacancy.
    recordstore.write("job:j", {"c:os:1": {**recs["c:os:1"], "tags": ["Deal"]}})
    car(db, "os:1", 8500, "2026-10-11T00:00:00Z")
    counts = jr.collect(db, "j", ran_sources={"s1", "cs"}, run_started="2026-10-11T00:00:00Z")
    recs = recordstore.load("job:j")
    assert counts == {"new": 0, "changed": 1, "unchanged": 0, "gone": 1}
    assert recs["c:os:1"]["status"] == "changed" and recs["c:os:1"]["tags"] == ["Deal"]
    assert recs["v:hse-1"]["status"] == "gone"

    # The vacancy comes back; the car is unchanged.
    vacancy(db, "hse-1", "HSE Officer", "2026-10-12T00:00:00Z")
    car(db, "os:1", 8500, "2026-10-12T00:00:00Z")
    jr.collect(db, "j", ran_sources={"s1", "cs"}, run_started="2026-10-12T00:00:00Z")
    recs = recordstore.load("job:j")
    assert (recs["v:hse-1"]["status"], recs["c:os:1"]["status"]) == ("new", "unchanged")

    # A refresh (no run) changes nothing: "new" stays new.
    jr.collect(db, "j")
    recs = recordstore.load("job:j")
    assert (recs["v:hse-1"]["status"], recs["c:os:1"]["status"]) == ("new", "unchanged")


def test_save_to_databases_filters_and_merges(db):
    car(db, "os:1", 9000, "2026-10-10T00:00:00Z")
    car(db, "os:2", 7000, "2026-10-10T00:00:00Z")
    jr.collect(db, "j", ran_sources={"cs"}, run_started="2026-10-10T00:00:00Z")
    recs = recordstore.load("job:j")
    recordstore.write("job:j", {"c:os:1": {**recs["c:os:1"], "tags": ["Deal"]}})
    project = {"saves_to": [{"database": "deals", "only_tags": ["deal"]}, {"database": "missing"}]}
    assert jr.save_to_databases(project, "j", {"deals": "url"}) == {"deals": 1}
    saved = fdb.load("deals.jsonl")
    assert list(saved) == ["https://os.com/os:1"]
    assert saved["https://os.com/os:1"]["jobs"] == ["j"] and saved["https://os.com/os:1"]["price"] == 9000
    # A later price change updates the saved copy; people's tags there stay.
    fdb.retag(["https://os.com/os:1"], add=["Called"], name="deals.jsonl")
    car(db, "os:1", 8000, "2026-10-11T00:00:00Z")
    jr.collect(db, "j", ran_sources={"cs"}, run_started="2026-10-11T00:00:00Z")
    jr.save_to_databases(project, "j", {"deals": "url"})
    saved = fdb.load("deals.jsonl")["https://os.com/os:1"]
    assert saved["price"] == 8000 and set(saved["tags"]) == {"Called", "Deal"}


def test_a_job_reads_careers_pages_from_a_database(db):
    fdb.upsert([
        {"id": "acme.com", "name": "Acme", "careers_url": "https://jobs.acme.com", "ats": "successfactors",
         "tags": ["Gulf"]},
        {"id": "beta.com", "name": "Beta", "careers_url": "https://beta.com/careers", "ats": "unknown",
         "tags": ["Gulf"]},
        {"id": "gamma.com", "name": "Gamma", "careers_url": "https://gamma.com/jobs", "ats": "jibe"},
    ])
    project = {"reads_from": [{"database": "companies", "only_tags": ["gulf"]}]}
    srcs = scrape.database_sources(db, project)
    assert [(s["name"], s["ats"], s["__virtual"]) for s in srcs] == [("Acme", "successfactors", True)]
    db.collection("projects").document("j").set({"name": "J", "reads_from": project["reads_from"]})
    assert scrape.job_has_careers(db, "j")
    assert [s["name"] for s in scrape.load_sources(db, "j")] == ["Acme"]
