"""Generic jobs in scrape.py: a job runs its careers pages and every engine
source that belongs to it."""

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
    d.collection("projects").document("hse").set(
        {"name": "HSE", "enabled": True, "schedule_cron": cron, "resource_ids": ["r1"]})
    d.collection("projects").document("suvs").set(
        {"name": "SUVs", "template": "cars", "enabled": True, "schedule_cron": cron})
    d.collection("projects").document("old").set(
        {"name": "Paused", "kind": "cars", "enabled": False, "schedule_cron": cron})
    d.collection("projects").document("mixed").set(
        {"name": "Mixed", "enabled": True, "schedule_cron": cron, "resource_ids": ["r1"]})
    for sid, pid, active in [("c1", "suvs", True), ("c2", "suvs", True), ("c3", "suvs", False),
                             ("c4", "old", True), ("c5", None, True), ("c6", "mixed", True)]:
        d.collection("car_sources").document(sid).set(
            {"name": sid, "project_id": pid, "active": active, "schedule_cron": cron})
    return d


def test_templates_and_old_kinds():
    assert scrape.job_template(None) == "vacancies"
    assert scrape.job_template({"template": "prices"}) == "prices"
    assert scrape.job_template({"kind": "cars"}) == "cars"
    assert scrape.job_template({"kind": "data"}) == "blank"


def test_running_a_job_runs_its_careers_pages_and_engine_sources(db):
    assert scrape.job_work(db, "hse", "manual") == [("project", "hse", "manual")]
    assert sorted(scrape.job_work(db, "suvs", "manual")) == [
        ("car_source", "c1", "manual"), ("car_source", "c2", "manual")]  # c3 inactive, no careers
    assert sorted(scrape.job_work(db, "mixed", "manual")) == [
        ("car_source", "c6", "manual"), ("project", "mixed", "manual")]
    assert scrape.job_of_work(db, "car_source", "c6") == "mixed"
    assert scrape.job_of_work(db, "car_source", "c5") == ""


def test_schedule_skips_jobs_without_careers_and_paused_jobs_sources(db):
    work = scrape.find_due_work(db, datetime.now(timezone.utc))
    projects = sorted(i for k, i, _ in work if k == "project")
    assert projects == ["hse", "mixed"]
    cars = sorted(i for k, i, _ in work if k == "car_source")
    assert cars == ["c1", "c2", "c5", "c6"]  # c4 belongs to the paused job


def test_a_run_request_for_a_job_runs_all_its_parts(db):
    db.collection("run_requests").document("r1").set(
        {"project_id": "mixed", "status": "pending", "created_at": "2026-10-22T00:00:00Z"})
    work = scrape.find_due_work(db, datetime.now(timezone.utc))
    requested = sorted((k, i) for k, i, t in work if t == "request:r1")
    assert requested == [("car_source", "c6"), ("project", "mixed")]
    assert [i for k, i, t in work if k == "car_source"].count("c6") == 1  # not again on schedule
