"""relevance.py — keyword relevance + AI for borderline records (fake model)."""

from __future__ import annotations

import io
import json
import sys
import threading
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import ai_tag  # noqa: E402
import findings_db as fdb  # noqa: E402
import localdb  # noqa: E402
import recordstore  # noqa: E402
import relevance as rel  # noqa: E402
import scrape  # noqa: E402
from aiconfig.providers import LLMResponse, ProviderError, ToolCall  # noqa: E402

RULES = {"include": ["HSE", "ISO 45001", "safety training"], "exclude": ["driving school", "gym"]}


class FakeModel:
    """Answers each call with answer(user) as the tool input."""

    def __init__(self, answer, cost=0.01):
        self.answer, self.cost = answer, cost
        self.calls: list[tuple[str, str, dict]] = []
        self._lock = threading.Lock()

    def complete(self, *, system, tools, history, max_tokens=None):
        user = history[-1]["text"]
        with self._lock:
            self.calls.append((system, user, tools[0]))
        return LLMResponse(tool_calls=[ToolCall("1", tools[0]["name"], self.answer(user))],
                           cost_usd=self.cost)


def recs_in(user: str) -> list[dict]:
    return [json.loads(line) for line in user.splitlines()[1:]]


def put(*recs: dict, job: str = "j") -> None:
    recordstore.write(f"job:{job}", {r["id"]: r for r in recs})


# ---- score ------------------------------------------------------------------------

def test_no_rules_means_unscored():
    assert rel.score({"title": "anything"}, {}) is None
    assert rel.score({"title": "anything"}, {"include": ["  "], "exclude": []}) is None
    assert rel.score({"title": "anything"}, None) is None


def test_whole_words_and_phrases_not_substrings():
    assert rel.score({"title": "Thsession planner"}, {"include": ["HSE"]})[0] == rel.NEUTRAL
    assert rel.score({"title": "HSE-certified trainer"}, {"include": ["hse"]})[0] > 60
    assert rel.score({"description": "Certified to ISO 45001:2018"}, {"include": ["ISO 45001"]})[0] == 70
    assert rel.score({"description": "ISO 9001 and 45001"}, {"include": ["ISO 45001"]})[0] == rel.NEUTRAL


def test_unicode_fold_plurals_and_prefix():
    assert rel.score({"title": "ＨＳＥ Academy"}, {"include": ["hse"]})[0] > 60       # full-width
    assert rel.score({"title": "Straße Bau"}, {"include": ["strasse"]})[0] > 60        # ß → ss
    assert rel.score({"types": ["Driving Schools"]}, {"exclude": ["driving school"]})[0] == 10
    assert rel.score({"title": "Safety Academies"}, {"include": ["academy"]})[0] > 60
    assert rel.score({"title": "Training centre"}, {"include": ["train*"]})[0] > 60


def test_exclude_wins_strongly():
    s, why = rel.score({"title": "HSE Driving School", "description": "ISO 45001 safety training"}, RULES)
    assert s == 0 and "driving school" in why
    s, why = rel.score({"title": "HSE Centre", "types": ["Gym"]}, RULES)
    assert s == 10 and "gym" in why


def test_include_hits_raise_the_score_and_title_weighs_more():
    one = rel.score({"name": "Acme", "description": "We run HSE courses"}, RULES)[0]
    title = rel.score({"name": "Acme HSE"}, RULES)[0]
    two = rel.score({"name": "Acme", "description": "HSE and ISO 45001 courses"}, RULES)[0]
    three = rel.score({"title": "HSE", "description": "ISO 45001, safety training"}, RULES)[0]
    assert one == 70 and title == 85 and two == 85 and three > 85 and three <= 100


def test_neutral_is_borderline_and_exclude_only_rules():
    s, why = rel.score({"title": "Cooking classes"}, RULES)
    assert s == 40 and "borderline" in why
    assert rel.score({"title": "Cooking classes"}, {"exclude": ["gym"]})[0] == 70
    assert rel.score({"title": "City Gym"}, {"exclude": ["gym"]})[0] == 0


def test_any_text_field_counts_but_links_dont():
    assert rel.score({"title": "X", "tags": ["HSE"]}, RULES)[0] == 70
    assert rel.score({"title": "X", "notes": "an HSE firm"}, RULES)[0] == 70
    assert rel.score({"title": "X", "url": "https://hse.example/"}, RULES)[0] == rel.NEUTRAL


