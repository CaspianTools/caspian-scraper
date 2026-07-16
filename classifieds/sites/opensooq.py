"""OpenSooq Oman adapter (om.opensooq.com).

OpenSooq's search page is a Next.js SSR page whose `__NEXT_DATA__` blob embeds
the full search API payload — `props.pageProps.serpApiResponse.listings.items[]`
— and each serp item already carries price, mileage, location, image, seller
and (masked) phone. We fetch that page over **plain HTTP** (not Playwright):
OpenSooq blocks headless-browser fingerprints (returns 0 results to them) while
serving the real serp JSON to an ordinary GET, and the serp is rich enough that
no per-listing detail fetch is needed. (Detail pages have since moved to the
App Router and no longer embed `__NEXT_DATA__`, so `parse_detail_html` is kept
only for the fallback/OG path and older captures.)

Phone: the serp exposes `phone_number` (masked) plus a `phone_reveal_key`.
There is no unauthenticated reveal, so we surface the masked value and the key.

Parsing is split into pure functions (parse_search_listings / parse_search_html
/ parse_detail_html) so they can be unit-tested against fixtures with no network.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Iterator
from urllib.parse import urljoin

from .. import extract
from ..ai import ai_enabled, ai_extract_listing, merge_ai_fields
from ..models import Listing, Seller
from .base import SearchSpec

KEY = "opensooq"
LABEL = "OpenSooq Oman"
BASE = "https://om.opensooq.com"
IMG_CDN = "https://opensooq-images.os-cdn.com/previews/0x720/"

_SUPPORTED_COUNTRIES = {"om"}


def _search_url(spec: SearchSpec, page: int) -> str:
    url = f"{BASE}/en/{spec.category}/cars-for-sale"
    params = []
    if page > 1:
        params.append(f"page={page}")
    if spec.query:
        params.append(f"search={spec.query.replace(' ', '+')}")
    return url + ("?" + "&".join(params) if params else "")


def _media_to_urls(media) -> list[str]:
    urls: list[str] = []
    if not isinstance(media, list):
        return urls
    for m in media:
        raw = m.get("uri") if isinstance(m, dict) else (m if isinstance(m, str) else "")
        if not raw:
            continue
        if raw.startswith("http"):
            urls.append(raw)
        else:
            clean = raw.lstrip("/")
            for suf in (".webp", ".jpg", ".jpeg", ".png"):
                if clean.endswith(suf):
                    clean = clean[: -len(suf)]
                    break
            urls.append(f"{IMG_CDN}{clean}.jpg.webp")
    return urls


def parse_search_html(html: str) -> list[dict]:
    """Return listing stubs: [{url, listing_id, title, price_raw, images}]."""
    data = extract.next_data(html)
    items: list = []
    if data:
        for node in extract.walk(data, {"items"}):
            cand = node["items"]
            if isinstance(cand, list) and cand and isinstance(cand[0], dict):
                if any(k in cand[0] for k in ("post_url", "listing_id", "title")):
                    items = cand
                    break
    stubs: list[dict] = []
    for it in items:
        post_url = it.get("post_url") or it.get("share_deeplink") or ""
        if not post_url:
            continue
        if not post_url.startswith("http"):
            # post_url may already carry a locale prefix ("/en/cars/...") or
            # be locale-less ("/cars/..."); normalize both to an absolute URL.
            post_url = urljoin(BASE + "/", post_url.lstrip("/")) if post_url.startswith("/en/") \
                else urljoin(BASE + "/en/", post_url.lstrip("/"))
        price = it.get("price")
        if isinstance(price, dict):
            price = price.get("price")
        stubs.append(
            {
                "url": post_url,
                "listing_id": str(it.get("listing_id") or it.get("cv_id") or ""),
                "title": it.get("title") or "",
                "price_raw": str(price or ""),
                "images": _media_to_urls(it.get("media") or [it.get("first_image_uri")]),
            }
        )
    return stubs


def _basic_info_attrs(listing: dict) -> dict[str, str]:
    attrs: dict[str, str] = {}
    sections = []
    if isinstance(listing.get("basic_info"), list):
        sections.append(listing["basic_info"])
    if isinstance(listing.get("dynamic_sections"), list):
        for sec in listing["dynamic_sections"]:
            fields = sec.get("fields") if isinstance(sec, dict) else None
            sections.append(fields if isinstance(fields, list) else sec)
    for section in sections:
        if not isinstance(section, list):
            continue
        for f in section:
            if not isinstance(f, dict):
                continue
            label = f.get("field_label") or f.get("field_name")
            value = f.get("option_label") or f.get("reporting_value_label")
            if label and value:
                attrs[str(label).strip().lower().replace(" ", "_")] = str(value).strip()
    return attrs


def parse_detail_html(html: str, url: str) -> Listing | None:
    data = extract.next_data(html)
    listing_d: dict | None = None
    seller_d: dict = {}
    if data:
        for node in extract.walk(data, {"listing"}):
            cand = node["listing"]
            if isinstance(cand, dict) and ("listing_id" in cand or "title" in cand):
                listing_d = cand
                seller_d = node.get("seller") if isinstance(node.get("seller"), dict) else {}
                break

    if listing_d is None:
        return _detail_from_meta(html, url)

    price = listing_d.get("price")
    if isinstance(price, dict):
        price_raw = str(price.get("price") or "")
    else:
        price_raw = str(price or listing_d.get("price_amount") or "")

    listing = Listing(
        site=KEY,
        listing_id=str(listing_d.get("listing_id") or ""),
        url=url,
        title=listing_d.get("title") or "",
        description=listing_d.get("masked_description") or listing_d.get("description") or "",
        price_raw=price_raw,
        price_value=extract.parse_omr_price(price_raw) or _num(price_raw),
        currency="OMR",
        images=_media_to_urls(listing_d.get("media") or []),
        location=listing_d.get("city_neighborhood")
        or ", ".join(x for x in [listing_d.get("city"), listing_d.get("neighborhood")] if x),
        posted_at=listing_d.get("publish_date") or listing_d.get("posted_date") or "",
        attributes=_basic_info_attrs(listing_d),
        seller=Seller(
            name=seller_d.get("full_name") or "",
            profile_url=seller_d.get("member_link") or "",
            phone=listing_d.get("masked_local_phone") or "",
            member_since=seller_d.get("member_since") or "",
        ),
        extras={
            "reveal_phone_key": listing_d.get("listing_reveal_phone_key") or "",
            "phone_masked": True,
            "vin": listing_d.get("vin_number") or "",
        },
    )
    if not listing.images:
        listing.images = _media_to_urls([listing_d.get("first_image_uri")])
    return listing


def _detail_from_meta(html: str, url: str) -> Listing | None:
    """Fallback when __NEXT_DATA__ is absent: OG tags + optional AI."""
    meta = extract.meta_tags(html)
    title = meta.get("og:title") or ""
    if not title:
        return None
    listing = Listing(
        site=KEY,
        listing_id="",
        url=url,
        title=title,
        description=meta.get("og:description") or "",
        images=[meta["og:image"]] if meta.get("og:image") else [],
        currency="OMR",
    )
    d = listing.to_dict()
    if ai_enabled():
        ai = ai_extract_listing(html, url)
        if ai:
            merge_ai_fields(d, ai)
            return _listing_from_dict(d)
    return listing


def _listing_from_dict(d: dict) -> Listing:
    seller = d.get("seller") or {}
    return Listing(
        site=KEY,
        listing_id=d.get("listing_id", ""),
        url=d["url"],
        title=d.get("title", ""),
        description=d.get("description", ""),
        price_raw=d.get("price_raw", ""),
        price_value=d.get("price_value"),
        currency=d.get("currency", "OMR"),
        images=d.get("images", []),
        location=d.get("location", ""),
        posted_at=d.get("posted_at", ""),
        attributes=d.get("attributes", {}),
        seller=Seller(**{k: seller.get(k, "") for k in ("name", "profile_url", "phone", "member_since")}),
    )


def _num(s: str) -> float | None:
    try:
        return float(str(s).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _title_attrs(title: str) -> dict[str, str]:
    """Best-effort year/make/model split from an OpenSooq title like
    '2021 Mazda 6 Luxe' -> {year: 2021, make: Mazda, model: 6 Luxe}."""
    attrs: dict[str, str] = {}
    toks = str(title).split()
    if toks and re.fullmatch(r"(19|20)\d{2}", toks[0]):
        attrs["year"] = toks[0]
        toks = toks[1:]
    if toks:
        attrs["make"] = toks[0]
        if len(toks) > 1:
            attrs["model"] = " ".join(toks[1:])
    return attrs


def _listing_from_serp(it: dict) -> Listing | None:
    """Build a full Listing from one search-result (serp) item. The OpenSooq
    search payload already carries price, mileage, location, image, seller and
    (masked) phone — so no detail-page fetch is needed."""
    post_url = str(it.get("post_url") or it.get("share_deep_link") or "")
    if not post_url:
        return None
    if not post_url.startswith("http"):
        # serp post_url may be locale-less ("/search/<id>") or already carry a
        # locale prefix ("/en/..."); normalize both without doubling "/en/".
        post_url = (
            urljoin(BASE + "/", post_url.lstrip("/"))
            if post_url.startswith("/en/")
            else urljoin(BASE + "/en/", post_url.lstrip("/"))
        )
    title = it.get("title") or it.get("secondary_title") or ""
    amount = it.get("price_amount")
    currency = it.get("price_currency_iso") or "OMR"
    # price_amount is already display-formatted (e.g. "5,400 OMR"); use it as-is
    # and parse the numeric value out of it.
    price_raw = str(amount) if amount not in (None, "") else ""
    price_value = extract.parse_omr_price(price_raw) or _num(price_raw)
    attrs = _title_attrs(title)
    km = it.get("kilometers_Cars_value_i")
    if km not in (None, ""):
        attrs["kilometers"] = str(km)
    images = _media_to_urls([it.get("image_uri")]) if it.get("image_uri") else []
    return Listing(
        site=KEY,
        listing_id=str(it.get("id") or it.get("listing_id") or ""),
        url=post_url,
        title=title,
        description=it.get("masked_description") or "",
        price_raw=price_raw,
        price_value=price_value,
        currency=currency,
        images=images,
        location=", ".join(
            x for x in [it.get("city_label"), it.get("nhood_label")] if x
        ),
        posted_at=str(it.get("posted_at") or it.get("inserted_date") or ""),
        attributes=attrs,
        seller=Seller(
            name=it.get("member_display_name") or it.get("member_user_name") or "",
            profile_url="",
            phone=str(it.get("phone_number") or ""),
            member_since="",
        ),
        extras={
            "reveal_phone_key": it.get("phone_reveal_key") or "",
            "phone_masked": bool(it.get("phone_number")),
        },
    )


def _serp_items(html: str) -> list[dict]:
    """Raw serp item dicts from the search page's __NEXT_DATA__."""
    data = extract.next_data(html)
    if not data:
        return []
    for node in extract.walk(data, {"items"}):
        cand = node["items"]
        if isinstance(cand, list) and cand and isinstance(cand[0], dict):
            if any(k in cand[0] for k in ("post_url", "id", "listing_id", "title")):
                return [it for it in cand if isinstance(it, dict)]
    return []


