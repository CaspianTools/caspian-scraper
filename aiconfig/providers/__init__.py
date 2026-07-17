"""Multi-provider LLM layer for the config agent.

Pick a provider (Anthropic / OpenAI / Google Gemini, or any OpenAI-compatible
endpoint via base_url) and a model; the agent is provider-agnostic. No SDKs —
every adapter is raw `requests`.
"""

from __future__ import annotations

import os

from .anthropic import AnthropicProvider
from .base import LLMResponse, ProviderError, ToolCall  # noqa: F401 — re-export
from .gemini import GeminiProvider
from .openai import OpenAIProvider

# Canonical provider ids. "openai_compatible" is the OpenAI adapter + base_url.
PROVIDERS = ("anthropic", "openai", "gemini", "openai_compatible")

DEFAULT_MODELS = {
    "anthropic": "claude-opus-4-8",
    "openai": "gpt-4o",
    "gemini": "gemini-2.5-pro",
    "openai_compatible": "",
}

# Suggested models per provider for the UI (users may type any model too).
MODEL_CATALOG = {
    "anthropic": [
        "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5",
    ],
    "openai": [
        "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini", "o3",
    ],
    "gemini": [
        # gemini-1.5-* were retired (shut down Sept 2025). 2.5 is GA (valid to
        # ~Oct 2026); 3.x is the current generation. Verified vs ai.google.dev.
        "gemini-3.5-flash", "gemini-2.5-pro", "gemini-2.5-flash",
        "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-3.1-pro-preview",
    ],
    "openai_compatible": [],
}


def _canon(provider: str) -> str:
    p = (provider or "anthropic").strip().lower()
    if p in ("compatible", "custom", "openai-compatible"):
        return "openai_compatible"
    if p == "google":
        return "gemini"
    return p


def build_provider(
    provider: str, *, api_key: str, model: str = "", base_url: str = ""
):
    """Construct a provider adapter. Raises ProviderError on unknown provider or
    a missing key."""
    p = _canon(provider)
    model = model or DEFAULT_MODELS.get(p, "")
    if p == "anthropic":
        return AnthropicProvider(api_key, model, base_url=base_url)
    if p == "openai":
        return OpenAIProvider(api_key, model, base_url=base_url)
    if p == "openai_compatible":
        if not base_url:
            raise ProviderError("openai_compatible provider requires a base_url")
        return OpenAIProvider(api_key, model, base_url=base_url)
    if p == "gemini":
        return GeminiProvider(api_key, model, base_url=base_url)
    raise ProviderError(f"unknown provider {provider!r}")


def key_env_for(provider: str) -> str:
    """The API key for a provider from the environment (CLI/dev use)."""
    p = _canon(provider)
    if p == "gemini":
        return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
    if p in ("openai", "openai_compatible"):
        return os.environ.get("OPENAI_API_KEY") or os.environ.get("AICONFIG_API_KEY") or ""
    # anthropic (default) — reuse the classifieds convention
    return os.environ.get("CLASSIFIEDS_AI_KEY") or os.environ.get("ANTHROPIC_API_KEY") or ""


def default_provider_from_env():
    """Build a provider from AICONFIG_PROVIDER / AICONFIG_MODEL / AICONFIG_BASE_URL
    + the matching key env var. Used by the local CLI flows."""
    provider = os.environ.get("AICONFIG_PROVIDER", "anthropic")
    model = os.environ.get("AICONFIG_MODEL", "").strip()
    base_url = os.environ.get("AICONFIG_BASE_URL", "").strip()
    return build_provider(
        provider, api_key=key_env_for(provider), model=model, base_url=base_url
    )


def env_key_present(provider: str = "") -> bool:
    return bool(key_env_for(provider or os.environ.get("AICONFIG_PROVIDER", "anthropic")))
