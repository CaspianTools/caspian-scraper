"""Multi-provider LLM layer for the config agent.

Pick a provider (Anthropic / OpenAI / Google Gemini / Kimi, or any
OpenAI-compatible endpoint via base_url) and a model; the agent is provider-agnostic. No SDKs —
every adapter is raw `requests`.
"""

from __future__ import annotations

import os

from .anthropic import AnthropicProvider
from .base import LLMResponse, ProviderError, ToolCall  # noqa: F401 — re-export
from .gemini import GeminiProvider
from .kimi import KimiProvider
from .openai import OpenAIProvider

# Canonical provider ids. "openai_compatible" is the OpenAI adapter + base_url.
PROVIDERS = ("anthropic", "openai", "gemini", "kimi", "openai_compatible")

DEFAULT_MODELS = {
    "anthropic": "claude-opus-5-5",
    "openai": "gpt-6.1-sol",
    "gemini": "gemini-4-argon",
    "kimi": "kimi-k3",
    "openai_compatible": "",
}

# Suggested models per provider for the UI (users may type any model too).
# Checked Oct 2026 against each provider's model list. Mirrored in
# web/components/settings/KeySettings.tsx (MODELS).
MODEL_CATALOG = {
    "anthropic": [
        "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1",
    ],
    "openai": [
        "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna",
    ],
    "gemini": [
        # 2.5 is limited to past users and 3-pro-preview is shut down.
        "gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash",
        "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite",
    ],
    "kimi": [
        # kimi-k2.5 and moonshot-v1-* were discontinued Aug 31 2026.
        "kimi-k3", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed",
    ],
    "openai_compatible": [],
}


def _canon(provider: str) -> str:
    p = (provider or "anthropic").strip().lower()
    if p in ("compatible", "custom", "openai-compatible"):
        return "openai_compatible"
    if p == "google":
        return "gemini"
    if p in ("moonshot", "moonshot_ai"):
        return "kimi"
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
    if p == "kimi":
        return KimiProvider(api_key, model, base_url=base_url)
    raise ProviderError(f"unknown provider {provider!r}")


def key_env_for(provider: str) -> str:
    """The API key for a provider from the environment (CLI/dev use)."""
    p = _canon(provider)
    if p == "gemini":
        return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
    if p == "kimi":
        return os.environ.get("MOONSHOT_API_KEY") or os.environ.get("KIMI_API_KEY") or ""
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