def parse_search_listings(html: str) -> list[Listing]:
    """Full Listings straight from the search serp items — no detail fetch."""
    out: list[Listing] = []
    for it in _serp_items(html):
        lst = _listing_from_serp(it)
        if lst is not None:
            out.append(lst)
    return out


def _inserted_date(it: dict):
    """The listing's creation date (day granularity), e.g. '2026-07-16'.
    `inserted_date` is the original post date; `posted_at` reflects bumps."""
    raw = str(it.get("inserted_date") or "").strip()[:10]
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Detail-page (App Router) full extraction
#
# OpenSooq listing pages moved to the Next.js App Router: no `__NEXT_DATA__`,
# but the server-streamed RSC payload (self.__next_f.push([...])) embeds the
# full spec table as {"label","value","fieldName"} objects plus the image
# gallery. We fetch over plain HTTP and mine those out.
# ---------------------------------------------------------------------------

# OpenSooq spec fieldName -> our clean attribute key.
_ATTR_KEYS = {
    "car_make": "make",
    "car_model": "model",
    "car_trim": "trim",
    "Car_Year": "year",
    "Kilometers_Cars": "kilometers",
    "Tramsmission_Cars": "transmission",
    "Fuel_Cars": "fuel",
    "Car_Color": "exterior_color",
    "Interior_Color": "interior_color",
    "Cars_body_types": "body_type",
    "Seats_Number": "seats",
    "Car_Engine_Size": "engine_size",
    "regional_specs": "regional_specs",
    "ConditionUsed": "condition",
    "body_condition": "body_condition",
    "CarLicense": "license",
    "CarInsurance": "insurance",
    "Payment_Method": "payment_method",
}
_FIELD_RE = re.compile(
    r'\{"label":"(?:[^"\\]|\\.)*","value":"((?:[^"\\]|\\.)*)"[^}]*?"fieldName":"([^"]*)"'
)
_IMG_RE = re.compile(
    r"https://opensooq-images\.os-cdn\.com/previews/([0-9]+)x([0-9]+)/"
    r"[0-9a-f]{2}/[0-9a-f]{2}/([0-9a-f]{16,})(?:\.[a-z]+)*"
)


