"""Anthropic (Claude) provider — Messages API with tool use."""

from __future__ import annotations

from .base import LLMResponse, ProviderError, ToolCall, estimate_cost, http_post_json

API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str, model: str, *, base_url: str = "") -> None:
        if not api_key:
            raise ProviderError("Anthropic provider needs an API key")
        self.api_key = api_key
        self.model = model or "claude-opus-4-8"
        self.url = base_url.rstrip("/") + "/v1/messages" if base_url else API_URL

    def _messages(self, history: list[dict]) -> list[dict]:
        out: list[dict] = []
        for item in history:
            role = item.get("role")
            if role == "user":
                out.append({"role": "user", "content": item.get("text", "")})
            elif role == "assistant":
                content: list[dict] = []
                if item.get("text"):
                    content.append({"type": "text", "text": item["text"]})
                for tc in item.get("tool_calls", []):
                    content.append({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.input or {},
                    })
                out.append({"role": "assistant", "content": content or [
                    {"type": "text", "text": "(thinking)"}
                ]})
            elif role == "tool":
                content = [
                    {
                        "type": "tool_result",
                        "tool_use_id": r["id"],
                        "content": r["content"],
                    }
                    for r in item.get("results", [])
                ]
                out.append({"role": "user", "content": content})
        return out

    def complete(
        self, *, system: str, tools: list[dict], history: list[dict],
        max_tokens: int = 4096,
    ) -> LLMResponse:
        body: dict = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": [{
                "type": "text", "text": system,
                "cache_control": {"type": "ephemeral"},
            }],
            "messages": self._messages(history),
        }
        if tools:
            body["tools"] = [
                {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "input_schema": t["input_schema"],
                }
                for t in tools
            ]
        data = http_post_json(
            self.url,
            {
                "x-api-key": self.api_key,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            body,
        )
        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for block in data.get("content", []) or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                calls.append(ToolCall(
                    id=str(block.get("id") or ""),
                    name=str(block.get("name") or ""),
                    input=block.get("input") or {},
                ))
        usage = data.get("usage", {}) or {}
        in_tok = int(usage.get("input_tokens") or 0) + int(
            usage.get("cache_read_input_tokens") or 0
        ) + int(usage.get("cache_creation_input_tokens") or 0)
        out_tok = int(usage.get("output_tokens") or 0)
        raw_stop = data.get("stop_reason")
        stop = (
            "tool_calls" if calls
            else "length" if raw_stop == "max_tokens"
            else "stop"
        )
        return LLMResponse(
            text="".join(text_parts).strip(),
            tool_calls=calls,
            stop_reason=stop,
            usage=usage,
            cost_usd=estimate_cost(self.name, self.model, in_tok, out_tok),
        )
