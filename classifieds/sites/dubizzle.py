"""Dubizzle Oman adapter (dubizzle.com.om, formerly OLX Oman).

HTML pages are Cloudflare-gated Next.js, so we render with Playwright and
read the `__NEXT_DATA__` blob. Unlike OpenSooq, Dubizzle exposes a real
phone-reveal endpoint that needs no auth:

    GET https://www.dubizzle.com.om/api/listing/<listingId>/contactInfo/
    -> {"mobile": "...", "whatsapp": "..."}

<listingId> is the numeric ID in the ad URL (`-ID<digits>.html`). We call
it (via the browser's request context, so it inherits the cf_clearance
cookie) to fill the seller phone.

Pure parsers (parse_search_html / parse_detail_html) are unit-tested
against fixtures; the network live-path is exercised in CI.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Iterator
from urllib.parse import quote, urljoin

from .. import extract
from ..models import Listing, Seller
from .base import SearchSpec

KEY = "dubizzle"
LABEL = "Dubizzle Oman"
BASE = "https://www.dubizzle.com.om"
IMG_CDN = "https://images.dubizzle.com.om/thumbnails/"
IMG_SIZE = "800x600"

_SUPPORTED_COUNTRIES = {"om"}
_AD_RE = re.compile(r"(?:/[a-z]{2})?/ad/[^\"'\s]*-ID(\d+)\.html", re.I)

# Dubizzle serves the full results as a JSON blob in `window.state` (Algolia
# hits). Each hit carries title, price (extraFields.price), a rich English
# spec table (formattedExtraFields), the photo gallery, location, description,
# seller name and a Unix `createdAt` — everything a listing needs. The seller
# phone comes from the public, unauthenticated contactInfo API.

# Dubizzle formattedExtraFields `attribute` -> our clean key.
_DZ_ATTR = {
    "make": "make", "model": "model", "year": "year",
    "mileage": "kilometers", "transmission": "transmission",
    "petrol": "fuel", "color": "color", "body_type": "body_type",
    "seats": "seats", "new_used": "condition", "interior": "interior",
    "doors": "doors", "source": "regional_specs", "owners": "owners",
    "has_warranty": "warranty",
}


def _search_url(spec: SearchSpec, page: int) -> str:
    url = f"{BASE}/en/vehicles/cars-for-sale/"
    params = []
    if page > 1:
        params.append(f"page={page}")
    if spec.query:
        params.append(f"q={spec.query.replace(' ', '%20')}")
    return url + ("?" + "&".join(params) if params else "")


def listing_id_from_url(url: str) -> str:
    m = _AD_RE.search(url)
    return m.group(1) if m else ""


def parse_search_html(html: str) -> list[dict]:
    """Return [{url, listing_id}] for each ad linked on the results page.

    Primary path: hrefs matching the ad-URL pattern (present whether the
    grid comes from __NEXT_DATA__ hydration or server HTML). Falls back to
    scanning __NEXT_DATA__ for absolute_url fields.
    """
    stubs: dict[str, dict] = {}
    for m in _AD_RE.finditer(html):
        url = urljoin(BASE, m.group(0))
        lid = m.group(1)
        stubs.setdefault(lid, {"url": url, "listing_id": lid})

    if not stubs:
        data = extract.next_data(html)
        if data:
            for node in extract.walk(data, {"absolute_url"}):
                raw = node["absolute_url"]
                url = raw.get("en") if isinstance(raw, dict) else raw
                if isinstance(url, str) and "-ID" in url:
                    lid = listing_id_from_url(url)
                    if lid:
                        stubs.setdefault(lid, {"url": urljoin(BASE, url), "listing_id": lid})
    return list(stubs.values())


def _images_from_next(node: dict) -> list[str]:
    urls: list[str] = []
    photos = node.get("photos") or node.get("images") or node.get("media")
    if isinstance(photos, list):
        for p in photos:
            if isinstance(p, str):
                urls.append(p if p.startswith("http") else f"{IMG_CDN}{p}-800x600.jpeg")
            elif isinstance(p, dict):
                u = p.get("url") or p.get("full") or p.get("main") or p.get("id")
                if isinstance(u, str):
                    urls.append(u if u.startswith("http") else f"{IMG_CDN}{u}-800x600.jpeg")
    return urls


def _localized(v):
    if isinstance(v, dict):
        return v.get("en") or v.get("value") or next(iter(v.values()), "")
    return v


def parse_detail_html(html: str, url: str) -> Listing | None:
    data = extract.next_data(html)
    node: dict | None = None
    if data:
        # The ad object carries a numeric price and a name/title.
        for cand in extract.walk(data, {"price"}):
            if any(k in cand for k in ("name", "title", "description")):
                node = cand
                break

    if node is None:
        # JSON-LD Product/Vehicle fallback, then OG tags.
        for block in extract.json_ld_blocks(html):
            if isinstance(block, dict) and block.get("@type") in (
                "Product", "Vehicle", "Car", "Offer"
            ):
                return _from_json_ld(block, url)
        return _from_meta(html, url)

    title = _localized(node.get("name")) or _localized(node.get("title")) or ""
    desc = _localized(node.get("description")) or ""
    price = node.get("price")
    price_val = float(price) if isinstance(price, (int, float)) else extract.parse_omr_price(str(price))
    details = node.get("details") if isinstance(node.get("details"), dict) else {}
    attrs = {}
    for k, v in {**node, **details}.items():
        if k in ("make", "model", "year", "kilometers", "mileage", "fuel_type",
                 "transmission", "body_type", "color") and v:
            attrs[k] = str(_localized(v))

    seller_node = node.get("seller") or node.get("user") or {}
    listing = Listing(
        site=KEY,
        listing_id=str(node.get("id") or node.get("objectID") or listing_id_from_url(url)),
        url=url,
        title=title,
        description=extract.strip_tags(desc) if "<" in desc else desc,
        price_raw=f"{price_val:g} OMR" if price_val else str(price or ""),
        price_value=price_val,
        currency="OMR",
        images=_images_from_next(node),
        location=_localized(node.get("location")) or _localized(node.get("city")) or "",
        posted_at=str(node.get("created_at") or node.get("posted_at") or ""),
        attributes=attrs,
        seller=Seller(
            name=_localized(seller_node.get("name")) if isinstance(seller_node, dict) else "",
            profile_url=(seller_node.get("profile_url") or "") if isinstance(seller_node, dict) else "",
        ),
    )
    return listing


def parse_contact_info(payload: str | dict) -> dict[str, str]:
    data = json.loads(payload) if isinstance(payload, str) else payload
    if not isinstance(data, dict):
        return {}
    inner = data.get("data") if isinstance(data.get("data"), dict) else data
    return {
        "mobile": str(inner.get("mobile") or inner.get("phone") or ""),
        "whatsapp": str(inner.get("whatsapp") or ""),
    }


def _from_json_ld(block: dict, url: str) -> Listing:
    offers = block.get("offers") or {}
    price = offers.get("price") if isinstance(offers, dict) else None
    images = block.get("image")
    if isinstance(images, str):
        images = [images]
    return Listing(
        site=KEY, listing_id=listing_id_from_url(url), url=url,
        title=block.get("name") or "", description=block.get("description") or "",
        price_raw=str(price or ""), price_value=_num(price),
        currency=(offers.get("priceCurrency") if isinstance(offers, dict) else "") or "OMR",
        images=list(images or []),
        seller=Seller(),
    )


def _from_meta(html: str, url: str) -> Listing | None:
    meta = extract.meta_tags(html)
    if not meta.get("og:title"):
        return None
    return Listing(
        site=KEY, listing_id=listing_id_from_url(url), url=url,
        title=meta["og:title"], description=meta.get("og:description") or "",
        images=[meta["og:image"]] if meta.get("og:image") else [],
        currency="OMR", seller=Seller(),
    )


def _num(v) -> float | None:
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _window_state(html: str) -> dict | None:
    """Parse the `window.state = {...}` JSON blob (Algolia results + config)."""
    m = re.search(r"window\.state\s*=\s*", html)
    if not m:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(html, m.end())
        return obj if isinstance(obj, dict) else None
    except (ValueError, TypeError):
        return None


def _hits(html: str) -> list[dict]:
    """The listing hits array from window.state (first list of dicts whose
    items carry an objectID)."""
    state = _window_state(html)
    if not state:
        return []
    found: list[dict] = []

    def walk(node, depth=0):
        nonlocal found
        if found or depth > 12:
            return
        if (
            isinstance(node, list)
            and node
            and isinstance(node[0], dict)
            and any(isinstance(x, dict) and "objectID" in x for x in node[:3])
        ):
            found = [x for x in node if isinstance(x, dict)]
            return
        if isinstance(node, dict):
            for v in node.values():
                walk(v, depth + 1)
        elif isinstance(node, list):
            for v in node[:6]:
                walk(v, depth + 1)

    walk(state)
    return found


def _dz_created_date(hit: dict):
    ts = hit.get("createdAt") or hit.get("timestamp")
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).date()
    except (TypeError, ValueError, OSError):
        return None


def _dz_images(hit: dict) -> list[str]:
    photos = hit.get("photos")
    if not isinstance(photos, list) or not photos:
        cp = hit.get("coverPhoto")
        photos = [cp] if isinstance(cp, dict) else []
    out: list[str] = []
    for ph in photos:
        pid = ph.get("id") if isinstance(ph, dict) else None
        if pid is not None:
            out.append(f"{IMG_CDN}{pid}-{IMG_SIZE}.jpeg")
    return out


def _dz_location(hit: dict) -> str:
    loc = hit.get("location")
    if isinstance(loc, list):
        names = [
            str(x.get("name"))
            for x in loc
            if isinstance(x, dict) and x.get("level", 0) >= 1 and x.get("name")
        ]
        return ", ".join(reversed(names)) if names else ""
    return ""


def listing_from_hit(hit: dict) -> Listing | None:
    """Build a full Listing from one Dubizzle search hit — no detail fetch."""
    # externalID is the public ad ID used in the URL and the contactInfo API;
    # `id`/`objectID` are the Algolia-internal index ids (they 404 the API).
    lid = str(hit.get("externalID") or hit.get("id") or hit.get("objectID") or "")
    if not lid:
        return None
    slug = str(hit.get("slug") or "")
    url = f"{BASE}/en/ad/{quote(slug)}-ID{lid}.html" if slug else f"{BASE}/en/ad/-ID{lid}.html"
    amount = (hit.get("extraFields") or {}).get("price")
    attrs: dict[str, str] = {}
    price_raw = ""
    for f in hit.get("formattedExtraFields") or []:
        if not isinstance(f, dict):
            continue
        val = f.get("formattedValue_l1") or f.get("formattedValue") or ""
        if f.get("attribute") == "price":
            price_raw = str(val)
            continue
        key = _DZ_ATTR.get(f.get("attribute")) or f.get("attribute")
        if key and val:
            attrs.setdefault(str(key), str(val).strip())
    d = _dz_created_date(hit)
    contact = hit.get("contactInfo") if isinstance(hit.get("contactInfo"), dict) else {}
    return Listing(
        site=KEY,
        listing_id=lid,
        url=url,
        title=str(hit.get("title") or ""),
        description=str(hit.get("description") or ""),
        price_raw=(f"{price_raw} OMR" if price_raw else (f"{amount} OMR" if amount else "")),
        price_value=_num(amount),
        currency="OMR",
        images=_dz_images(hit),
        location=_dz_location(hit),
        posted_at=(d.isoformat() if d else ""),
        attributes=attrs,
        seller=Seller(name=str(contact.get("name") or "")),
    )


class DubizzleAdapter:
    key = KEY
    label = LABEL

    def __init__(self, **_ignored):
        pass

    def search(self, spec: SearchSpec) -> Iterator[Listing]:
        if spec.country not in _SUPPORTED_COUNTRIES:
            raise ValueError(f"{LABEL} adapter only covers Oman (om), got {spec.country!r}")
        # Plain HTTP: Dubizzle serves the full results JSON in window.state.
        from ..http import polite_session, get

        session = polite_session()
        today = datetime.now(timezone.utc).date()
        emitted = 0
        page = 1
        empty_streak = 0
        while emitted < spec.max_listings and page <= 40:
            r = get(session, _search_url(spec, page), site=KEY)
            hits = _hits(r.text or "")
            if not hits:
                break
            in_window = 0
            for hit in hits:
                if emitted >= spec.max_listings:
                    break
                if spec.posted_within_days > 0:
                    d = _dz_created_date(hit)
                    if d is not None and (today - d).days >= spec.posted_within_days:
                        continue
                listing = listing_from_hit(hit)
                if listing is None:
                    continue
                in_window += 1
                if spec.with_details:
                    self._reveal_phone(session, listing)
                emitted += 1
                yield listing
            if spec.posted_within_days > 0:
                empty_streak = empty_streak + 1 if in_window == 0 else 0
                if empty_streak >= 2:
                    break
            page += 1

    def _reveal_phone(self, session, listing: Listing) -> None:
        # Dubizzle's contactInfo API is public + unauthenticated (no masking to
        # circumvent) and returns the seller's number the site itself serves.
        lid = listing.listing_id
        if not lid:
            return
        try:
            from ..http import get
            r = get(
                session,
                f"{BASE}/api/listing/{lid}/contactInfo/",
                site=KEY,
                headers={"Accept": "application/json"},
            )
            info = parse_contact_info(r.text)
            if info.get("mobile"):
                listing.seller.phone = info["mobile"]
            if info.get("whatsapp"):
                listing.extras["whatsapp"] = info["whatsapp"]
        except Exception:
            pass
