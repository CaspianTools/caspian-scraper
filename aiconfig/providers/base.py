"""Provider-agnostic LLM interface for the config agent.

The agent speaks a small neutral vocabulary — a system prompt, a list of tool
specs, and a conversation history of user / assistant(+tool_calls) / tool-result
turns — and each provider adapter translates that to/from its own wire format
(Anthropic Messages, OpenAI Chat Completions, Google Gemini generateContent).
No SDKs: everything is raw `requests`, matching classifieds/ai.py.

Neutral history item shapes (list of dicts):
  {"role": "user", "text": str}
  {"role": "assistant", "text": str, "tool_calls": [ToolCall, ...], "raw": list | None}
  {"role": "tool", "results": [{"id": str, "name": str, "content": str}, ...]}
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import requests


class ProviderError(RuntimeError):
    """Non-retryable API error or exhausted retries."""


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict


@dataclass
class LLMResponse:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    # "tool_calls" (wants tools run), "stop" (final), or "length" (truncated)
    stop_reason: str = "stop"
    usage: dict = field(default_factory=dict)
    cost_usd: float = 0.0
    # Provider-native assistant content to replay verbatim next turn (Anthropic:
    # thinking blocks must go back unchanged). None = rebuild from text/tool_calls.
    raw_content: list | None = None


def http_post_json(url: str, headers: dict, body: dict, *, timeout: int = 180) -> dict:
    """POST JSON with a few backoff retries on 429/5xx. Raises ProviderError on
    4xx or exhausted retries."""
    last_err: object = None
    for attempt in range(4):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=timeout)
        except requests.RequestException as e:
            last_err = e
            time.sleep(2 * (attempt + 1))
            continue
        if r.status_code == 429 or r.status_code >= 500:
            last_err = f"HTTP {r.status_code}: {(r.text or '')[:200]}"
            try:
                wait = int(r.headers.get("retry-after") or (2 * (attempt + 1)))
            except ValueError:
                wait = 2 * (attempt + 1)
            time.sleep(min(wait, 30))
            continue
        if r.status_code >= 400:
            raise ProviderError(f"HTTP {r.status_code}: {(r.text or '')[:400]}")
        try:
            return r.json()
        except ValueError as e:
            raise ProviderError(f"non-JSON response: {e}") from e
    raise ProviderError(f"exhausted retries contacting the model API: {last_err}")


# Coarse per-MTok (input, output) USD pricing for the budget guard only. Matched
# by longest model-name prefix; falls back to the provider's "_default". These
# are estimates for a soft hard-stop, not billing.
_PRICING: dict[str, dict[str, tuple[float, float]]] = {
    "anthropic": {
        "claude-fable": (10.0, 50.0),
        "claude-opus-5-5": (4.0, 20.0),
        "claude-opus": (5.0, 25.0),
        "claude-sonnet-5": (2.0, 10.0),
        "claude-sonnet": (3.0, 15.0),
        "claude-haiku-5-5": (0.10, 0.50),
        "claude-haiku": (1.0, 5.0),
        "_default": (4.0, 20.0),
    },
    "openai": {
        "gpt-6-astra": (10.0, 50.0),
        "gpt-6.1-sol": (2.0, 10.0),
        "gpt-6-luna": (0.10, 0.50),
        "gpt-4o-mini": (0.15, 0.60),
        "gpt-4o": (2.5, 10.0),
        "gpt-4.1-mini": (0.4, 1.6),
        "gpt-4.1": (2.0, 8.0),
        "_default": (2.0, 10.0),
    },
    "gemini": {
        "gemini-4-argon": (2.0, 10.0),
        "gemini-3.8-flash": (0.75, 3.75),
        "gemini-3.6-flash": (0.75, 3.75),
        "gemini-3.5-flash-lite": (0.30, 2.5),
        "gemini-3.1-pro": (2.0, 12.0),
        "gemini-3.1-flash-lite": (0.25, 1.5),
        "gemini-2.5-pro": (1.25, 10.0),
        "gemini-2.5-flash": (0.30, 2.5),
        "gemini-2.5-flash-lite": (0.10, 0.40),
        "_default": (2.0, 10.0),
    },
}


def estimate_cost(provider: str, model: str, in_tokens: int, out_tokens: int) -> float:
    table = _PRICING.get(provider, _PRICING["anthropic"])
    rate = table["_default"]
    best = -1
    for prefix, r in table.items():
        if prefix != "_default" and model.startswith(prefix) and len(prefix) > best:
            rate = r
            best = len(prefix)
    return (in_tokens / 1_000_000) * rate[0] + (out_tokens / 1_000_000) * rate[1]
