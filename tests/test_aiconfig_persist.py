"""aiconfig.persist + the config-job finish step: a proposed generic source
carries the config job's `project_id` (the "Website data" job it joins).

No network, no Firestore: a fake doc ref records the update.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig import cli, persist  # noqa: E402
from aiconfig.agent import AgentResult  # noqa: E402

EXTRACTION = {
    "extractors": [
        {"type": "fields", "fields": {"title": "h1"}, "required_fields": ["title"]}
    ]
}


class _FakeRef:
    def __init__(self) -> None:
        self.updates: dict = {}

    def update(self, data: dict) -> None:
        self.updates.update(data)


def test_build_doc_includes_project_id_when_given():
    doc = persist.build_generic_source_doc(
        name="Tenders",
        owner_uid="u1",
        start_urls=["https://example.com/tenders"],
        extraction=EXTRACTION,
        project_id="job-1",
    )
    assert doc["project_id"] == "job-1"
    assert doc["active"] is True


def test_build_doc_omits_project_id_by_default():
    doc = persist.build_generic_source_doc(
        name="Tenders",
        owner_uid="u1",
        start_urls=["https://example.com/tenders"],
        extraction=EXTRACTION,
    )
    assert "project_id" not in doc


def test_finish_job_carries_the_config_jobs_project_id():
    ref = _FakeRef()
    result = AgentResult(path="config", extraction=EXTRACTION, output_schema=["title"])
    rc = cli._finish_job(
        ref,
        {"owner_uid": "u1", "project_id": "job-1"},
        "cj1",
        result,
        url="https://example.com/tenders",
        intent="Tender notices",
        hint="",
        append_turn=lambda role, text: None,
    )
    assert rc == 0
    assert ref.updates["status"] == "proposed"
    proposed = ref.updates["proposed_config"]
    assert proposed["project_id"] == "job-1"
    assert proposed["origin"] == {"via": "wizard", "config_job_id": "cj1"}
