"""OpenAI provider — Chat Completions with tool calling.

Also serves any OpenAI-compatible endpoint (OpenRouter, Groq, DeepSeek, Together,
a local vLLM/Ollama, ...) via a custom `base_url`, so "OpenAI-compatible" needs
no separate adapter.
"""

from __future__ import annotations

import json

from .base import LLMResponse, ProviderError, ToolCall, estimate_cost, http_post_json

DEFAULT_BASE = "https://api.openai.com/v1"

# Reasoning models take max_completion_tokens (not max_tokens) and reject
# temperature. Matched by prefix.
_REASONING_PREFIXES = ("o1", "o3", "o4", "o5", "gpt-5")


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str, model: str, *, base_url: str = "") -> None:
        if not api_key:
            raise ProviderError("OpenAI provider needs an API key")
        self.api_key = api_key
        self.model = model or "gpt-4o"
        self.base = (base_url.rstrip("/") if base_url else DEFAULT_BASE)
        # Only apply the reasoning-model quirks on the real OpenAI endpoint;
        # compatible endpoints follow the classic max_tokens contract.
        self._is_openai = not base_url or "openai.com" in self.base

    def _messages(self, system: str, history: list[dict]) -> list[dict]:
        out: list[dict] = [{"role": "system", "content": system}]
        for item in history:
            role = item.get("role")
            if role == "user":
                out.append({"role": "user", "content": item.get("text", "")})
            elif role == "assistant":
                calls = item.get("tool_calls", [])
                # OpenAI requires content to be a non-null string UNLESS
                # tool_calls are present. An empty assistant turn (no text, no
                # calls) must carry a placeholder or the replay 400s.
                content = item.get("text") or (None if calls else " ")
                msg: dict = {"role": "assistant", "content": content}
                if calls:
                    msg["tool_calls"] = [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.input or {}),
                            },
                        }
                        for tc in calls
                    ]
                out.append(msg)
            elif role == "tool":
                for r in item.get("results", []):
                    out.append({
                        "role": "tool",
                        "tool_call_id": r["id"],
                        "content": r["content"],
                    })
        return out

    def complete(
        self, *, system: str, tools: list[dict], history: list[dict],
        max_tokens: int = 4096,
    ) -> LLMResponse:
        body: dict = {
            "model": self.model,
            "messages": self._messages(system, history),
        }
        if self._is_openai and self.model.startswith(_REASONING_PREFIXES):
            body["max_completion_tokens"] = max_tokens
        else:
            body["max_tokens"] = max_tokens
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t["name"],
                        "description": t.get("description", ""),
                        "parameters": t["input_schema"],
                    },
                }
                for t in tools
            ]
            body["tool_choice"] = "auto"

        data = http_post_json(
            f"{self.base}/chat/completions",
            {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            body,
        )
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message", {}) or {}
        calls: list[ToolCall] = []
        for tc in msg.get("tool_calls") or []:
            fn = (tc or {}).get("function", {}) or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            calls.append(ToolCall(
                id=str(tc.get("id") or fn.get("name") or ""),
                name=str(fn.get("name") or ""),
                input=args if isinstance(args, dict) else {},
            ))
        usage = data.get("usage", {}) or {}
        in_tok = int(usage.get("prompt_tokens") or 0)
        out_tok = int(usage.get("completion_tokens") or 0)
        finish = choice.get("finish_reason")
        stop = (
            "tool_calls" if calls
            else "length" if finish == "length"
            else "stop"
        )
        return LLMResponse(
            text=str(msg.get("content") or "").strip(),
            tool_calls=calls,
            stop_reason=stop,
            usage=usage,
            cost_usd=estimate_cost(self.name, self.model, in_tok, out_tok),
        )