def _rsc_payload(html: str) -> str:
    parts: list[str] = []
    for c in re.findall(r'self\.__next_f\.push\(\[\d+,("(?:[^"\\]|\\.)*")\]\)', html):
        try:
            parts.append(json.loads(c))
        except (ValueError, TypeError):
            pass
    return "".join(parts)


def _unesc(s: str) -> str:
    try:
        return json.loads('"' + s + '"')
    except ValueError:
        return s


def parse_detail_approuter(html: str) -> dict:
    """Best-effort full detail from an OpenSooq App-Router listing page:
    the mapped spec fields + the image gallery + the og description."""
    payload = _rsc_payload(html)
    attributes: dict[str, str] = {}
    for value, fname in _FIELD_RE.findall(payload):
        key = _ATTR_KEYS.get(fname)
        if key is None:
            continue
        val = _unesc(value)
        if not val or val.startswith(("Request ", "Show ", "Ask ")):
            continue
        attributes.setdefault(key, val)
    # image gallery: one URL per distinct image (keyed by content hash), at
    # the largest available size. Skip square crops (w == h) — those are shop
    # logos / avatars, not car photos.
    best: dict[str, tuple[int, str]] = {}
    for m in _IMG_RE.finditer(payload):
        w, h = int(m.group(1)), int(m.group(2))
        if w and h and w == h:
            continue
        hsh = m.group(3)
        size = max(w, h)
        if hsh not in best or size > best[hsh][0]:
            best[hsh] = (size, m.group(0))
    images = [u for _, u in best.values()]
    meta = extract.meta_tags(html)
    if not images and meta.get("og:image"):
        images = [meta["og:image"]]
    return {
        "attributes": attributes,
        "images": images,
        "description": meta.get("og:description") or "",
    }


