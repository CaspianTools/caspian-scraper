"""Kimi (Moonshot AI) provider — its OpenAI-compatible Chat Completions API.

Same wire format as OpenAI, with the quirks from Kimi's docs
(platform.kimi.ai/docs/guide/kimi-k3-quickstart): thinking is always on,
output is capped with max_completion_tokens, sampling params are fixed (so we
never send them), and each assistant message — reasoning_content included —
must go back unchanged on the next turn.
"""

from __future__ import annotations

from .openai import OpenAIProvider

DEFAULT_BASE = "https://api.moonshot.ai/v1"


class KimiProvider(OpenAIProvider):
    name = "kimi"
    # Thinking tokens count against the cap; leave room for them.
    DEFAULT_MAX_TOKENS = 32000
    REPLAY_RAW = True

    def __init__(self, api_key: str, model: str, *, base_url: str = "") -> None:
        super().__init__(api_key, model or "kimi-k3", base_url=base_url or DEFAULT_BASE)

    def _uses_completion_tokens(self) -> bool:
        return True

    def _extra_body(self) -> dict:
        # K3 defaults to "max" effort; "high" keeps setup turns quick and cheap.
        return {"reasoning_effort": "high"} if self.model.startswith("kimi-k3") else {}
