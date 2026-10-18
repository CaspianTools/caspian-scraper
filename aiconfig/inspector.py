"""Site inspector: turn a page into deterministic `PageEvidence` for the AI.

Split into a PURE core (`build_evidence_from_html`, regex/JSON only — unit-tested
over fixture strings) and a LIVE layer (`inspect_url`, opens a real browser and
enriches per-field candidates with actual query_selector match counts). No LLM.
"""

from __future__ import annotations

import contextlib
import os
import re
from urllib.parse import urlparse

from classifieds import extract
from classifieds.ai import _strip_html_noise

from .evidence import FieldCandidate, PageEvidence, RepeatedBlock

# Ranked selector guesses per semantic field. The live layer probes these and
# keeps the ones that actually match; the AI picks from what survived.
_FIELD_PROBES: dict[str, list[str]] = {
    "title": [
        "h1", "h1.title", "h1.headline", "[itemprop='name']",
        ".product-title", ".product-name", "article h1",
    ],
    "price": [
        "[itemprop='price']", ".price", ".product-price", "[data-price]",
        ".amount", ".price-value",
    ],
    "date": [
        "time[datetime]", "time", "[itemprop='datePublished']",
        ".published", ".date", ".post-date",
    ],
    "author": [
        "[rel='author']", "[itemprop='author']", ".author", ".byline",
        ".post-author",
    ],
    "image": [
        "img[itemprop='image']", ".product-image img", "article img",
        ".post-image img", "img",
    ],
    "description": [
        "[itemprop='description']", ".description", ".product-description",
        "article .content", ".content", ".post-content",
    ],
}

_NEXT_PAGE_PROBES = [
    "a[rel='next']",
    "link[rel='next']",
    "[aria-label*='Next' i]",
    ".pagination a.next",
    "a.next",
    "a[href*='page=']",
    "button[aria-label*='Next' i]",
]

_OG_PREFIXES = ("og:", "product:", "twitter:", "article:")


def _css_href_selector(href_includes: str) -> str:
    """Build a valid a[href*=...] selector, quoting/escaping so a path with an
    apostrophe (e.g. /o'reilly/) doesn't yield a syntactically invalid selector."""
    if "'" not in href_includes:
        return f"a[href*='{href_includes}']"
    if '"' not in href_includes:
        return f'a[href*="{href_includes}"]'
    escaped = href_includes.replace("\\", "\\\\").replace("'", "\\'")
    return f"a[href*='{escaped}']"


def _jsonld_types(blocks: list) -> list[str]:
    out: list[str] = []

    def collect(node):
        if isinstance(node, dict):
            t = node.get("@type")
            if isinstance(t, str):
                out.append(t)
            elif isinstance(t, list):
                out.extend(str(x) for x in t)
            if isinstance(node.get("@graph"), list):
                for n in node["@graph"]:
                    collect(n)

    for b in blocks:
        collect(b)
    # de-dup, order-preserving
    seen: set[str] = set()
    return [t for t in out if not (t in seen or seen.add(t))]


def _find_product_node(blocks: list) -> dict | None:
    def is_product(node) -> bool:
        if not isinstance(node, dict):
            return False
        t = node.get("@type")
        if isinstance(t, str):
            return t.lower() == "product"
        if isinstance(t, list):
            return any(isinstance(x, str) and x.lower() == "product" for x in t)
        return False

    for b in blocks:
        if is_product(b):
            return b
        if isinstance(b, dict) and isinstance(b.get("@graph"), list):
            for n in b["@graph"]:
                if is_product(n):
                    return n
    return None


def _prune_jsonld(node: dict, *, limit: int = 1500) -> dict:
    """Keep the interesting product-ish keys, truncate long values."""
    keep = (
        "@type", "name", "brand", "sku", "gtin", "gtin13", "image",
        "offers", "price", "priceCurrency", "availability", "description",
        "datePublished", "author", "headline",
    )
    out: dict = {}
    for k in keep:
        if k in node:
            v = node[k]
            if isinstance(v, str) and len(v) > limit:
                v = v[:limit]
            out[k] = v
    return out


def _detect_currency(product_node: dict | None, og: dict[str, str]) -> str:
    if isinstance(product_node, dict):
        offers = product_node.get("offers")
        if isinstance(offers, dict):
            cur = offers.get("priceCurrency")
            if isinstance(cur, str) and len(cur) == 3:
                return cur.upper()
        if isinstance(offers, list) and offers and isinstance(offers[0], dict):
            cur = offers[0].get("priceCurrency")
            if isinstance(cur, str) and len(cur) == 3:
                return cur.upper()
    cur = og.get("product:price:currency") or og.get("og:price:currency") or ""
    return cur.upper() if len(cur) == 3 else ""


