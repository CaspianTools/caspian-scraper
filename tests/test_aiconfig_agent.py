"""Agent-loop tests with a mocked Anthropic API and injected tool impls.

No network, no browser, no LLM. A canned response sequence drives the loop; the
fake tool impls stand in for inspector/preview so we can assert termination, cap
enforcement, and result shaping deterministically.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig.agent import run_agent  # noqa: E402

VALID_EXT = {
    "link_discovery": {"mode": "css", "link_selector": "a[href*='/p/']"},
    "extractors": [{"type": "fields", "fields": {"title": "h1"}}],
}


def _tool_use(tid, name, inp, usage=(100, 40)):
    return {
        "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": usage[0], "output_tokens": usage[1]},
    }


def _fake_impl():
    state = {"previews": 0, "fetches": 0}

    def run_preview(extraction, start_url, detail_url="", **kw):
        state["previews"] += 1
        return (
            [{"title": "A"}, {"title": "B"}, {"title": "C"}],
            {"links_discovered": 4, "pages_visited": 3,
             "extractor_hits": {"fields": 3}},
        )

    def fetch_page(url, kind):
        state["fetches"] += 1
        return {"evidence": {"url": url}}

    impl = {
        "fetch_page": fetch_page,
        "propose_config": lambda e: [],
        "run_preview": run_preview,
    }
    return impl, state


def test_agent_finishes_with_config(monkeypatch):
    responses = [
        _tool_use("t1", "run_preview",
                  {"extraction": VALID_EXT, "start_url": "https://x/shop"}),
        _tool_use("t2", "finish",
                  {"extraction": VALID_EXT, "output_schema": ["title"],
                   "summary": "done"}),
    ]
    calls = {"i": 0}

    def fake_create(**kw):
        r = responses[calls["i"]]
        calls["i"] += 1
        return r

    monkeypatch.setattr("aiconfig.llm.messages_create", fake_create)
    impl, state = _fake_impl()
    res = run_agent("scrape titles", "https://x/shop", impl=impl)

    assert res.path == "config"
    assert res.extraction == VALID_EXT
    assert res.output_schema == ["title"]
    assert len(res.sample_records) == 3
    assert res.summary == "done"
    assert res.cost_usd > 0
    assert not res.incomplete
    assert state["previews"] == 1


def test_agent_respects_preview_cap(monkeypatch):
    # Model keeps asking for previews and never finishes.
    def fake_create(**kw):
        return _tool_use("t", "run_preview",
                         {"extraction": VALID_EXT, "start_url": "https://x"})

    monkeypatch.setattr("aiconfig.llm.messages_create", fake_create)
    impl, state = _fake_impl()
    res = run_agent("x", "https://x", impl=impl, max_previews=1, max_turns=4)

    # The harness must stop calling the real preview past the cap, even though
    # the model requested it every turn.
    assert state["previews"] == 1
    assert res.incomplete


def test_agent_escalates_to_adapter(monkeypatch):
    def fake_create(**kw):
        return _tool_use("e", "escalate_adapter", {"reason": "site returns 403"})

    monkeypatch.setattr("aiconfig.llm.messages_create", fake_create)
    impl, _ = _fake_impl()
    res = run_agent("x", "https://x", impl=impl)

    assert res.path == "adapter"
    assert "403" in res.escalation_reason


def test_agent_handles_api_error(monkeypatch):
    from aiconfig import llm

    def boom(**kw):
        raise llm.LLMError("boom")

    monkeypatch.setattr("aiconfig.llm.messages_create", boom)
    impl, _ = _fake_impl()
    res = run_agent("x", "https://x", impl=impl)

    assert res.incomplete
    assert "boom" in res.error


def test_finish_with_unpreviewed_config_omits_samples(monkeypatch):
    # Preview config A (records), then finish with a DIFFERENT config B. The
    # samples belong to A, so they must NOT be attached to the emitted B.
    ext_b = {
        "link_discovery": {"mode": "css", "link_selector": "a.other"},
        "extractors": [{"type": "fields", "fields": {"title": "h2"}}],
    }
    responses = [
        _tool_use("t1", "run_preview",
                  {"extraction": VALID_EXT, "start_url": "https://x"}),
        _tool_use("t2", "finish",
                  {"extraction": ext_b, "output_schema": ["title"],
                   "summary": "done"}),
    ]
    calls = {"i": 0}

    def fake_create(**kw):
        r = responses[calls["i"]]
        calls["i"] += 1
        return r

    monkeypatch.setattr("aiconfig.llm.messages_create", fake_create)
    impl, _ = _fake_impl()
    res = run_agent("x", "https://x", impl=impl)

    assert res.extraction == ext_b
    assert res.sample_records == []            # A's samples must not leak onto B
    assert "not the previewed one" in res.summary


def test_failed_preview_does_not_become_best(monkeypatch):
    # First preview uses an INVALID config (validation fails → no records); the
    # agent must never fall back to it as `best`.
    invalid = {"link_discovery": {"mode": "css"}, "extractors": []}
    responses = [
        _tool_use("t1", "run_preview",
                  {"extraction": invalid, "start_url": "https://x"}),
    ]

    def fake_create(**kw):
        # Always ask for the invalid preview; never finish.
        return responses[0]

    monkeypatch.setattr("aiconfig.llm.messages_create", fake_create)
    impl, state = _fake_impl()
    res = run_agent("x", "https://x", impl=impl, max_turns=3)

    # Validation fails before the fake preview ever runs, so no records exist
    # and no best config is retained.
    assert state["previews"] == 0
    assert res.extraction is None
    assert res.incomplete
