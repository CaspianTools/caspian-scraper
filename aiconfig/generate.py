"""Generate a Python adapter for a hard site with Claude.

Single-shot (no tools): the prompt carries the Adapter contract, the toolkit
surface, one real exemplar adapter, the target record schema, and captured
search+detail HTML. Claude returns the adapter module, a pure-function unit
test, and the two HTML fixtures. Everything then goes through aiconfig.validate
(AST gate first) before a human ever sees it — this module never executes what
it produces.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import llm

_REPO = Path(__file__).resolve().parents[1]


def _read(rel: str, limit: int = 12000) -> str:
    try:
        return (_REPO / rel).read_text(encoding="utf-8")[:limit]
    except OSError:
        return ""


def _toolkit_surface() -> str:
    return (
        "classifieds.http:  polite_session(extra_headers=None)->Session; "
        "get(session,url,*,site,timeout=30)->Response; throttle(site)\n"
        "classifieds.extract:  json_ld_blocks(html)->list; next_data(html)->dict|None; "
        "meta_tags(html)->dict; walk(node,want:set)->iter dicts; first_str(d,*keys)->str; "
        "strip_tags(html)->str; links(html,base,pattern)->list; image_urls(html,base)->list; "
        "parse_omr_price(text)->float|None; find_oman_phone(text)->str\n"
        "classifieds.browser:  browser_context(*,cookies_path='',locale='en-US') ctx-mgr; "
        "fetch_html(context,url,*,wait_selector='')->str\n"
        "adapters.base:  FetchSpec(start_urls,record_schema,max_records,query,country,city); "
        "spec.required_fields()->list[str]"
    )


_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,58}[a-z0-9]$")


def _valid_key(key: str) -> bool:
    return bool(_KEY_RE.match(key or ""))


def _prompt(
    *, intent: str, url: str, key: str, record_schema: list[dict],
    search_html: str, detail_html: str,
) -> str:
    exemplar = _read("classifieds/sites/yallamotor.py")
    base = _read("adapters/base.py", limit=4000)
    fields = ", ".join(
        f"{f.get('name')}:{f.get('type','string')}"
        f"{'*' if f.get('required') else ''}" for f in record_schema
    )
    return f"""Write a Python site adapter for the caspian-scraper generic \
scraper. The site can't be handled by selector-config, so it needs code.

## Hard rules (a static AST gate REJECTS violations before anything runs)
- Import ONLY from: __future__, re, json, typing, dataclasses, urllib.parse, html, \
datetime, adapters.base, classifieds.extract, classifieds.http, classifieds.browser, \
classifieds.models, classifieds.ai. NOTHING else — no os, sys, subprocess, socket, \
requests, urllib.request, importlib, pathlib.
- No eval/exec/compile/__import__/open/getattr/setattr, no dunder attribute access \
(__class__/__globals__/__subclasses__...). Do all networking through classifieds.http \
or classifieds.browser only.
- Split logic into PURE functions parse_search_html(html, base_url)->list[str] and \
parse_detail_html(html, url)->dict so they unit-test off fixtures with no network.
- Expose a top-level `ADAPTER` instance implementing the Adapter protocol.
- The TEST is ALSO run through the AST gate, so it must obey the SAME import \
rules. It may additionally import the adapter module (adapters.{key}). To read \
the fixtures it MUST use `from adapters.base import read_fixture` and \
`read_fixture("{key}_search.html")` / `read_fixture("{key}_detail.html")` — it \
may NOT use pathlib, open, or __file__.

## Adapter contract (adapters/base.py)
{base}

## Toolkit you may call
{_toolkit_surface()}

## Exemplar adapter (classifieds/sites/yallamotor.py — plain HTTP + JSON-LD)
{exemplar}

## Target
intent: {intent}
adapter key (module stem): {key}
start url: {url}
record_schema fields (name:type, * = required): {fields}
Each yielded record must be {{"url": <detail url>, "data": {{<field>: <value>, ...}}}} \
matching the schema.

## Captured SEARCH page HTML (truncated)
{search_html[:9000]}

## Captured DETAIL page HTML (truncated)
{detail_html[:9000]}

Return ONLY a JSON object (no prose, no markdown fences) with these string keys:
{{"adapter_key": "{key}",
  "adapter_py": "<full contents of adapters/{key}.py>",
  "test_py": "<full contents of tests/test_{key}.py — pure parse_* over the fixtures below, no network>",
  "search_fixture": "<the search HTML to save as tests/fixtures/generic/{key}_search.html>",
  "detail_fixture": "<the detail HTML to save as tests/fixtures/generic/{key}_detail.html>"}}
The test must import the adapter module (adapters/{key}.py) and call \
parse_search_html / parse_detail_html on the fixtures loaded via \
read_fixture(...), asserting on the extracted fields. No network, no pathlib, no \
open."""


def generate_adapter(
    *,
    intent: str,
    url: str,
    key: str,
    record_schema: list[dict],
    search_html: str,
    detail_html: str,
    model: str | None = None,
) -> dict:
    """Return {adapter_key, adapter_py, test_py, search_fixture, detail_fixture}.
    Raises llm.LLMError on API failure or ValueError on an unparseable/invalid
    response. Does NOT write or execute anything."""
    if not _valid_key(key):
        raise ValueError(f"invalid adapter key {key!r} (need ^[a-z][a-z0-9_]+[a-z0-9]$)")
    model = model or llm.REASONER_MODEL
    prompt = _prompt(
        intent=intent, url=url, key=key, record_schema=record_schema,
        search_html=search_html, detail_html=detail_html,
    )
    resp = llm.messages_create(
        model=model,
        system="You are a careful Python engineer. Output only the requested JSON.",
        tools=[],
        messages=[{"role": "user", "content": prompt}],
        max_tokens=8000,
    )
    text = llm.text_blocks(resp)
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("model did not return a JSON object")
    try:
        obj = json.loads(m.group(0))
    except ValueError as e:
        raise ValueError(f"unparseable JSON from model: {e}") from e
    for req in ("adapter_py", "test_py", "search_fixture", "detail_fixture"):
        if not isinstance(obj.get(req), str) or not obj[req].strip():
            raise ValueError(f"model response missing '{req}'")
    obj["adapter_key"] = key
    return obj
