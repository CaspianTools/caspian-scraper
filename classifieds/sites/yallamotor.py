"""YallaMotor Oman adapter (oman.yallamotor.com).

Unlike OpenSooq/Dubizzle this is a classic server-rendered site, so it is
scraped with plain HTTP (requests) — no browser needed. It is a strong
additional Oman source (~1,400+ used cars). Listing cards and detail pages
carry JSON-LD (schema.org Car/Product) plus predictable markup.

Phone is behind a "show number" action; where a JSON-LD `telephone` or an
inline Oman number is present we capture it, otherwise `seller.phone` is
left empty (the reveal is per-listing and not always machine-accessible).

Pure parsers are fixture-tested; the network path uses classifieds.http.
"""

from __future__ import annotations

import re
from typing import Iterator
from urllib.parse import urljoin

from .. import extract
from ..http import get, polite_session
from ..models import Listing, Seller
from .base import SearchSpec

KEY = "yallamotor"
LABEL = "YallaMotor Oman"
BASE = "https://oman.yallamotor.com"

_SUPPORTED_COUNTRIES = {"om"}
_USED_RE = re.compile(r"/used-cars/[a-z0-9-]+/[a-z0-9-]+(?:-\d+)?/?$", re.I)


def _search_url(spec: SearchSpec, page: int) -> str:
    if spec.city:
        url = f"{BASE}/used-cars/{spec.city.strip().lower().replace(' ', '-')}"
    else:
        url = f"{BASE}/used-cars"
    params = []
    if page > 1:
        params.append(f"page={page}")
    if spec.query:
        params.append(f"q={spec.query.replace(' ', '+')}")
    return url + ("?" + "&".join(params) if params else "")


def parse_search_html(html: str) -> list[dict]:
    """Return [{url}] for used-car detail links on a listing page."""
    urls = extract.links(html, BASE, _USED_RE)
    return [{"url": u, "listing_id": _id_from_url(u)} for u in urls]


def _id_from_url(url: str) -> str:
    m = re.search(r"-(\d+)/?$", url)
    return m.group(1) if m else ""


def parse_detail_html(html: str, url: str) -> Listing | None:
    car = None
    for block in extract.json_ld_blocks(html):
        if isinstance(block, dict) and block.get("@type") in ("Car", "Product", "Vehicle"):
            car = block
            break

    meta = extract.meta_tags(html)
    title = (car or {}).get("name") or meta.get("og:title") or ""
    if not title:
        return None

    offers = (car or {}).get("offers") or {}
    price = offers.get("price") if isinstance(offers, dict) else None
    price_raw = f"{price} OMR" if price else ""
    if not price:
        price = extract.parse_omr_price(extract.strip_tags(html))
        price_raw = meta.get("product:price:amount") or (f"{price} OMR" if price else "")

    images = []
    img = (car or {}).get("image")
    if isinstance(img, str):
        images = [img]
    elif isinstance(img, list):
        images = [i for i in img if isinstance(i, str)]
    if not images and meta.get("og:image"):
        images = [meta["og:image"]]
    if not images:
        images = extract.image_urls(html, BASE, contains="yallamotor")[:12]

    attrs: dict[str, str] = {}
    for key in ("brand", "model", "modelDate", "vehicleModelDate", "mileageFromOdometer",
                "fuelType", "vehicleTransmission", "color", "bodyType"):
        v = (car or {}).get(key)
        if isinstance(v, dict):
            v = v.get("name") or v.get("value")
        if v:
            attrs[key] = str(v)

    phone = ""
    tel = (car or {}).get("telephone") or (
        offers.get("seller", {}).get("telephone") if isinstance(offers, dict) else ""
    )
    if tel:
        phone = extract.find_oman_phone(str(tel)) or str(tel)

    return Listing(
        site=KEY,
        listing_id=_id_from_url(url),
        url=url,
        title=title,
        description=(car or {}).get("description") or meta.get("og:description") or "",
        price_raw=price_raw,
        price_value=_num(price),
        currency="OMR",
        images=images,
        location=extract.first_str(car or {}, "location") or "Oman",
        attributes=attrs,
        seller=Seller(phone=phone),
    )


def _num(v) -> float | None:
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


class YallaMotorAdapter:
    key = KEY
    label = LABEL

    def __init__(self, **_ignored):
        self.session = polite_session()

    def search(self, spec: SearchSpec) -> Iterator[Listing]:
        if spec.country not in _SUPPORTED_COUNTRIES:
            raise ValueError(f"{LABEL} adapter only covers Oman (om), got {spec.country!r}")
        emitted = 0
        page = 1
        while emitted < spec.max_listings and page <= 20:
            r = get(self.session, _search_url(spec, page), site=KEY)
            if not r.ok:
                break
            stubs = parse_search_html(r.text)
            if not stubs:
                break
            for stub in stubs:
                if emitted >= spec.max_listings:
                    break
                if spec.with_details:
                    dr = get(self.session, stub["url"], site=KEY)
                    if not dr.ok:
                        continue
                    listing = parse_detail_html(dr.text, stub["url"])
                    if listing is None:
                        continue
                else:
                    listing = Listing(site=KEY, listing_id=stub["listing_id"],
                                      url=stub["url"], currency="OMR")
                emitted += 1
                yield listing
            page += 1
