"""Minimal Anthropic Messages API tool-use client over raw `requests`.

Extends the classifieds/ai.py pattern (same auth idiom, no SDK dependency) to
the multi-turn tool-use loop the config agent needs. Tool use is GA — no beta
header required.
"""

from __future__ import annotations

import os
import time

import requests

from classifieds.ai import ai_key

API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

# Strong reasoner by default; override per-env. (The IDs in classifieds/ai.py are
# stale — model choice is a constant here.) Newest families: Claude 5 / Opus 4.8.
REASONER_MODEL = os.environ.get("AICONFIG_MODEL", "claude-opus-4-8")
INSPECT_MODEL = os.environ.get("AICONFIG_INSPECT_MODEL", "claude-haiku-4-5")

# Approx per-MTok USD (input, output) for the soft budget guard only.
_PRICING: dict[str, tuple[float, float]] = {
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}
_DEFAULT_PRICING = (5.0, 25.0)


class LLMError(RuntimeError):
    """Raised on a non-retryable API error or exhausted retries."""


def messages_create(
    *,
    model: str,
    system: list | str,
    tools: list,
    messages: list,
    max_tokens: int = 4096,
    timeout: int = 180,
) -> dict:
    """POST /v1/messages and return the parsed JSON. Retries 429/5xx a few
    times with backoff; raises LLMError on 4xx or exhausted retries."""
    key = ai_key()
    if not key:
        raise LLMError(
            "no Anthropic API key — set CLASSIFIEDS_AI_KEY or ANTHROPIC_API_KEY"
        )
    headers = {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "tools": tools,
        "messages": messages,
    }
    last_err: object = None
    for attempt in range(4):
        try:
            r = requests.post(API_URL, headers=headers, json=body, timeout=timeout)
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
            raise LLMError(f"HTTP {r.status_code}: {(r.text or '')[:400]}")
        return r.json()
    raise LLMError(f"exhausted retries contacting Anthropic API: {last_err}")


def usage_cost_usd(model: str, usage: dict) -> float:
    """Conservative USD estimate for one response's usage block. Counts every
    input-ish token at the input rate (cache reads are actually ~10x cheaper, so
    this over-estimates — safer for a hard-stop guard)."""
    in_rate, out_rate = _PRICING.get(model, _DEFAULT_PRICING)
    inp = (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
    )
    out = int(usage.get("output_tokens") or 0)
    return (inp / 1_000_000) * in_rate + (out / 1_000_000) * out_rate


def text_blocks(response: dict) -> str:
    """Concatenate the text content blocks of a response."""
    return "".join(
        b.get("text", "")
        for b in response.get("content", [])
        if isinstance(b, dict) and b.get("type") == "text"
    )
