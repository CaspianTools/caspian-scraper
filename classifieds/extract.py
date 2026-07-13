"""Site-agnostic extraction helpers.

Adapters layer these: structured data first (JSON-LD, __NEXT_DATA__),
then Open Graph tags, then regex heuristics. The goal is that a site
redesign degrades extraction instead of breaking it — and the optional
AI fallback (classifieds.ai) can fill whatever still comes back blank.
"""

from __future__ import annotations

import html as html_mod
import json
import re
from typing import Any, Iterator
from urllib.parse import urljoin

# --------------------------------------------------------------- JSON blobs

_JSONLD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.S | re.I,
)
_NEXT_DATA_RE = re.compile(
    r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', re.S | re.I
)


def json_ld_blocks(page_html: str) -> list[Any]:
    out: list[Any] = []
    for m in _JSONLD_RE.finditer(page_html):
        try:
            data = json.loads(m.group(1).strip())
        except ValueError:
            continue
        out.extend(data if isinstance(data, list) else [data])
    return out


def next_data(page_html: str) -> dict | None:
    m = _NEXT_DATA_RE.search(page_html)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


def walk(node: Any, want: set[str], _depth: int = 0) -> Iterator[dict]:
    """Yield every dict anywhere under `node` containing all keys in `want`."""
    if _depth > 30:
        return
    if isinstance(node, dict):
        if want <= node.keys():
            yield node
        for v in node.values():
            yield from walk(v, want, _depth + 1)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v, want, _depth + 1)


def first_str(d: dict, *keys: str) -> str:
    """First non-empty string value among `keys` (dotted paths allowed)."""
    for k in keys:
        v: Any = d
        for part in k.split("."):
            if isinstance(v, dict):
                v = v.get(part)
            else:
                v = None
                break
        if isinstance(v, (int, float)):
            v = str(v)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""

# ------------------------------------------------------------------ og/meta

_META_RE = re.compile(
    r'<meta[^>]+(?:property|name)=["\']([^"\']+)["\'][^>]+content=["\']([^"\']*)["\']'
    r'|<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']([^"\']+)["\']',
    re.I,
)


def meta_tags(page_html: str) -> dict[str, str]:
    tags: dict[str, str] = {}
    for m in _META_RE.finditer(page_html):
        key = m.group(1) or m.group(4)
        val = m.group(2) if m.group(1) else m.group(3)
        if key and key not in tags:
            tags[key] = html_mod.unescape(val or "")
    return tags

# --------------------------------------------------------------- heuristics

# "3,500 OMR" / "OMR 3500" / "ر.ع. 3,500" / "3500 ريال"
_PRICE_RE = re.compile(
    r"(?:OMR|ر\.?\s?ع\.?|ريال)\s*([\d,.]+)|([\d,.]+)\s*(?:OMR|ر\.?\s?ع\.?|ريال)",
    re.I,
)


def parse_omr_price(text: str) -> float | None:
    m = _PRICE_RE.search(text or "")
    if not m:
        return None
    raw = (m.group(1) or m.group(2)).replace(",", "").rstrip(".")
    try:
        return float(raw)
    except ValueError:
        return None


# Oman mobiles are 8 digits starting 7 or 9, optionally +968-prefixed.
_PHONE_RE = re.compile(r"(?:\+?968[\s-]?)?([79]\d{3})[\s-]?(\d{4})\b")


def find_oman_phone(text: str) -> str:
    m = _PHONE_RE.search(text or "")
    return f"+968{m.group(1)}{m.group(2)}" if m else ""


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")


def strip_tags(fragment: str) -> str:
    text = _TAG_RE.sub(" ", fragment or "")
    text = html_mod.unescape(text)
    text = _WS_RE.sub(" ", text)
    return re.sub(r"\s*\n\s*", "\n", text).strip()


_HREF_RE = re.compile(r'<a[^>]+href=["\']([^"\'#]+)["\']', re.I)


def links(page_html: str, base_url: str, pattern: re.Pattern) -> list[str]:
    """Absolute hrefs on the page whose *absolute* form matches `pattern`,
    de-duplicated in document order."""
    seen: set[str] = set()
    out: list[str] = []
    for m in _HREF_RE.finditer(page_html):
        url = urljoin(base_url, html_mod.unescape(m.group(1)))
        if pattern.search(url) and url not in seen:
            seen.add(url)
            out.append(url)
    return out


_IMG_RE = re.compile(r'<img[^>]+(?:data-src|src)=["\']([^"\']+)["\']', re.I)


def image_urls(page_html: str, base_url: str, *, contains: str = "") -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for m in _IMG_RE.finditer(page_html):
        url = urljoin(base_url, html_mod.unescape(m.group(1)))
        if url.startswith("data:") or (contains and contains not in url):
            continue
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out
