"""Optional AI-assisted extraction (bring your own key).

If CLASSIFIEDS_AI_KEY (or ANTHROPIC_API_KEY) is set, adapters can call
`ai_extract_listing()` as a fallback when their structured extraction
comes back with missing required fields — e.g. after a site redesign.
Without a key everything still works; the fallback is simply skipped.

Uses the Anthropic Messages API directly over `requests` so no extra
dependency is needed.
"""

from __future__ import annotations

import json
import os
import re

import requests

API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# Fields the model is asked to fill. Keep in sync with models.Listing.
_SCHEMA_HINT = {
    "title": "listing title",
    "description": "full description text",
    "price_raw": "price as displayed, e.g. '3,500 OMR'",
    "price_value": "numeric price or null",
    "currency": "ISO currency code, e.g. OMR",
    "images": ["list of full-size image URLs"],
    "seller_name": "seller / poster name",
    "seller_phone": "seller phone number if visible, else empty string",
    "location": "city / area",
    "posted_at": "posting date, ISO-8601 if derivable",
    "attributes": {"make": "...", "model": "...", "year": "...", "kilometers": "..."},
}


def ai_key() -> str | None:
    return os.environ.get("CLASSIFIEDS_AI_KEY") or os.environ.get("ANTHROPIC_API_KEY")


def ai_enabled() -> bool:
    return bool(ai_key())


def _strip_html_noise(html: str, limit: int = 60_000) -> str:
    """Drop script/style/svg blocks and collapse whitespace so the page
    fits in a small prompt while keeping visible text and image URLs."""
    html = re.sub(r"(?is)<(script|style|svg|noscript|iframe)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?s)<!--.*?-->", " ", html)
    html = re.sub(r"[ \t]+", " ", html)
    html = re.sub(r"\n{3,}", "\n\n", html)
    return html[:limit]


def ai_extract_listing(page_html: str, url: str, *, model: str | None = None) -> dict | None:
    """Ask Claude to extract listing fields from raw page HTML.

    Returns the parsed dict, or None when no key is configured or the
    call/parse fails (callers must treat this as best-effort).
    """
    key = ai_key()
    if not key:
        return None
    model = model or os.environ.get("CLASSIFIEDS_AI_MODEL", DEFAULT_MODEL)
    prompt = (
        "Extract the classified-ad listing fields from this page as JSON "
        f"matching exactly this shape (use empty string / null / [] when absent):\n"
        f"{json.dumps(_SCHEMA_HINT, indent=1)}\n\n"
        f"Page URL: {url}\n\nPage HTML (noise-stripped):\n{_strip_html_noise(page_html)}\n\n"
        "Reply with ONLY the JSON object."
    )
    try:
        r = requests.post(
            API_URL,
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 2000,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=120,
        )
        r.raise_for_status()
        text = "".join(
            b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text"
        )
        m = re.search(r"\{.*\}", text, re.S)
        return json.loads(m.group(0)) if m else None
    except (requests.RequestException, ValueError, KeyError):
        return None


def merge_ai_fields(listing_dict: dict, ai_fields: dict) -> None:
    """Fill blanks in an adapter-built listing dict from an AI extraction.

    Adapter-extracted values always win; AI only fills gaps.
    """
    direct = ["title", "description", "price_raw", "currency", "location", "posted_at"]
    for k in direct:
        if not listing_dict.get(k) and ai_fields.get(k):
            listing_dict[k] = str(ai_fields[k])
    if listing_dict.get("price_value") is None and ai_fields.get("price_value") is not None:
        try:
            listing_dict["price_value"] = float(ai_fields["price_value"])
        except (TypeError, ValueError):
            pass
    if not listing_dict.get("images") and isinstance(ai_fields.get("images"), list):
        listing_dict["images"] = [str(u) for u in ai_fields["images"] if u]
    seller = listing_dict.setdefault("seller", {})
    if not seller.get("name") and ai_fields.get("seller_name"):
        seller["name"] = str(ai_fields["seller_name"])
    if not seller.get("phone") and ai_fields.get("seller_phone"):
        seller["phone"] = str(ai_fields["seller_phone"])
    if isinstance(ai_fields.get("attributes"), dict):
        attrs = listing_dict.setdefault("attributes", {})
        for k, v in ai_fields["attributes"].items():
            if v and k not in attrs:
                attrs[k] = str(v)