# ---- score_job ----------------------------------------------------------------------

def test_score_job_without_rules_touches_nothing():
    put({"id": "a", "title": "HSE"})
    before = recordstore.load("job:j")
    assert rel.score_job("j", {"relevance": {"include": [], "exclude": [], "cutoff": 50}}) == 0
    assert rel.score_job("j", {}) == 0
    assert recordstore.load("job:j") == before


def test_score_job_writes_scores_and_only_changed_records(monkeypatch):
    put({"id": "a", "title": "HSE Officer"}, {"id": "b", "title": "Gym coach"}, {"id": "c", "title": "Chef"})
    proj = {"relevance": RULES}
    assert rel.score_job("j", proj) == 3
    recs = recordstore.load("job:j")
    assert recs["a"]["relevance"] == 85 and recs["b"]["relevance"] == 0 and recs["c"]["relevance"] == 40
    assert recs["a"]["relevance_why"].startswith("matches")

    writes = []
    real = recordstore.write
    monkeypatch.setattr(recordstore, "write", lambda store, up=None, *a, **k: (writes.append(up), real(store, up, *a, **k)))
    assert rel.score_job("j", proj) == 3
    assert writes == []                                          # nothing changed → no write


def test_ai_scores_only_borderline_records_and_caches_answers():
    put({"id": "a", "title": "HSE Officer"}, {"id": "b", "title": "Gym coach"},
        {"id": "c", "title": "Chef"}, {"id": "d", "title": "Site supervisor"})
    model = FakeModel(lambda u: {"results": [
        {"id": r["id"], "score": 80 if r["title"] == "Site supervisor" else 5, "reason": "judged"}
        for r in recs_in(u)]})
    proj = {"name": "HSE", "description": "HSE vacancies", "use_ai": True,
            "relevance": {**RULES, "use_ai": True}}
    out = rel.rescore("j", proj, provider=model)
    assert len(model.calls) == 1
    asked = sorted(r["id"] for r in recs_in(model.calls[0][1]))
    assert asked == ["c", "d"]                                   # only the 40s
    assert "HSE vacancies" in model.calls[0][0] and "driving school" in model.calls[0][0]
    recs = recordstore.load("job:j")
    assert recs["d"]["relevance"] == 80 and recs["d"]["relevance_why"] == "AI: judged"
    assert recs["c"]["relevance"] == 5 and recs["a"]["relevance"] == 85
    assert out["ai_checked"] == 2 and out["cost_usd"] == 0.01 and out["errors"] == []

    # Next run: same records + rules → answered from the cache, no spend.
    out = rel.rescore("j", proj, provider=model)
    assert len(model.calls) == 1 and out["ai_checked"] == 0
    assert recordstore.load("job:j")["d"]["relevance"] == 80

    # The rules change → asked again.
    rel.rescore("j", {**proj, "relevance": {**proj["relevance"], "exclude": ["gym", "cook"]}}, provider=model)
    assert len(model.calls) == 2


def test_ai_needs_both_switches():
    put({"id": "c", "title": "Chef"})
    model = FakeModel(lambda u: {"results": []})
    rel.score_job("j", {"use_ai": False, "relevance": {**RULES, "use_ai": True}}, provider=model)
    rel.score_job("j", {"use_ai": True, "relevance": {**RULES, "use_ai": False}}, provider=model)
    assert model.calls == []


def test_ai_stops_at_the_spend_cap(monkeypatch):
    monkeypatch.setattr(rel, "BATCH", 2)
    put(*({"id": f"r{i}", "title": f"Thing {i}"} for i in range(10)))
    model = FakeModel(lambda u: {"results": [{"id": r["id"], "score": 90} for r in recs_in(u)]}, cost=0.02)
    proj = {"use_ai": True, "ai_spend_cap": 0.05, "relevance": {**RULES, "use_ai": True}}
    out = rel.rescore("j", proj, provider=model)
    # 0.02 + 0.02 = 0.04; a third batch would pass 0.05 by the average → stop.
    assert len(model.calls) == 2 and out["ai_checked"] == 4 and out["cost_usd"] == 0.04
    assert any("spend cap" in e for e in out["errors"])
    recs = recordstore.load("job:j")
    assert sum(r["relevance"] == 90 for r in recs.values()) == 4
    assert sum(r["relevance"] == 40 for r in recs.values()) == 6   # kept their keyword score

    # No cap: everything is asked.
    model2 = FakeModel(lambda u: {"results": [{"id": r["id"], "score": 90} for r in recs_in(u)]})
    rel.rescore("j", {**proj, "ai_spend_cap": 0}, provider=model2)
    assert len(model2.calls) == 3                                  # the 6 not yet cached


