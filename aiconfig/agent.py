"""The agentic loop: Claude authors an extraction config, verifies it with live
previews, and either finishes (config path) or escalates to adapter generation.

Tool executors are injected (`impl`) so tests can drive the loop with fakes and
without a live browser/LLM. The default impl wires the real inspector + preview.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from .config_schema import derive_output_schema, validate_extraction
from .evidence import PageEvidence
from .inspector import inspect_url
from .preview import run_preview
from .presets import PRESETS
from .providers import default_provider_from_env
from .providers.base import ProviderError

# Harness-enforced caps (never trust the model to self-limit).
MAX_TURNS = 12
MAX_PREVIEWS = 6
MAX_FETCHES = 4
USD_HARD_STOP = 2.00
PREVIEW_MAX_ITEMS = 5


@dataclass
class AgentResult:
    path: str = "config"                 # "config" | "adapter"
    extraction: dict | None = None
    output_schema: list[str] = field(default_factory=list)
    sample_records: list[dict] = field(default_factory=list)
    diagnostics: dict = field(default_factory=dict)
    summary: str = ""
    escalation_reason: str = ""
    cost_usd: float = 0.0
    turns_used: int = 0
    incomplete: bool = False
    error: str = ""
    transcript: list[dict] = field(default_factory=list)


# ----- tool definitions (what Claude sees) --------------------------------

TOOLS = [
    {
        "name": "fetch_page",
        "description": (
            "Fetch a URL with a real browser and return structured evidence: "
            "JSON-LD/@types, __NEXT_DATA__ keys, og/meta, candidate listing-grid "
            "link selectors, next-page selectors, per-field CSS candidates with "
            "live match counts + sample text, and a cleaned HTML excerpt. Use on "
            "the listing page and one representative detail page."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "kind": {"type": "string", "enum": ["listing", "detail"]},
            },
            "required": ["url", "kind"],
        },
    },
    {
        "name": "propose_config",
        "description": (
            "Validate a candidate extraction config against the schema WITHOUT "
            "running it. Returns ok or a list of errors. Cheap — use freely."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"extraction": {"type": "object"}},
            "required": ["extraction"],
        },
    },
    {
        "name": "run_preview",
        "description": (
            "Run the REAL scraper with this config against the start URL, capped "
            "to 1 page and a few items, no persistence. Returns sample_records + "
            "diagnostics (links_discovered, extractor_hits, http_errors). Your "
            "ground-truth signal. Rate-limited per session."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "extraction": {"type": "object"},
                "start_url": {"type": "string"},
                "detail_url": {"type": "string"},
            },
            "required": ["extraction", "start_url"],
        },
    },
    {
        "name": "escalate_adapter",
        "description": (
            "Give up on selector-config for this site and request a generated "
            "Python adapter instead. Use ONLY when config demonstrably cannot "
            "work: previews return 0 records after trying all strategies, 0 "
            "detail links are found, the site returns 403/anti-bot, requires "
            "login, or the data lives only in a non-standard JS blob."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"reason": {"type": "string"}},
            "required": ["reason"],
        },
    },
    {
        "name": "finish",
        "description": (
            "Emit the final config once run_preview yields clean records. Include "
            "the output field schema you defined and a one-line summary."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "extraction": {"type": "object"},
                "output_schema": {"type": "array", "items": {"type": "string"}},
                "summary": {"type": "string"},
            },
            "required": ["extraction", "output_schema", "summary"],
        },
    },
]


def _system_prompt() -> str:
    presets = json.dumps(PRESETS, indent=1)
    return f"""You configure a config-driven web scraper. You NEVER write Python.

Your job: given a user's intent and a target site, author an `extraction` config \
that the scraper runs to extract one record per detail page. Verify every guess \
with run_preview before you finish.

## Config schema (mirror of the production Zod schema)
extraction = {{
  "link_discovery": one of:
     {{"mode":"sitemap", "sitemap_url":str, "href_includes":str?}}
   | {{"mode":"css", "link_selector":str, "href_includes":str?, "next_page_selector":str?, "max_pages":1-20}}
   | {{"mode":"category_seeds", "seed_urls":[str], "link_selector":str, "href_includes":str?, "max_pages":1-20}},
  "extractors": [ ordered, first non-null wins, 1-6 of:
      {{"type":"jsonld_product"}}            # schema.org Product JSON-LD
    | {{"type":"og_meta"}}                    # OpenGraph/product meta tags
    | {{"type":"css", "name_selector":str, "price_selector":str, "currency":"XYZ", "image_selector":str?, ...}}
    | {{"type":"fields", "fields":{{name:selectorExpr}}, "required_fields":[name]?}}   # GENERIC any-schema
  ],
  "user_agent":str?, "wait_for_selector":str?, "request_delay_ms":0-60000, "respect_robots":bool
}}

