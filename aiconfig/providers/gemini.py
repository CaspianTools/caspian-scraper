"""Google Gemini provider — generateContent with function calling.

Gemini matches a function response to its call by function NAME (not an id), so
neutral tool-result items are keyed back by name here.
"""

from __future__ import annotations

import json

from .base import LLMResponse, ProviderError, ToolCall, estimate_cost, http_post_json

DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"


def _sanitize_params(schema: dict) -> tuple[dict, set]:
    """Gemini's schema validator rejects an OBJECT-typed param with no/empty
    `properties`, and can't express a free-form object (like our `extraction`
    arg). Convert any such top-level param to a STRING (the model passes JSON
    text). Returns (wire_schema, names_that_were_stringified) so complete() can
    JSON-parse those args back into dicts — keeping ToolCall.input a real dict,
    so the agent is unaffected."""
    if not isinstance(schema, dict) or not isinstance(schema.get("properties"), dict):
        return schema, set()
    new_props: dict = {}
    stringified: set = set()
    for name, sub in schema["properties"].items():
        if isinstance(sub, dict) and sub.get("type") == "object" and not sub.get("properties"):
            desc = (sub.get("description") or "").strip()
            new_props[name] = {
                "type": "string",
                "description": (desc + " (a JSON object; pass it as a JSON string)").strip(),
            }
            stringified.add(name)
        else:
            new_props[name] = sub
    out = dict(schema)
    out["properties"] = new_props
    return out, stringified


class GeminiProvider:
    name = "gemini"

    def __init__(self, api_key: str, model: str, *, base_url: str = "") -> None:
        if not api_key:
            raise ProviderError("Gemini provider needs an API key")
        self.api_key = api_key
        self.model = model or "gemini-2.5-pro"
        self.base = base_url.rstrip("/") if base_url else DEFAULT_BASE

    def _contents(self, history: list[dict]) -> list[dict]:
        out: list[dict] = []
        for item in history:
            role = item.get("role")
            if role == "user":
                out.append({"role": "user", "parts": [{"text": item.get("text", "")}]})
            elif role == "assistant":
                parts: list[dict] = []
                if item.get("text"):
                    parts.append({"text": item["text"]})
                for tc in item.get("tool_calls", []):
                    parts.append({
                        "functionCall": {"name": tc.name, "args": tc.input or {}}
                    })
                out.append({"role": "model", "parts": parts or [{"text": " "}]})
            elif role == "tool":
                parts = [
                    {
                        "functionResponse": {
                            "name": r["name"],
                            "response": {"result": r["content"]},
                        }
                    }
                    for r in item.get("results", [])
                ]
                out.append({"role": "user", "parts": parts})
        return out

    def complete(
        self, *, system: str, tools: list[dict], history: list[dict],
        max_tokens: int = 4096,
    ) -> LLMResponse:
        body: dict = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": self._contents(history),
            "generationConfig": {"maxOutputTokens": max_tokens},
        }
        stringified_by_tool: dict[str, set] = {}
        if tools:
            decls = []
            for t in tools:
                params, sset = _sanitize_params(t["input_schema"])
                stringified_by_tool[t["name"]] = sset
                decls.append({
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": params,
                })
            body["tools"] = [{"functionDeclarations": decls}]

        data = http_post_json(
            f"{self.base}/models/{self.model}:generateContent",
            {
                "x-goog-api-key": self.api_key,
                "Content-Type": "application/json",
            },
            body,
        )
        cand = (data.get("candidates") or [{}])[0]
        parts = ((cand.get("content") or {}).get("parts")) or []
        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for p in parts:
            if not isinstance(p, dict):
                continue
            if "text" in p:
                text_parts.append(p.get("text") or "")
            elif "functionCall" in p:
                fc = p["functionCall"] or {}
                name = str(fc.get("name") or "")
                args = dict(fc.get("args") or {})
                # Parse back any args we stringified for Gemini's validator.
                for pname in stringified_by_tool.get(name, ()):
                    v = args.get(pname)
                    if isinstance(v, str):
                        try:
                            args[pname] = json.loads(v)
                        except ValueError:
                            pass
                calls.append(ToolCall(id=name, name=name, input=args))
        usage = data.get("usageMetadata", {}) or {}
        in_tok = int(usage.get("promptTokenCount") or 0)
        out_tok = int(usage.get("candidatesTokenCount") or 0)
        finish = cand.get("finishReason")
        stop = (
            "tool_calls" if calls
            else "length" if finish == "MAX_TOKENS"
            else "stop"
        )
        return LLMResponse(
            text="".join(text_parts).strip(),
            tool_calls=calls,
            stop_reason=stop,
            usage=usage,
            cost_usd=estimate_cost(self.name, self.model, in_tok, out_tok),
        )
