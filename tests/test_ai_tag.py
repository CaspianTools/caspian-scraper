"""ai_tag.py — AI tagging of the findings database, with a fake model."""

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
from aiconfig.providers import LLMResponse, ProviderError, ToolCall  # noqa: E402


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(fdb, "DB_DIR", tmp_path / "db")
    monkeypatch.setattr(ai_tag, "_saved_settings", lambda: {})


class FakeModel:
    """Answers each call with answer(system, user) as the tool input."""

    def __init__(self, answer):
        self.answer = answer
        self.calls: list[tuple[str, str, dict]] = []
        self._lock = threading.Lock()

    def complete(self, *, system, tools, history, max_tokens=None):
        user = history[-1]["text"]
        with self._lock:
            self.calls.append((system, user, tools[0]))
        return LLMResponse(tool_calls=[ToolCall("1", tools[0]["name"], self.answer(system, user))],
                           cost_usd=0.01)


def ids_in(user: str) -> list[dict]:
    return [json.loads(l) for l in user.splitlines()[1:]]


def test_plan_cleans_and_dedupes_rules_and_sees_existing_tags():
    fdb.upsert([{"id": "a.com", "name": "A"}])
    fdb.retag(["a.com"], add=["Gulf"])
    model = FakeModel(lambda s, u: {"rules": [
        {"tag": "  Priority ", "criteria": "training centres in the GCC"},
        {"tag": "priority", "criteria": "duplicate"},
        {"tag": "", "criteria": "no name"},
        {"tag": "Gulf", "criteria": "based in a Gulf country"},
    ], "note": "read GCC as the six member states"})
    out = ai_tag.plan("priority = GCC training centres; tag gulf ones", provider=model)
    assert out["rules"] == [{"tag": "Priority", "criteria": "training centres in the GCC"},
                            {"tag": "Gulf", "criteria": "based in a Gulf country"}]
    assert out["note"].startswith("read GCC")
    assert "Existing tags in the database: Gulf" in model.calls[0][0]


def test_plan_needs_criteria_and_some_rules():
    with pytest.raises(ValueError):
        ai_tag.plan("   ", provider=FakeModel(lambda s, u: {}))
    with pytest.raises(ProviderError):
        ai_tag.plan("something", provider=FakeModel(lambda s, u: {"rules": []}))


def test_apply_batches_keeps_only_rule_tags_and_saves(monkeypatch):
    monkeypatch.setattr(ai_tag, "BATCH", 2)
    fdb.upsert([{"id": f"c{i}.com", "name": f"Company {i}", "countries": ["Qatar"]} for i in range(5)])

    def answer(system, user):
        assert "- Priority: even numbered" in system
        return {"results": [
            {"id": c["id"], "tags": ["priority", "Made Up"] if int(c["name"][-1]) % 2 == 0 else []}
            for c in ids_in(user)
        ]}

    model = FakeModel(answer)
    out = ai_tag.apply([{"tag": "Priority", "criteria": "even numbered"}],
                       [f"c{i}.com" for i in range(5)] + ["missing.com"], provider=model)
    assert len(model.calls) == 3                                   # 5 companies in batches of 2
    assert model.calls[0][2]["input_schema"]["properties"]["results"]["items"]["properties"]["tags"][
        "items"]["enum"] == ["Priority"]
    assert out["counts"] == {"Priority": 3} and out["tagged"] == 3 and out["checked"] == 5
    assert out["cost_usd"] == 0.03 and out["errors"] == []
    recs = fdb.load()
    assert recs["c0.com"]["tags"] == ["Priority"]                  # canonical spelling, no "Made Up"
    assert "tags" not in recs["c1.com"]


def test_apply_retries_skipped_ids_once():
    fdb.upsert([{"id": "a.com", "name": "A"}, {"id": "b.com", "name": "B"}])
    seen = []

    def answer(system, user):
        batch = ids_in(user)
        seen.append([c["id"] for c in batch])
        return {"results": [{"id": batch[0]["id"], "tags": ["Hot"]}]}  # answers only the first

    out = ai_tag.apply([{"tag": "Hot", "criteria": "any"}], ["a.com", "b.com"], provider=FakeModel(answer))
    assert seen == [["a.com", "b.com"], ["b.com"]]
    assert out["checked"] == 2 and out["skipped"] == 0


def test_apply_adds_only_unless_replace():
    fdb.upsert([{"id": "a.com", "name": "A"}])
    fdb.retag(["a.com"], add=["Hot", "Mine"])
    none = FakeModel(lambda s, u: {"results": [{"id": "a.com", "tags": []}]})
    ai_tag.apply([{"tag": "Hot", "criteria": "x"}], ["a.com"], provider=none)
    assert fdb.load()["a.com"]["tags"] == ["Hot", "Mine"]           # nothing taken off
    ai_tag.apply([{"tag": "Hot", "criteria": "x"}], ["a.com"], replace=True, provider=none)
    assert fdb.load()["a.com"]["tags"] == ["Mine"]                  # only the rule's tag removed


def test_a_failing_batch_is_reported_not_fatal(monkeypatch):
    monkeypatch.setattr(ai_tag, "BATCH", 1)
    fdb.upsert([{"id": "a.com", "name": "A"}, {"id": "b.com", "name": "B"}])

    def answer(system, user):
        c = ids_in(user)[0]
        if c["id"] == "b.com":
            raise ProviderError("HTTP 500: boom")
        return {"results": [{"id": "a.com", "tags": ["Hot"]}]}

    out = ai_tag.apply([{"tag": "Hot", "criteria": "x"}], ["a.com", "b.com"], provider=FakeModel(answer))
    assert out["tagged"] == 1 and out["skipped"] == 1 and "boom" in out["errors"][0]


def test_cli_reports_a_missing_key_as_an_error(monkeypatch, capsys):
    for v in ("ANTHROPIC_API_KEY", "CLASSIFIEDS_AI_KEY", "AICONFIG_PROVIDER"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"criteria": "tag hot ones"})))
    assert ai_tag.main(["--plan"]) == 0
    assert "Settings" in json.loads(capsys.readouterr().out)["error"]


def test_saved_settings_pick_the_provider(monkeypatch):
    monkeypatch.setattr(ai_tag, "_saved_settings",
                        lambda: {"provider": "kimi", "model": "kimi-k3", "value": "sk-test"})
    p = ai_tag.get_provider()
    assert type(p).__name__ == "KimiProvider" and p.model == "kimi-k3"
