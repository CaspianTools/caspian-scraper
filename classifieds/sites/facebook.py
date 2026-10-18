"""Facebook Marketplace adapter — best-effort, cookie-gated.

Marketplace is login-walled, so this adapter REQUIRES a Facebook session:
pass --fb-cookies pointing at either a Playwright storage_state.json or a
cookie-editor export for .facebook.com (must include c_user and xs). With
no cookies the adapter raises a clear error and the CLI simply skips it
(it is excluded from --site all unless cookies are given).

Realistically extractable while logged in: title, price, images, location,
seller name, and (on the item page) description. Phone numbers are NOT
available — Facebook redacts them and routes contact through Messenger —
so `seller.phone` is always empty here. Treat this source as auxiliary and
inherently fragile: Facebook rotates its markup and GraphQL frequently.

Extraction reads listing data from the embedded JSON that Marketplace
ships in <script type="application/json"> tags; a DOM/OG fallback covers
redesigns. parse_item_json / parse_search_html are pure and fixture-tested.
"""

from __future__ import annotations

import json
import re
from typing import Iterator

from .. import extract
from ..models import Listing, Seller
from .base import SearchSpec

KEY = "facebook"
LABEL = "Facebook Marketplace"
BASE = "https://www.facebook.com"

_ITEM_RE = re.compile(r"/marketplace/item/(\d+)")
_JSON_SCRIPT_RE = re.compile(
    r'<script[^>]+type=["\']application/json["\'][^>]*>(.*?)</script>', re.S | re.I
)


def _city_slug(spec: SearchSpec) -> str:
    return (spec.city or "muscat").strip().lower().replace(" ", "")


def _search_url(spec: SearchSpec) -> str:
    slug = _city_slug(spec)
    if spec.query:
        q = spec.query.replace(" ", "%20")
        return f"{BASE}/marketplace/{slug}/search/?query={q}"
    return f"{BASE}/marketplace/{slug}/vehicles"


def item_url(item_id: str) -> str:
    return f"{BASE}/marketplace/item/{item_id}/"


def parse_search_html(html: str) -> list[dict]:
    """Return [{url, listing_id}] for marketplace items linked on the page."""
    seen: dict[str, dict] = {}
    for m in _ITEM_RE.finditer(html):
        lid = m.group(1)
        seen.setdefault(lid, {"url": item_url(lid), "listing_id": lid})
    return list(seen.values())


def _json_blobs(html: str) -> Iterator[dict]:
    for m in _JSON_SCRIPT_RE.finditer(html):
        try:
            yield json.loads(m.group(1))
        except ValueError:
            continue


def parse_item_json(html: str, url: str) -> Listing | None:
    """Extract a listing from a Marketplace item page.

    Looks through the embedded JSON for the marketplace_listing_ shape,
    then falls back to Open Graph tags.
    """
    lid = ""
    m = _ITEM_RE.search(url)
    if m:
        lid = m.group(1)

    for blob in _json_blobs(html):
        for node in extract.walk(blob, {"marketplace_listing_title"}):
            return _from_node(node, url, lid)
        for node in extract.walk(blob, {"listing_price"}):
            if node.get("marketplace_listing_title") or node.get("redacted_description"):
                return _from_node(node, url, lid)

    return _from_meta(html, url, lid)


def _from_node(node: dict, url: str, lid: str) -> Listing:
    price_node = node.get("listing_price") or {}
    price_raw = ""
    price_val = None
    if isinstance(price_node, dict):
        price_raw = price_node.get("formatted_amount") or ""
        amt = price_node.get("amount")
        try:
            price_val = float(amt) if amt is not None else None
        except (TypeError, ValueError):
            price_val = None

    desc = ""
    d = node.get("redacted_description") or node.get("description")
    if isinstance(d, dict):
        desc = d.get("text") or ""
    elif isinstance(d, str):
        desc = d

    photos = node.get("listing_photos") or node.get("photos") or []
    images = []
    for p in photos:
        if isinstance(p, dict):
            img = p.get("image") or {}
            uri = img.get("uri") if isinstance(img, dict) else None
            if uri:
                images.append(uri)

    loc = node.get("location_text") or {}
    location = loc.get("text") if isinstance(loc, dict) else (loc if isinstance(loc, str) else "")

    seller_node = node.get("marketplace_listing_seller") or node.get("story_seller") or {}
    seller_name = seller_node.get("name") if isinstance(seller_node, dict) else ""

    return Listing(
        site=KEY,
        listing_id=str(node.get("id") or lid),
        url=url,
        title=node.get("marketplace_listing_title") or "",
        description=desc,
        price_raw=price_raw,
        price_value=price_val,
        currency=(price_node.get("currency") if isinstance(price_node, dict) else "") or "",
        images=images,
        location=location or "",
        seller=Seller(name=seller_name or ""),  # phone never available on FB
        extras={"contact_via": "messenger", "phone_available": False},
    )


def _from_meta(html: str, url: str, lid: str) -> Listing | None:
    meta = extract.meta_tags(html)
    if not meta.get("og:title"):
        return None
    return Listing(
        site=KEY, listing_id=lid, url=url,
        title=meta["og:title"], description=meta.get("og:description") or "",
        images=[meta["og:image"]] if meta.get("og:image") else [],
        seller=Seller(),
        extras={"contact_via": "messenger", "phone_available": False},
    )


class FacebookAdapter:
    key = KEY
    label = LABEL

    def __init__(self, *, fb_cookies: str = "", **_ignored):
        self.cookies = fb_cookies

    def search(self, spec: SearchSpec) -> Iterator[Listing]:
        if not self.cookies:
            raise ValueError(
                "Facebook Marketplace requires a session: pass --fb-cookies "
                "<storage_state.json or cookie-editor export with c_user + xs>."
            )
        from ..browser import browser_context, fetch_html

        emitted = 0
        with browser_context(cookies_path=self.cookies) as ctx:
            page = ctx.new_page()
            try:
                page.goto(_search_url(spec), wait_until="domcontentloaded")
                # Lazy grid: scroll to pull in more items.
                for _ in range(min(spec.max_listings // 8 + 2, 12)):
                    if "login" in page.url or "checkpoint" in page.url:
                        raise RuntimeError(
                            "Facebook redirected to login/checkpoint — cookies invalid or expired."
                        )
                    page.mouse.wheel(0, 3000)
                    page.wait_for_timeout(1500)
                html = page.content()
            finally:
                page.close()

            stubs = parse_search_html(html)
            for stub in stubs:
                if emitted >= spec.max_listings:
                    break
                if spec.with_details:
                    ihtml = fetch_html(ctx, stub["url"])
                    listing = parse_item_json(ihtml, stub["url"])
                    if listing is None:
                        continue
                else:
                    listing = Listing(site=KEY, listing_id=stub["listing_id"],
                                      url=stub["url"], seller=Seller(),
                                      extras={"phone_available": False})
                emitted += 1
                yield listing
