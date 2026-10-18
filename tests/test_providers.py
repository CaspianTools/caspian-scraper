"""Provider adapter tests: neutral history/tools -> each provider's wire format,
and each provider's response -> neutral LLMResponse. HTTP is mocked; no network.
The tool-call/tool-result round-trip is the load-bearing bit — a broken pairing
would 400 the real APIs.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import aiconfig.providers.anthropic as anthropic_mod  # noqa: E402
import aiconfig.providers.gemini as gemini_mod  # noqa: E402
import aiconfig.providers.openai as openai_mod  # noqa: E402
from aiconfig.providers import build_provider  # noqa: E402
from aiconfig.providers.base import (  # noqa: E402
    ProviderError,
    ToolCall,
    estimate_cost,
)

TOOLSPEC = [{"name": "run_preview", "description": "d",
             "input_schema": {"type": "object"}}]


def _patch(monkeypatch, module, response):
    captured: dict = {}

    def fake(url, headers, body, timeout=180):
        captured["url"] = url
        captured["headers"] = headers
        captured["body"] = body
        return response

    monkeypatch.setattr(module, "http_post_json", fake)
    return captured


# ---------- Anthropic ----------

def test_anthropic_parses_tool_call(monkeypatch):
    resp = {
        "content": [
            {"type": "text", "text": "ok"},
            {"type": "tool_use", "id": "a1", "name": "run_preview", "input": {"x": 1}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 100, "output_tokens": 20},
    }
    cap = _patch(monkeypatch, anthropic_mod, resp)
    p = anthropic_mod.AnthropicProvider("k", "claude-opus-4-8")
    out = p.complete(system="sys", tools=TOOLSPEC, history=[{"role": "user", "text": "hi"}])

    assert out.text == "ok"
    assert out.stop_reason == "tool_calls"
    assert out.tool_calls[0].name == "run_preview"
    assert out.tool_calls[0].input == {"x": 1}
    assert out.cost_usd > 0
    body = cap["body"]
    assert body["model"] == "claude-opus-4-8"
    assert body["system"][0]["text"] == "sys"
    assert body["tools"][0]["name"] == "run_preview"
    assert body["messages"][0] == {"role": "user", "content": "hi"}


def test_anthropic_tool_result_pairing(monkeypatch):
    cap = _patch(monkeypatch, anthropic_mod, {
        "content": [{"type": "text", "text": "done"}],
        "stop_reason": "end_turn", "usage": {},
    })
    p = anthropic_mod.AnthropicProvider("k", "claude-opus-4-8")
    history = [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "", "tool_calls": [ToolCall("a1", "run_preview", {"x": 1})]},
        {"role": "tool", "results": [{"id": "a1", "name": "run_preview", "content": "{}"}]},
    ]
    p.complete(system="s", tools=[], history=history)
    msgs = cap["body"]["messages"]
    assert any(b.get("type") == "tool_use" and b["id"] == "a1" for b in msgs[1]["content"])
    assert msgs[2]["role"] == "user"
    assert msgs[2]["content"][0]["type"] == "tool_result"
    assert msgs[2]["content"][0]["tool_use_id"] == "a1"


# ---------- OpenAI ----------

def test_openai_parses_tool_call(monkeypatch):
    resp = {
        "choices": [{
            "message": {"content": "", "tool_calls": [
                {"id": "c1", "function": {"name": "run_preview", "arguments": '{"x": 1}'}}
            ]},
            "finish_reason": "tool_calls",
        }],
        "usage": {"prompt_tokens": 100, "completion_tokens": 20},
    }
    cap = _patch(monkeypatch, openai_mod, resp)
    p = openai_mod.OpenAIProvider("k", "gpt-4o")
    out = p.complete(system="sys", tools=TOOLSPEC, history=[{"role": "user", "text": "hi"}])

    assert out.tool_calls[0].name == "run_preview"
    assert out.tool_calls[0].input == {"x": 1}
    body = cap["body"]
    assert body["messages"][0] == {"role": "system", "content": "sys"}
    assert body["messages"][1] == {"role": "user", "content": "hi"}
    assert body["tools"][0]["type"] == "function"
    assert body["tools"][0]["function"]["name"] == "run_preview"
    assert "max_tokens" in body  # gpt-4o uses max_tokens


def test_openai_reasoning_model_uses_completion_tokens(monkeypatch):
    cap = _patch(monkeypatch, openai_mod, {
        "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}], "usage": {},
    })
    openai_mod.OpenAIProvider("k", "o4-mini").complete(
        system="s", tools=[], history=[{"role": "user", "text": "x"}])
    assert "max_completion_tokens" in cap["body"]
    assert "max_tokens" not in cap["body"]


def test_openai_tool_result_pairing(monkeypatch):
    cap = _patch(monkeypatch, openai_mod, {
        "choices": [{"message": {"content": "done"}, "finish_reason": "stop"}], "usage": {},
    })
    history = [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "", "tool_calls": [ToolCall("c1", "run_preview", {"x": 1})]},
        {"role": "tool", "results": [{"id": "c1", "name": "run_preview", "content": "{}"}]},
    ]
    openai_mod.OpenAIProvider("k", "gpt-4o").complete(system="s", tools=[], history=history)
    msgs = cap["body"]["messages"]
    asst = [m for m in msgs if m["role"] == "assistant"][0]
    assert asst["tool_calls"][0]["id"] == "c1"
    tool_msg = [m for m in msgs if m["role"] == "tool"][0]
    assert tool_msg["tool_call_id"] == "c1"


def test_openai_empty_assistant_gets_placeholder(monkeypatch):
    # An assistant turn with no text and no tool_calls must not serialize to
    # content:null (OpenAI 400s) — it gets a placeholder space instead.
    cap = _patch(monkeypatch, openai_mod, {
        "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}], "usage": {},
    })
    history = [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "", "tool_calls": []}]
    openai_mod.OpenAIProvider("k", "gpt-4o").complete(system="s", tools=[], history=history)
    asst = [m for m in cap["body"]["messages"] if m["role"] == "assistant"][0]
    assert asst["content"] == " "
    assert "tool_calls" not in asst


def test_openai_compatible_base_url(monkeypatch):
    cap = _patch(monkeypatch, openai_mod, {
        "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}], "usage": {},
    })
    p = openai_mod.OpenAIProvider("k", "llama-3.1", base_url="https://openrouter.ai/api/v1")
    p.complete(system="s", tools=[], history=[{"role": "user", "text": "x"}])
    assert cap["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert "max_tokens" in cap["body"]  # compatible endpoints use the classic field


# ---------- Gemini ----------

def test_gemini_parses_function_call(monkeypatch):
    resp = {
        "candidates": [{
            "content": {"parts": [
                {"text": "ok"},
                {"functionCall": {"name": "run_preview", "args": {"x": 1}}},
            ]},
            "finishReason": "STOP",
        }],
        "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 20},
    }
    cap = _patch(monkeypatch, gemini_mod, resp)
    p = gemini_mod.GeminiProvider("k", "gemini-2.5-pro")
    out = p.complete(system="sys", tools=TOOLSPEC, history=[{"role": "user", "text": "hi"}])

    assert out.text == "ok"
    assert out.tool_calls[0].name == "run_preview"
    assert out.tool_calls[0].input == {"x": 1}
    body = cap["body"]
    assert body["systemInstruction"]["parts"][0]["text"] == "sys"
    assert body["contents"][0] == {"role": "user", "parts": [{"text": "hi"}]}
    assert body["tools"][0]["functionDeclarations"][0]["name"] == "run_preview"
    assert "gemini-2.5-pro:generateContent" in cap["url"]


def test_gemini_sanitizes_free_form_object_param(monkeypatch):
    # `extraction` is a bare {"type":"object"} — Gemini would 400 on it. The
    # adapter must send it as a string param and parse the returned arg back.
    resp = {
        "candidates": [{"content": {"parts": [
            {"functionCall": {"name": "run_preview",
                              "args": {"extraction": '{"a": 1}', "start_url": "u"}}}
        ]}, "finishReason": "STOP"}],
        "usageMetadata": {},
    }
    cap = _patch(monkeypatch, gemini_mod, resp)
    tools = [{
        "name": "run_preview", "description": "d",
        "input_schema": {
            "type": "object",
            "properties": {"extraction": {"type": "object"},
                           "start_url": {"type": "string"}},
            "required": ["extraction", "start_url"],
        },
    }]
    p = gemini_mod.GeminiProvider("k", "gemini-2.5-pro")
    out = p.complete(system="s", tools=tools, history=[{"role": "user", "text": "hi"}])

    params = cap["body"]["tools"][0]["functionDeclarations"][0]["parameters"]
    assert params["properties"]["extraction"]["type"] == "string"  # not a bare object
    assert params["properties"]["start_url"]["type"] == "string"
    assert out.tool_calls[0].input["extraction"] == {"a": 1}       # parsed back


def test_gemini_function_response_by_name(monkeypatch):
    cap = _patch(monkeypatch, gemini_mod, {
        "candidates": [{"content": {"parts": [{"text": "done"}]}, "finishReason": "STOP"}],
        "usageMetadata": {},
    })
    history = [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "", "tool_calls": [ToolCall("run_preview", "run_preview", {"x": 1})]},
        {"role": "tool", "results": [{"id": "run_preview", "name": "run_preview", "content": "{}"}]},
    ]
    gemini_mod.GeminiProvider("k", "gemini-2.5-pro").complete(system="s", tools=[], history=history)
    contents = cap["body"]["contents"]
    model_turn = [c for c in contents if c["role"] == "model"][0]
    assert model_turn["parts"][0]["functionCall"]["name"] == "run_preview"
    assert contents[-1]["parts"][0]["functionResponse"]["name"] == "run_preview"


# ---------- registry + cost ----------

def test_build_provider_registry():
    assert build_provider("anthropic", api_key="k").name == "anthropic"
    assert build_provider("openai", api_key="k").name == "openai"
    assert build_provider("gemini", api_key="k").name == "gemini"
    assert build_provider("google", api_key="k").name == "gemini"
    p = build_provider("openai_compatible", api_key="k", model="m", base_url="https://x/v1")
    assert p.base == "https://x/v1"


def test_build_provider_errors():
    with pytest.raises(ProviderError):
        build_provider("anthropic", api_key="")
    with pytest.raises(ProviderError):
        build_provider("openai_compatible", api_key="k")   # missing base_url
    with pytest.raises(ProviderError):
        build_provider("nope", api_key="k")


def test_estimate_cost():
    assert estimate_cost("anthropic", "claude-opus-4-8", 1_000_000, 1_000_000) > 0
    assert estimate_cost("openai", "gpt-4o", 0, 0) == 0
    assert estimate_cost("gemini", "gemini-2.5-flash", 1_000_000, 0) > 0