## Selector grammar for the `fields` extractor (split on the LAST '@')
  "h1.title"       -> inner_text of the first match
  "sel@text"       -> inner_text (explicit)
  "sel@html"       -> inner HTML
  "time@datetime"  -> value of the `datetime` attribute (any attr works)

## Rules
- Prefer jsonld_product / og_meta when the evidence shows they're present — they're the most robust.
- For NON-product intents (articles, listings, jobs, grants, events, ...) use the `fields` extractor with a field map that matches the user's requested output schema.
- Set required_fields to the fields that MUST be present for a row to count (usually the title/id-like ones).
- ALWAYS call run_preview and inspect its diagnostics before finish. A config is acceptable only when a preview returns >=3 clean records with diagnostics.links_discovered>0 and a non-zero extractor hit.
- If diagnostics show links_discovered==0, fix link_discovery. If links_discovered>0 but 0 records, fix the extractor/selectors.
- If the site is blocked (http_errors 403/429), needs login, or hides data in a bespoke JS blob, call escalate_adapter with a clear reason instead of guessing.
- Keep request_delay_ms >= 1000 and respect_robots true unless the user says otherwise.

## Worked examples
{presets}
"""


def _default_impl() -> dict[str, Callable]:
    return {
        "fetch_page": lambda url, kind: inspect_url(url, kind=kind),
        "propose_config": validate_extraction,
        "run_preview": run_preview,
    }


def _evidence_to_json(ev: Any) -> Any:
    if isinstance(ev, PageEvidence):
        return ev.to_prompt_json()
    return ev


def run_agent(
    intent: str,
    listing_url: str,
    *,
    detail_url: str = "",
    record_schema_hint: str = "",
    evidence: Any = None,
    provider: Any = None,
    max_turns: int = MAX_TURNS,
    max_previews: int = MAX_PREVIEWS,
    max_fetches: int = MAX_FETCHES,
    usd_hard_stop: float = USD_HARD_STOP,
    on_event: Callable[[str, str], None] | None = None,
    impl: dict[str, Callable] | None = None,
) -> AgentResult:
    """Drive the loop to a final config (or an adapter escalation).

    Provider-agnostic: pass any `provider` (see aiconfig.providers — Anthropic /
    OpenAI / Gemini / OpenAI-compatible); defaults to one built from the
    environment. Never raises for API/tool errors — those land in
    AgentResult.error / .incomplete.
    """
    impl = impl or _default_impl()
    result = AgentResult()

    def emit(status: str, text: str) -> None:
        result.transcript.append({"role": "agent", "status": status, "text": text})
        if on_event:
            try:
                on_event(status, text)
            except Exception:
                pass

    if provider is None:
        try:
            provider = default_provider_from_env()
        except ProviderError as e:
            result.error = str(e)
            result.incomplete = True
            return result

    system = _system_prompt()

    seed = {
        "intent": intent,
        "listing_url": listing_url,
        "detail_url": detail_url or None,
        "record_schema_hint": record_schema_hint or None,
        "listing_evidence": _evidence_to_json(evidence) if evidence else None,
    }
    # Provider-neutral conversation history (see aiconfig.providers.base).
    history: list[dict] = [{
        "role": "user",
        "text": (
            "Configure the scraper for this request. Inspect further with "
            "fetch_page if you need a detail page, then propose_config, "
            "run_preview, and finish.\n\n"
            + json.dumps(seed, indent=1)
        ),
    }]

    fetches = 0
    previews = 0
    best: dict | None = None          # the extraction that produced best_records
    best_records: list[dict] = []
    best_diag: dict = {}

    emit("inspecting", f"Inspecting {listing_url}")

    for turn in range(max_turns):
        result.turns_used = turn + 1
        # Cost hard-stop at the top so it applies on EVERY path (including the
        # no-tool-call nudge path) before another paid request is made.
        if result.cost_usd >= usd_hard_stop:
            result.incomplete = True
            result.error = f"cost hard-stop hit (${result.cost_usd:.2f})"
            break
        try:
            resp = provider.complete(system=system, tools=TOOLS, history=history)
        except ProviderError as e:
            result.error = str(e)
            result.incomplete = True
            break

        result.cost_usd += resp.cost_usd
        history.append({
            "role": "assistant",
            "text": resp.text,
            "tool_calls": resp.tool_calls,
        })
        if resp.text:
            emit("proposing_config", resp.text[:500])

        if not resp.tool_calls:
            # No tool call this turn (final text or a truncated response). Nudge
            # once, else give up. No orphan-tool concern — the provider always
            # pairs the assistant's tool calls with their results in history.
            if turn >= max_turns - 1:
                result.incomplete = True
                break
            history.append({
                "role": "user",
                "text": (
                    "You have not called finish or escalate_adapter yet. Run a "
                    "preview and then finish, or escalate."
                ),
            })
            continue

        tool_results: list[dict] = []
        stop_loop = False
        for tc in resp.tool_calls:
            name = tc.name
            args = tc.input or {}

            if name == "finish":
                result.path = "config"
                result.extraction = args.get("extraction")
                result.output_schema = args.get("output_schema") or derive_output_schema(
                    result.extraction
                )
                result.summary = str(args.get("summary") or "")
                # Only attach samples/diagnostics if the emitted config is the
                # one that was actually previewed — otherwise they'd misrepresent
                # an unverified config as verified.
                if best is not None and result.extraction == best:
                    result.sample_records = best_records
                    result.diagnostics = best_diag
                else:
                    result.sample_records = []
                    result.diagnostics = best_diag
                    if best_records:
                        result.summary += (
                            " (note: emitted config was not the previewed one; "
                            "sample records omitted)"
                        )
                emit("proposed", result.summary or "Config ready")
                stop_loop = True
                break

            if name == "escalate_adapter":
                result.path = "adapter"
                result.escalation_reason = str(args.get("reason") or "")
                result.diagnostics = best_diag
                emit("escalating_adapter", result.escalation_reason)
                stop_loop = True
                break

            content = _run_tool(
                name, args, impl,
                fetches, previews, max_fetches, max_previews,
            )
            # counters + best-so-far bookkeeping
            if name == "fetch_page":
                fetches += 1
                emit("inspecting", f"fetched {args.get('url','')}")
            elif name == "run_preview":
                previews += 1
                recs = content.get("sample_records", [])
                # Only track configs that ACTUALLY previewed records — never a
                # validation failure, a capped/errored preview (recs == []), or
                # an equal-length tie that would overwrite a real best with junk.
                if recs and (best is None or len(recs) > len(best_records)):
                    best = args.get("extraction")
                    best_records = recs
                    best_diag = content.get("diagnostics", {})
                emit("previewing",
                     f"preview #{previews}: {len(recs)} record(s)")

            tool_results.append({
                "id": tc.id,
                "name": name,
                "content": json.dumps(content)[:20000],
            })

        if stop_loop:
            break

        if tool_results:
            history.append({"role": "tool", "results": tool_results})

    # Exited without an explicit finish (ran out of turns, API error, cost stop,
    # or gave up): that's incomplete. Surface the best working preview if any.
    if result.extraction is None and result.path == "config":
        if best is not None:
            result.extraction = best
            result.output_schema = derive_output_schema(best)
            result.sample_records = best_records
            result.diagnostics = best_diag
        result.incomplete = True

    return result


def _run_tool(
    name: str,
    args: dict,
    impl: dict[str, Callable],
    fetches: int,
    previews: int,
    max_fetches: int,
    max_previews: int,
) -> dict:
    """Execute one tool call, enforcing caps. Returns a JSON-able dict."""
    try:
        if name == "fetch_page":
            if fetches >= max_fetches:
                return {"error": f"fetch limit reached ({max_fetches})"}
            ev = impl["fetch_page"](args.get("url", ""), args.get("kind", "detail"))
            return {"evidence": _evidence_to_json(ev)}

        if name == "propose_config":
            errs = impl["propose_config"](args.get("extraction"))
            return {"ok": not errs, "errors": errs}

        if name == "run_preview":
            if previews >= max_previews:
                return {"error": f"preview limit reached ({max_previews})"}
            errs = validate_extraction(args.get("extraction"))
            if errs:
                return {"ok": False, "errors": errs,
                        "hint": "fix these before previewing"}
            records, diagnostics = impl["run_preview"](
                args.get("extraction"),
                args.get("start_url", ""),
                args.get("detail_url", ""),
                max_items=PREVIEW_MAX_ITEMS,
            )
            return {
                "sample_records": records[:PREVIEW_MAX_ITEMS],
                "record_count": len(records),
                "diagnostics": diagnostics,
            }
    except Exception as e:  # noqa: BLE001 — tool errors are data, not crashes
        return {"error": f"{type(e).__name__}: {e}"}
    return {"error": f"unknown tool {name!r}"}
