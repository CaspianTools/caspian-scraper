"""aiconfig/discover.py — "Find websites" suggestions, offline (no network)."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig import discover  # noqa: E402


def test_detect_ats():
    assert discover.detect_ats('<script src="https://cms.jibecdn.com/x.js">') == "jibe"
    assert discover.detect_ats('<a data-careersite-propertyid="title">') == "successfactors"
    assert discover.detect_ats("<html>plain careers page</html>") == "unknown"


def test_catalog_region_words_match_countries(tmp_path, monkeypatch):
    cat = tmp_path / "employers.json"
    cat.write_text(json.dumps([
        {"name": "Gulf Co", "careers_url": "https://a.example/jobs", "countries": ["Qatar"], "ats": "jibe"},
        {"name": "Far Co", "careers_url": "https://b.example/jobs", "countries": ["Brazil"], "ats": "unknown"},
        {"name": "Have Co", "careers_url": "https://www.c.example/jobs/", "countries": ["UAE"], "ats": "unknown"},
        {"name": "No URL", "careers_url": "", "countries": ["UAE"]},
    ]), encoding="utf-8")
    monkeypatch.setattr(discover, "CATALOG_FILE", cat)
    got = discover.catalog_matches("HSE jobs Middle East", [], {"c.example/jobs"})
    assert [g["name"] for g in got] == ["Gulf Co"]   # Brazil off-region, Have Co excluded
    assert got[0]["catalog_ats"] == "jibe" and got[0]["source"] == "catalog"


def test_parse_list_tolerates_prose_and_fences():
    text = 'Here you go:\n```json\n[{"name": "A", "careers_url": "https://a"}]\n```'
    assert discover._parse_list(text) == [{"name": "A", "careers_url": "https://a"}]
    assert discover._parse_list("no json here") == []


def test_anthropic_search_resumes_pause_turn(monkeypatch):
    calls = []

    def fake_post(url, headers, body, **_kw):
        calls.append((url, headers, json.loads(json.dumps(body))))
        if len(calls) == 1:
            return {"stop_reason": "pause_turn",
                    "content": [{"type": "server_tool_use", "id": "s1", "name": "web_search"}]}
        return {"stop_reason": "end_turn",
                "content": [{"type": "web_search_tool_result", "content": []},
                            {"type": "text", "text": '[{"name": "X", '},
                            {"type": "text", "text": '"careers_url": "https://x"}]'}]}

    monkeypatch.setattr(discover, "http_post_json", fake_post)
    text = discover._anthropic_search({"value": "k", "model": ""}, "find")
    assert discover._parse_list(text) == [{"name": "X", "careers_url": "https://x"}]

    url, headers, body = calls[0]
    assert url == "https://api.anthropic.com/v1/messages"
    assert body["model"] == "claude-opus-5-5"
    assert body["tools"][0]["type"] == "web_search_20260209"
    assert body["fallbacks"] == "default"
    assert headers["anthropic-beta"] == "server-side-fallback-2026-07-01"
    # Resume = the paused assistant turn resent as-is, no extra user message.
    resumed = calls[1][2]["messages"]
    assert [m["role"] for m in resumed] == ["user", "assistant"]
    assert resumed[1]["content"][0]["type"] == "server_tool_use"


def test_older_model_gets_basic_search_tool_and_no_fallback(monkeypatch):
    seen = {}

    def fake_post(url, headers, body, **_kw):
        seen.update(body=body, headers=headers)
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": "[]"}]}

    monkeypatch.setattr(discover, "http_post_json", fake_post)
    discover._anthropic_search({"value": "k", "model": "claude-haiku-4-5"}, "find")
    assert seen["body"]["tools"][0]["type"] == "web_search_20250305"
    assert "fallbacks" not in seen["body"] and "anthropic-beta" not in seen["headers"]


def test_main_without_key_returns_catalog_only(monkeypatch, capsys):
    monkeypatch.setattr(discover, "load_key", lambda uid: None)
    monkeypatch.setattr(discover, "catalog_matches", lambda q, c, e: [
        {"name": "A", "careers_url": "https://a.example", "countries": [],
         "catalog_ats": "successfactors", "why": "", "source": "catalog"}])
    monkeypatch.setattr(discover, "verify", lambda url: {
        "reachable": True, "status": 200, "detected_ats": "unknown", "note": ""})
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"query": "hse"})))
    assert discover.main() == 0
    out = json.loads(capsys.readouterr().out)
    assert out["web_status"] == "no_key" and out["web"] == []
    (a,) = out["catalog"]
    # Platform falls back to the catalog's when the page check can't tell.
    assert a["ats"] == "successfactors" and a["scrapable"] is True
