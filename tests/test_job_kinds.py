"""Job types in scrape.py: a car / prices / data job runs its own sources."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import localdb  # noqa: E402
import scrape  # noqa: E402


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(localdb, "CONFIG_ROOT", tmp_path / "data")
    monkeypatch.setattr(localdb, "LOCAL_ROOT", tmp_path / "local-data")
    d = localdb.LocalDB()
    cron = "0 */6 * * *"
    d.collection("projects").document("hse").set({"name": "HSE", "enabled": True, "schedule_cron": cron})
    d.collection("projects").document("suvs").set(
        {"name": "SUVs", "kind": "cars", "enabled": True, "schedule_cron": cron})
    d.collection("projects").document("old").set(
        {"name": "Paused", "kind": "cars", "enabled": False, "schedule_cron": cron})
    for sid, pid, active in [("c1", "suvs", True), ("c2", "suvs", True), ("c3", "suvs", False),
                             ("c4", "old", True), ("c5", None, True)]:
        d.collection("car_sources").document(sid).set(
            {"name": sid, "project_id": pid, "active": active, "schedule_cron": cron})
    return d


def test_job_kind_defaults_to_vacancies():
    assert scrape.job_kind(None) == "vacancies"
    assert scrape.job_kind({"kind": "cars"}) == "cars"
    assert scrape.job_kind({"kind": "nonsense"}) == "vacancies"


def test_running_a_job_runs_what_its_type_means(db):
    assert scrape.job_work(db, "hse", "manual") == [("project", "hse", "manual")]
    assert sorted(scrape.job_work(db, "suvs", "manual")) == [
        ("car_source", "c1", "manual"), ("car_source", "c2", "manual")]  # c3 inactive


def test_schedule_skips_non_vacancy_jobs_and_paused_jobs_sources(db):
    work = scrape.find_due_work(db, datetime.now(timezone.utc))
    assert ("project", "hse", "schedule") in work
    assert not any(k == "project" and i in ("suvs", "old") for k, i, _ in work)
    cars = sorted(i for k, i, _ in work if k == "car_source")
    assert cars == ["c1", "c2", "c5"]  # c4 belongs to the paused job


def test_a_run_request_for_a_car_job_runs_its_sources(db):
    db.collection("run_requests").document("r1").set(
        {"project_id": "suvs", "status": "pending", "created_at": "2026-10-22T00:00:00Z"})
    work = scrape.find_due_work(db, datetime.now(timezone.utc))
    requested = [(k, i) for k, i, t in work if t == "request:r1"]
    assert sorted(requested) == [("car_source", "c1"), ("car_source", "c2")]
    assert [i for k, i, t in work if k == "car_source"].count("c1") == 1  # not again on schedule