def _enrich_from_detail(listing: Listing, html: str) -> None:
    """Fold full detail-page data into a serp-built Listing (detail wins for
    the structured specs; serp keeps price/location/seller)."""
    d = parse_detail_approuter(html)
    if d["images"]:
        listing.images = d["images"]
    if d["description"]:
        listing.description = d["description"]
    if d["attributes"]:
        listing.attributes.update(d["attributes"])


class OpenSooqAdapter:
    key = KEY
    label = LABEL

    def __init__(self, **_ignored):
        pass

    def search(self, spec: SearchSpec) -> Iterator[Listing]:
        if spec.country not in _SUPPORTED_COUNTRIES:
            raise ValueError(f"{LABEL} adapter only covers Oman (om), got {spec.country!r}")
        # Plain HTTP, not Playwright: OpenSooq serves the full search serp JSON
        # in the initial HTML but blocks headless-browser fingerprints (0
        # results). Detail pages (App Router) are also fetched over plain HTTP.
        from ..http import polite_session, get

        session = polite_session()
        today = datetime.now(timezone.utc).date()
        emitted = 0
        page = 1
        empty_streak = 0
        # A generous page cap; results are also bounded by max_listings and,
        # when a date window is set, by the early-stop below.
        while emitted < spec.max_listings and page <= 40:
            resp = get(session, _search_url(spec, page), site=KEY)
            items = _serp_items(resp.text or "")
            if not items:
                break
            in_window = 0
            for it in items:
                if emitted >= spec.max_listings:
                    break
                if spec.posted_within_days > 0:
                    d = _inserted_date(it)
                    # Skip listings created outside the window. Items with an
                    # unparseable date fall through (kept) rather than dropped.
                    if d is not None and (today - d).days >= spec.posted_within_days:
                        continue
                listing = _listing_from_serp(it)
                if listing is None:
                    continue
                in_window += 1
                if spec.with_details:
                    try:
                        dhtml = get(session, listing.url, site=KEY).text or ""
                        _enrich_from_detail(listing, dhtml)
                    except Exception:  # detail is best-effort; keep serp data
                        pass
                emitted += 1
                yield listing
            # The serp is sorted by recent activity, so once a couple of pages
            # yield nothing inside the date window we've paged past the fresh
            # listings — stop early instead of walking all 40 pages.
            if spec.posted_within_days > 0:
                empty_streak = empty_streak + 1 if in_window == 0 else 0
                if empty_streak >= 2:
                    break
            page += 1
