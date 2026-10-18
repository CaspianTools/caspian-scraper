"""Agent-loop tests with an injected FAKE provider and fake tool impls.

No network, no browser, no LLM, no provider HTTP. A canned LLMResponse sequence
drives the loop; the fake tool impls stand in for inspector/preview so we can
assert termination, cap enforcement, and result shaping deterministically. The
agent is provider-agnostic, so a fake provider is all we need.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig.agent import run_agent  # noqa: E402
from aiconfig.providers.base import LLMResponse, ProviderError, ToolCall  # noqa: E402

VALID_EXT = {
    "link_discovery": {"mode": "css", "link_selector": "a[href*='/p/']"},
    "extractors": [{"type": "fields", "fields": {"title": "h1"}}],
}


class FakeProvider:
    """Returns canned LLMResponses in order; repeats the last one thereafter."""
    name = "fake"
    model = "fake-1"

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    def complete(self, *, system, tools, history, max_tokens=4096):
        r = self._responses[min(self.calls, len(self._responses) - 1)]
        self.calls += 1
        if isinstance(r, Exception):
            raise r
        return r


def _call(tid, name, inp):
    return LLMResponse(
        text="", tool_calls=[ToolCall(id=tid, name=name, input=inp)],
        stop_reason="tool_calls", cost_usd=0.01,
    )


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


def test_agent_finishes_with_config():
    provider = FakeProvider([
        _call("t1", "run_preview", {"extraction": VALID_EXT, "start_url": "https://x/shop"}),
        _call("t2", "finish", {"extraction": VALID_EXT, "output_schema": ["title"],
                               "summary": "done"}),
    ])
    impl, state = _fake_impl()
    res = run_agent("scrape titles", "https://x/shop", provider=provider, impl=impl)

    assert res.path == "config"
    assert res.extraction == VALID_EXT
    assert res.output_schema == ["title"]
    assert len(res.sample_records) == 3
    assert res.summary == "done"
    assert res.cost_usd > 0
    assert not res.incomplete
    assert state["previews"] == 1


def test_agent_respects_preview_cap():
    # Model keeps asking for previews and never finishes.
    provider = FakeProvider([
        _call("t", "run_preview", {"extraction": VALID_EXT, "start_url": "https://x"}),
    ])
    impl, state = _fake_impl()
    res = run_agent("x", "https://x", provider=provider, impl=impl,
                    max_previews=1, max_turns=4)

    assert state["previews"] == 1     # harness stops calling preview past the cap
    assert res.incomplete


def test_agent_escalates_to_adapter():
    provider = FakeProvider([
        _call("e", "escalate_adapter", {"reason": "site returns 403"}),
    ])
    impl, _ = _fake_impl()
    res = run_agent("x", "https://x", provider=provider, impl=impl)

    assert res.path == "adapter"
    assert "403" in res.escalation_reason


def test_agent_handles_api_error():
    provider = FakeProvider([ProviderError("boom")])
    impl, _ = _fake_impl()
    res = run_agent("x", "https://x", provider=provider, impl=impl)

    assert res.incomplete
    assert "boom" in res.error


def test_finish_with_unpreviewed_config_omits_samples():
    # Preview config A (records), then finish with a DIFFERENT config B. The
    # samples belong to A, so they must NOT be attached to the emitted B.
    ext_b = {
        "link_discovery": {"mode": "css", "link_selector": "a.other"},
        "extractors": [{"type": "fields", "fields": {"title": "h2"}}],
    }
    provider = FakeProvider([
        _call("t1", "run_preview", {"extraction": VALID_EXT, "start_url": "https://x"}),
        _call("t2", "finish", {"extraction": ext_b, "output_schema": ["title"],
                               "summary": "done"}),
    ])
    impl, _ = _fake_impl()
    res = run_agent("x", "https://x", provider=provider, impl=impl)

    assert res.extraction == ext_b
    assert res.sample_records == []
    assert "not the previewed one" in res.summary


def test_failed_preview_does_not_become_best():
    # An INVALID config fails validate_extraction before the fake preview runs,
    # so no records exist and the agent never retains it as `best`.
    invalid = {"link_discovery": {"mode": "css"}, "extractors": []}
    provider = FakeProvider([
        _call("t1", "run_preview", {"extraction": invalid, "start_url": "https://x"}),
    ])
    impl, state = _fake_impl()
    res = run_agent("x", "https://x", provider=provider, impl=impl, max_turns=3)

    assert state["previews"] == 0
    assert res.extraction is None
    assert res.incomplete