def test_ai_errors_never_fail_the_run(monkeypatch):
    put({"id": "c", "title": "Chef"}, {"id": "a", "title": "HSE lead"})
    proj = {"use_ai": True, "relevance": {**RULES, "use_ai": True}}

    def boom(u):
        raise ProviderError("HTTP 500: boom")

    out = rel.rescore("j", proj, provider=FakeModel(boom))
    assert out["scored"] == 2 and "boom" in out["errors"][0]
    assert recordstore.load("job:j")["c"]["relevance"] == 40

    # No key at all.
    monkeypatch.setattr(ai_tag, "get_provider", lambda: (_ for _ in ()).throw(ProviderError("No AI provider key")))
    assert rel.score_job("j", proj) == 2

    # Junk answers are ignored.
    junk = FakeModel(lambda u: {"results": [{"id": "c", "score": "lots"}, {"id": "zzz", "score": 99}, "x"]})
    out = rel.rescore("j", proj, provider=junk)
    assert out["ai_checked"] == 0 and recordstore.load("job:j")["c"]["relevance"] == 40


# ---- scrape.collect_job + CLI -------------------------------------------------------------

@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(localdb, "CONFIG_ROOT", tmp_path / "data")
    monkeypatch.setattr(localdb, "LOCAL_ROOT", tmp_path / "local-data")
    monkeypatch.setattr(fdb, "DB_DIR", tmp_path / "db")
    d = localdb.LocalDB()
    d.collection("projects").document("j").set({"name": "J", "enabled": True})
    for slug, title in (("hse-1", "HSE Officer"), ("chef-1", "Chef"), ("gym-1", "Gym Instructor")):
        d.collection("projects").document("j").collection("findings").document(slug).set({
            "title": title, "employer": "Acme", "source_id": "s1", "source_name": "Acme careers",
            "source_url": f"https://acme.com/jobs/{slug}",
            "first_seen_at": "2026-10-01T00:00:00Z", "last_seen_at": "2026-10-10T00:00:00Z"})
    return d


def test_collect_job_scores_and_keeps_scores_across_runs(db):
    counts = scrape.collect_job(db, "j")
    assert counts["scored"] == 0                                   # no rules yet
    assert all("relevance" not in r for r in recordstore.load("job:j").values())

    db.collection("projects").document("j").set({"name": "J", "enabled": True, "relevance": {
        "include": ["hse"], "exclude": ["gym"], "cutoff": 50, "use_ai": False}})
    assert scrape.collect_job(db, "j")["scored"] == 3
    recs = recordstore.load("job:j")
    assert {k: r["relevance"] for k, r in recs.items()} == {"v:hse-1": 85, "v:chef-1": 40, "v:gym-1": 0}
    scrape.collect_job(db, "j")                                    # collect keeps them
    assert recordstore.load("job:j")["v:hse-1"]["relevance"] == 85


def test_cli_rescoring(db, monkeypatch, capsys):
    monkeypatch.setattr(scrape, "_FIRESTORE_CLIENT", db)
    scrape.collect_job(db, "j")
    db.collection("projects").document("j").set({"name": "J", "relevance": {"include": ["chef"], "exclude": []}})
    assert rel.main(["--job", "j"]) == 0
    assert json.loads(capsys.readouterr().out)["scored"] == 3
    assert recordstore.load("job:j")["v:chef-1"]["relevance"] == 85

    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"project": "j"})))
    assert rel.main([]) == 0
    assert json.loads(capsys.readouterr().out)["scored"] == 3

    assert rel.main(["--job", "nope"]) == 0
    assert "no job" in json.loads(capsys.readouterr().out)["error"]