def _detect_repeated_blocks(html: str, base_url: str) -> list[RepeatedBlock]:
    """Group same-shaped hrefs (digit runs collapsed) to find the listing grid."""
    hrefs = extract.links(html, base_url, re.compile("."))
    groups: dict[str, list[str]] = {}
    for h in hrefs:
        path = urlparse(h).path
        if not path or path == "/":
            continue
        template = re.sub(r"\d+", "#", path)
        groups.setdefault(template, []).append(h)

    blocks: list[RepeatedBlock] = []
    for _template, items in groups.items():
        if len(items) < 3:
            continue
        paths = [urlparse(h).path for h in items]
        # A shared, digit-free path substring the whole group matches. Take the
        # common prefix, trim to the last '/', and — crucially — never the
        # digit-collapsed template (its '#' can't appear in a real href).
        common = os.path.commonprefix(paths)
        if "/" in common[1:]:
            common = common[: common.rindex("/") + 1]
        if len(common.strip("/")) >= 1:
            href_includes = common
        else:
            seg = paths[0].strip("/").split("/")[0]
            href_includes = f"/{seg}/" if seg else paths[0]
        blocks.append(
            RepeatedBlock(
                link_selector=_css_href_selector(href_includes),
                href_includes=href_includes,
                count=len(items),
                sample_hrefs=items[:5],
            )
        )
    blocks.sort(key=lambda b: b.count, reverse=True)
    return blocks[:10]


def build_evidence_from_html(html: str, url: str) -> PageEvidence:
    """PURE: everything derivable from the HTML string alone (no browser)."""
    ev = PageEvidence(url=url, final_url=url)

    m = re.search(r"<title[^>]*>([^<]*)</title>", html, re.I)
    if m:
        ev.title = m.group(1).strip()[:200]

    nd = extract.next_data(html)
    if nd is not None:
        ev.has_next_data = True
        page_props = {}
        if isinstance(nd, dict):
            props = nd.get("props")
            if isinstance(props, dict) and isinstance(props.get("pageProps"), dict):
                page_props = props["pageProps"]
        ev.next_data_keys = sorted(list(page_props.keys()))[:40] if page_props else (
            sorted(list(nd.keys()))[:40] if isinstance(nd, dict) else []
        )

    blocks = extract.json_ld_blocks(html)
    if blocks:
        ev.jsonld_types = _jsonld_types(blocks)
        product = _find_product_node(blocks)
        if product:
            ev.jsonld_product_present = True
            ev.jsonld_sample = _prune_jsonld(product)

    og_all = extract.meta_tags(html)
    ev.og_meta = {
        k: v for k, v in og_all.items() if k.startswith(_OG_PREFIXES)
    }

    ev.detected_currency = _detect_currency(ev.jsonld_sample, ev.og_meta)
    ev.repeated_blocks = _detect_repeated_blocks(html, url)
    ev.html_excerpt = _strip_html_noise(html, limit=6000)
    return ev


def _probe_field_candidates(page) -> dict[str, list[FieldCandidate]]:
    out: dict[str, list[FieldCandidate]] = {}
    for field_name, selectors in _FIELD_PROBES.items():
        cands: list[FieldCandidate] = []
        for sel in selectors:
            try:
                els = page.query_selector_all(sel)
            except Exception:
                continue
            if not els:
                continue
            sample = ""
            try:
                first = els[0]
                if field_name == "date":
                    sample = (first.get_attribute("datetime") or "").strip()
                if field_name == "image":
                    sample = (
                        first.get_attribute("src")
                        or first.get_attribute("data-src")
                        or ""
                    ).strip()
                if not sample:
                    sample = (first.inner_text() or "").strip()
            except Exception:
                sample = ""
            selector = sel
            if field_name == "date" and sel in ("time[datetime]", "time"):
                selector = "time@datetime"
            elif field_name == "image":
                selector = f"{sel}@src"
            cands.append(
                FieldCandidate(
                    selector=selector,
                    match_count=len(els),
                    sample_text=sample[:120],
                    source="css",
                )
            )
        if cands:
            out[field_name] = cands
    return out


def _probe_next_page(page) -> list[str]:
    found: list[str] = []
    for sel in _NEXT_PAGE_PROBES:
        try:
            if page.query_selector(sel):
                found.append(sel)
        except Exception:
            continue
    return found


def inspect_url(
    url: str, *, wait_selector: str = "", kind: str = "listing"
) -> PageEvidence:
    """LIVE: navigate `url` with a real browser, build pure evidence from the
    rendered HTML, then enrich with live query_selector match counts + notes.
    Reuses classifieds.browser.browser_context so anti-bot/UA handling matches
    the real scraper. Never raises — failures land in evidence.notes."""
    from classifieds.browser import browser_context

    try:
        with browser_context() as context:
            page = context.new_page()
            status = 0
            try:
                resp = page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                status = resp.status if resp is not None else 0
            except Exception as e:
                ev = PageEvidence(url=url, final_url=url)
                ev.notes.append(f"navigation failed: {type(e).__name__}: {e}")
                return ev
            if wait_selector:
                with contextlib.suppress(Exception):
                    page.wait_for_selector(wait_selector, timeout=15_000)
            else:
                with contextlib.suppress(Exception):
                    page.wait_for_load_state("networkidle", timeout=15_000)

            html = page.content()
            ev = build_evidence_from_html(html, url)
            ev.final_url = page.url
            ev.http_status = status
            if status and status >= 400:
                ev.notes.append(
                    f"HTTP {status} — likely anti-bot/blocked; selectors "
                    "cannot be trusted and previews will fail"
                )
            if "login" in page.url.lower() or "signin" in page.url.lower():
                ev.notes.append("redirected to a login/sign-in page")
            ev.field_candidates = _probe_field_candidates(page)
            ev.next_page_candidates = _probe_next_page(page)
            page.close()
            return ev
    except Exception as e:
        ev = PageEvidence(url=url, final_url=url)
        ev.notes.append(f"inspector error: {type(e).__name__}: {e}")
        return ev
