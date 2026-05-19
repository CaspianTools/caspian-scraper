#!/usr/bin/env python3
"""
Multi-project scraper.

Reads project / source / destination / secret configuration from
Firestore (the `caspian-tools` / `scraper` named database) and writes
run results, per-source lessons, and published items back to the same
database.

Triggered by GitHub Actions every 15 minutes (schedule_cron match
across enabled projects) and on demand via workflow_dispatch with an
optional `project_id` input.

Required environment variables:
  GOOGLE_APPLICATION_CREDENTIALS_JSON
      The Firebase Admin SDK service-account JSON (whole file as a
      string). Set as the FIREBASE_ADMIN_SA_JSON repo secret.
  FIRESTORE_DATABASE_ID
      Name of the Firestore database (e.g. "scraper"). Omit for the
      project default.

Optional environment variables:
  ONLY_PROJECT_ID    Run only this project (for workflow_dispatch).
  DRY_RUN            "true" / "1" / "yes" → skip every POST and skip
                     writing /published; still writes /runs + /lessons
                     so the dashboard reflects what *would* have run.
  MAX_PROJECTS_PER_TICK   Default 10. Caps how many projects this
                          invocation will process.
  PER_PROJECT_TIMEOUT_SECONDS   Default 300. Per-project soft budget
                                (checked between sources).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol
from urllib.parse import urljoin

import bleach
import requests
from croniter import croniter
from playwright.sync_api import (
    Page,
    TimeoutError as PWTimeout,
    sync_playwright,
)

from google.cloud import firestore as gcf
from google.cloud.firestore_v1 import (
    FieldFilter,
    Increment,
    SERVER_TIMESTAMP,
)
from google.oauth2 import service_account


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

RATE_LIMIT_FLOOR = 10
DEFAULT_MAX_PROJECTS_PER_TICK = 10
DEFAULT_PER_PROJECT_TIMEOUT_S = 300

# HTML sanitization allow-lists for description content. Anything outside
# these is stripped (scripts, styles, inline handlers, javascript: URLs).
ALLOWED_HTML_TAGS = {
    "p", "br", "hr",
    "ul", "ol", "li",
    "strong", "b", "em", "i", "u",
    "h2", "h3", "h4", "h5", "h6",
    "a",
}
ALLOWED_HTML_ATTRS = {"a": ["href", "rel", "title"]}

# Default "posted_by" UID for entirelysafe-style destinations that need
# an attribution field. Override per destination via field_map.
DEFAULT_POSTED_BY = "zFuwetFo6HhHVG9hXmPt28wQFRA2"

HSE_KEYWORDS = [
    "hse", "hsse", "ehs", "qhse", "sheq",
    "safety", "health and safety", "health & safety",
    "safety engineer", "safety officer", "safety manager", "safety specialist",
    "environmental health", "occupational health",
    "loss prevention",
    "field compliance",
    "field safety",
]

EMPLOYMENT_TYPE_MAP: list[tuple[str, str]] = [
    ("full time", "full-time"),
    ("full-time", "full-time"),
    ("permanent", "full-time"),
    ("part time", "part-time"),
    ("part-time", "part-time"),
    ("contract", "contract"),
    ("contractor", "contract"),
    ("fixed term", "contract"),
    ("temporary", "temporary"),
    ("temp", "temporary"),
]

# Country-name → ISO-2 code (lowercase). Longest names match first in
# infer_country() so "united states" beats "states".
COUNTRY_NAME_TO_CODE: dict[str, str] = {
    "united states": "us", "usa": "us", "u.s.": "us", "u.s.a.": "us",
    "united kingdom": "gb", "uk": "gb", "england": "gb", "scotland": "gb",
    "wales": "gb", "northern ireland": "gb",
    "united arab emirates": "ae", "uae": "ae",
    "saudi arabia": "sa", "ksa": "sa",
    "azerbaijan": "az", "kazakhstan": "kz", "qatar": "qa", "oman": "om",
    "kuwait": "kw", "iraq": "iq", "iran": "ir", "egypt": "eg", "norway": "no",
    "canada": "ca", "australia": "au", "india": "in", "malaysia": "my",
    "singapore": "sg", "indonesia": "id", "nigeria": "ng", "germany": "de",
    "france": "fr", "italy": "it", "spain": "es", "netherlands": "nl",
    "belgium": "be", "switzerland": "ch", "denmark": "dk", "sweden": "se",
    "finland": "fi", "ireland": "ie", "portugal": "pt", "poland": "pl",
    "turkey": "tr", "greece": "gr", "russia": "ru", "ukraine": "ua",
    "china": "cn", "japan": "jp", "south korea": "kr", "korea": "kr",
    "thailand": "th", "vietnam": "vn", "philippines": "ph", "pakistan": "pk",
    "bangladesh": "bd", "south africa": "za", "kenya": "ke", "ghana": "gh",
    "morocco": "ma", "algeria": "dz", "tunisia": "tn", "libya": "ly",
    "mexico": "mx", "brazil": "br", "argentina": "ar", "chile": "cl",
    "colombia": "co", "peru": "pe", "venezuela": "ve", "ecuador": "ec",
    "trinidad and tobago": "tt", "trinidad": "tt",
    "new zealand": "nz", "papua new guinea": "pg",
    "georgia": "ge", "armenia": "am", "uzbekistan": "uz", "turkmenistan": "tm",
    "tajikistan": "tj", "kyrgyzstan": "kg",
    "bahrain": "bh", "jordan": "jo", "lebanon": "lb", "syria": "sy",
    "yemen": "ye", "afghanistan": "af",
    "angola": "ao", "mozambique": "mz", "tanzania": "tz", "uganda": "ug",
    "ethiopia": "et", "senegal": "sn", "ivory coast": "ci", "cote d'ivoire": "ci",
    "guyana": "gy", "suriname": "sr",
}
_COUNTRY_NAMES_BY_LENGTH: list[str] = sorted(COUNTRY_NAME_TO_CODE, key=len, reverse=True)

CITY_TO_COUNTRY: dict[str, str] = {
    "dhahran": "sa", "riyadh": "sa", "al-khobar": "sa", "khobar": "sa",
    "jeddah": "sa", "yanbu": "sa", "jubail": "sa", "tabuk": "sa",
    "abu dhabi": "ae", "dubai": "ae", "sharjah": "ae", "ruwais": "ae",
    "ras laffan": "qa", "mesaieed": "qa", "doha": "qa", "lusail": "qa",
    "al-shaheen": "qa", "al shaheen": "qa", "idd el-shargi": "qa",
    "muscat": "om", "sohar": "om",
    "manama": "bh",
    "kuwait city": "kw", "ahmadi": "kw",
    "basra": "iq", "baghdad": "iq", "erbil": "iq", "kurdistan": "iq",
    "tehran": "ir",
    "stavanger": "no", "bergen": "no", "trondheim": "no", "oslo": "no",
    "aberdeen": "gb", "london": "gb", "great yarmouth": "gb",
    "amsterdam": "nl", "rotterdam": "nl", "the hague": "nl",
    "houston": "us", "midland": "us", "odessa": "us", "denver": "us",
    "anchorage": "us", "new orleans": "us", "lafayette": "us",
    "calgary": "ca", "edmonton": "ca", "fort mcmurray": "ca",
    "halifax": "ca", "st. john's": "ca", "st johns": "ca",
    "baku": "az",
    "atyrau": "kz", "almaty": "kz", "astana": "kz", "aktau": "kz",
    "perth": "au", "brisbane": "au", "darwin": "au", "melbourne": "au",
    "kuala lumpur": "my", "miri": "my", "bintulu": "my",
    "jakarta": "id", "balikpapan": "id",
    "mumbai": "in", "chennai": "in", "new delhi": "in",
    "lagos": "ng", "abuja": "ng", "port harcourt": "ng",
    "cairo": "eg", "alexandria": "eg",
    "paris": "fr", "pau": "fr",
    "milan": "it", "rome": "it",
    "madrid": "es", "barcelona": "es",
    "moscow": "ru", "saint petersburg": "ru", "sakhalin": "ru",
    "istanbul": "tr",
    "mexico city": "mx", "ciudad del carmen": "mx", "villahermosa": "mx",
    "rio de janeiro": "br", "macae": "br",
    "neuquen": "ar", "neuquén": "ar",
    "bogota": "co", "barranquilla": "co",
    "paramaribo": "sr",
    "georgetown": "gy",
}
_CITY_NAMES_BY_LENGTH: list[str] = sorted(CITY_TO_COUNTRY, key=len, reverse=True)


# ---------------------------------------------------------------------------
# Domain types and pure helpers (preserved from the legacy single-tenant
# implementation; no Firestore dependency)
# ---------------------------------------------------------------------------

@dataclass
class Role:
    employer: str
    title: str
    location: str = ""
    country: str = ""                # ISO-2 code, lowercase (e.g. "us")
    description: str = ""           # HTML preferred
    application_url: str = ""
    employment_type: str = "full-time"
    closing_date: str = ""           # ISO YYYY-MM-DD if known


@dataclass
class ProductListing:
    retailer_id: str
    retailer_name: str
    product_url: str
    name: str
    brand: str = ""
    gtin: str | None = None
    size_value: float | None = None
    size_unit: str = ""              # "L", "ml", "kg", "g", "ea"
    price_value: float = 0.0
    price_currency: str = "AED"     # ISO 4217
    unit_price_value: float | None = None
    unit_price_basis: str = ""       # e.g. "per kg"
    in_stock: bool | None = None
    image_url: str = ""
    raw_jsonld: dict = field(default_factory=dict)


def listing_id_for(retailer_id: str, product_url: str) -> str:
    """Deterministic listing ID — sha1 of retailer + URL. Stable across runs."""
    h = hashlib.sha1(f"{retailer_id}|{product_url}".encode("utf-8")).hexdigest()
    return h[:32]


# Unit conversion table for unit-price normalisation. Values are the
# factor to multiply size_value by to get the canonical unit. Pairs of
# (input_unit, canonical_unit, factor). Canonical bases:
#   mass    → kg  (so price-per-kg is the basis)
#   volume  → L   (so price-per-L is the basis)
#   count   → ea  (per-unit)
_UNIT_NORMALISE: dict[str, tuple[str, float]] = {
    # mass
    "kg": ("kg", 1.0), "kilogram": ("kg", 1.0), "kilograms": ("kg", 1.0),
    "g":  ("kg", 0.001), "gram": ("kg", 0.001), "grams": ("kg", 0.001),
    "mg": ("kg", 1e-6), "milligram": ("kg", 1e-6),
    # volume
    "l": ("L", 1.0), "litre": ("L", 1.0), "liter": ("L", 1.0),
    "litres": ("L", 1.0), "liters": ("L", 1.0),
    "ml": ("L", 0.001), "millilitre": ("L", 0.001), "milliliter": ("L", 0.001),
    "cl": ("L", 0.01), "centilitre": ("L", 0.01),
    # count
    "ea": ("ea", 1.0), "each": ("ea", 1.0), "unit": ("ea", 1.0),
    "pcs": ("ea", 1.0), "piece": ("ea", 1.0), "pieces": ("ea", 1.0),
}


def compute_unit_price(
    price: float, size_value: float | None, size_unit: str
) -> tuple[float | None, str]:
    """Return (unit_price, basis_string) or (None, '') if not normalisable."""
    if not size_value or size_value <= 0 or price <= 0:
        return (None, "")
    norm = _UNIT_NORMALISE.get(size_unit.strip().lower())
    if not norm:
        return (None, "")
    canonical_unit, factor = norm
    canonical_size = size_value * factor
    if canonical_size <= 0:
        return (None, "")
    return (price / canonical_size, f"per {canonical_unit}")


def is_hse(*texts: str) -> bool:
    blob = " ".join(t.lower() for t in texts if t)
    return any(k in blob for k in HSE_KEYWORDS)


def infer_employment_type(*texts: str) -> str:
    blob = " ".join(t.lower() for t in texts if t)
    for needle, value in EMPLOYMENT_TYPE_MAP:
        if needle in blob:
            return value
    return "full-time"


def infer_country(*texts: str) -> str:
    blob = " ".join(t.lower() for t in texts if t)
    for name in _COUNTRY_NAMES_BY_LENGTH:
        if name in blob:
            return COUNTRY_NAME_TO_CODE[name]
    for city in _CITY_NAMES_BY_LENGTH:
        if city in blob:
            return CITY_TO_COUNTRY[city]
    return ""


def make_slug(title: str, company: str) -> str:
    raw = f"{title}-{company}".lower()
    raw = re.sub(r"[^a-z0-9]+", "-", raw)
    return raw.strip("-")


_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|noscript|iframe)\b[^>]*>.*?</\1\s*>",
    re.IGNORECASE | re.DOTALL,
)


def sanitize_description(html_or_text: str) -> str:
    """Strip <script>/<style>/inline-handlers and unknown tags before publishing."""
    if not html_or_text:
        return ""
    cleaned = _SCRIPT_STYLE_RE.sub("", html_or_text)
    return bleach.clean(
        cleaned,
        tags=ALLOWED_HTML_TAGS,
        attributes=ALLOWED_HTML_ATTRS,
        strip=True,
        strip_comments=True,
    )


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Parser registry (preserved from the legacy implementation — parsers don't
# care whether config comes from JSON or Firestore)
# ---------------------------------------------------------------------------

class ScrapeTimeoutError(RuntimeError):
    """Raised when a parser can't load a search page."""


class Parser(Protocol):
    def __init__(self, page: Page) -> None: ...
    def parse(self, employer_name: str, search_url: str) -> list[Role]: ...


class BaseHtmlParser:
    LIST_LINK_SELECTORS: list[str] = []
    DETAIL_TITLE_SELECTORS: list[str] = []
    DETAIL_LOCATION_SELECTORS: list[str] = []
    DETAIL_DESCRIPTION_SELECTORS: list[str] = []
    NEXT_PAGE_SELECTORS: list[str] = []
    DETAIL_HREF_RE: "re.Pattern[str] | None" = None

    SEARCH_GOTO_TIMEOUT_MS = 45_000
    SEARCH_SELECTOR_TIMEOUT_MS = 8_000
    DETAIL_GOTO_TIMEOUT_MS = 30_000
    DETAIL_SELECTOR_TIMEOUT_MS = 6_000

    def __init__(self, page: Page) -> None:
        self.page = page

    @staticmethod
    def _first_text(scope, selectors: list[str]) -> str:
        for sel in selectors:
            try:
                el = scope.query_selector(sel)
            except Exception:
                continue
            if not el:
                continue
            try:
                txt = (el.inner_text() or "").strip()
            except Exception:
                continue
            if txt:
                return txt
        return ""

    @staticmethod
    def _first_html(scope, selectors: list[str]) -> str:
        for sel in selectors:
            try:
                el = scope.query_selector(sel)
            except Exception:
                continue
            if not el:
                continue
            try:
                html = (el.inner_html() or "").strip()
            except Exception:
                continue
            if html:
                return html
        return ""

    def _goto_search(self, search_url: str) -> None:
        try:
            self.page.goto(
                search_url,
                wait_until="domcontentloaded",
                timeout=self.SEARCH_GOTO_TIMEOUT_MS,
            )
        except PWTimeout as e:
            raise ScrapeTimeoutError(
                f"search page timed out: {search_url}"
            ) from e
        if self.LIST_LINK_SELECTORS:
            try:
                self.page.wait_for_selector(
                    ", ".join(self.LIST_LINK_SELECTORS),
                    timeout=self.SEARCH_SELECTOR_TIMEOUT_MS,
                )
            except PWTimeout:
                pass

    def _gather_links(self, search_url: str) -> list[str]:
        out: list[str] = []
        for sel in self.LIST_LINK_SELECTORS:
            try:
                els = self.page.query_selector_all(sel)
            except Exception:
                els = []
            if not els:
                continue
            for el in els:
                try:
                    href = el.get_attribute("href") or ""
                except Exception:
                    href = ""
                if not href:
                    continue
                if self.DETAIL_HREF_RE and not self.DETAIL_HREF_RE.search(href):
                    continue
                out.append(urljoin(search_url, href))
            if out:
                break
        return out

    def _click_next(self) -> bool:
        for sel in self.NEXT_PAGE_SELECTORS:
            try:
                nxt = self.page.query_selector(sel)
            except Exception:
                nxt = None
            if not nxt:
                continue
            try:
                nxt.click()
                self.page.wait_for_load_state("networkidle", timeout=20000)
                return True
            except Exception:
                continue
        return False

    def collect_links(self, search_url: str, max_pages: int = 5) -> list[str]:
        self._goto_search(search_url)
        seen: list[str] = []
        for page_idx in range(max_pages):
            page_links = self._gather_links(search_url)
            if not page_links:
                print(
                    f"no list-link selector matched on {self.page.url} "
                    f"(page index {page_idx})",
                    file=sys.stderr,
                )
            for link in page_links:
                if link not in seen:
                    seen.append(link)
            if not self._click_next():
                break
        return seen

    def parse_detail(self, employer: str, url: str) -> Role | None:
        try:
            self.page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=self.DETAIL_GOTO_TIMEOUT_MS,
            )
        except PWTimeout:
            print(f"timeout loading detail {url}", file=sys.stderr)
            return None
        except Exception as e:
            print(
                f"error loading detail {url}: {type(e).__name__}: {e}",
                file=sys.stderr,
            )
            return None

        if self.DETAIL_TITLE_SELECTORS:
            try:
                self.page.wait_for_selector(
                    ", ".join(self.DETAIL_TITLE_SELECTORS),
                    timeout=self.DETAIL_SELECTOR_TIMEOUT_MS,
                )
            except PWTimeout:
                pass

        title = self._first_text(self.page, self.DETAIL_TITLE_SELECTORS)
        if not title:
            print(f"no title selector matched on {url}", file=sys.stderr)
            return None

        if not is_hse(title):
            return None

        location = self._first_text(self.page, self.DETAIL_LOCATION_SELECTORS)
        description_html = self._first_html(self.page, self.DETAIL_DESCRIPTION_SELECTORS)
        description_text = self._first_text(self.page, self.DETAIL_DESCRIPTION_SELECTORS)
        if not description_html and not description_text:
            print(f"no description selector matched on {url}", file=sys.stderr)

        return Role(
            employer=employer,
            title=title,
            location=location,
            country=infer_country(location, description_text),
            description=description_html or description_text,
            application_url=url,
            employment_type=infer_employment_type(title, description_text),
        )

    def parse(self, employer_name: str, search_url: str) -> list[Role]:
        roles: list[Role] = []
        for link in self.collect_links(search_url):
            try:
                role = self.parse_detail(employer_name, link)
            except Exception as e:
                print(
                    f"error parsing detail {link}: {type(e).__name__}: {e}",
                    file=sys.stderr,
                )
                continue
            if role:
                roles.append(role)
        return roles


class SuccessFactorsParser(BaseHtmlParser):
    LIST_LINK_SELECTORS = [
        "a.jobTitle-link",
        "a[data-careersite-propertyid='title']",
        "a[href*='/job/']",
    ]
    DETAIL_TITLE_SELECTORS = [
        "h1.jobTitle",
        "[data-careersite-propertyid='title']",
        "h1",
    ]
    DETAIL_LOCATION_SELECTORS = [
        "span.jobGeoLocation",
        "[data-careersite-propertyid='location']",
        "span[itemprop='jobLocation']",
    ]
    DETAIL_DESCRIPTION_SELECTORS = [
        ".jobdescription",
        "[data-careersite-propertyid='jobdescription']",
        "div[itemprop='description']",
        "main",
    ]
    NEXT_PAGE_SELECTORS = [
        "a[aria-label='Next']",
        "a.paginationNextLink",
        "li.next > a",
    ]


class JibeParser(BaseHtmlParser):
    LIST_LINK_SELECTORS = [
        "a[href*='/jobs/'][href*='lang=']",
        "a.job-tile-link",
        "a[data-job-id]",
    ]
    DETAIL_TITLE_SELECTORS = [
        "h1.job-title",
        "h1[itemprop='title']",
        "h1",
    ]
    DETAIL_LOCATION_SELECTORS = [
        "[itemprop='jobLocation']",
        "span.job-location",
        "[class*='location' i]",
    ]
    DETAIL_DESCRIPTION_SELECTORS = [
        "div[itemprop='description']",
        "div.job-description",
        "[class*='description' i]",
        "main",
    ]
    NEXT_PAGE_SELECTORS = [
        "a[rel='next']",
        "a[aria-label='Next']",
        "button[aria-label='Next']",
    ]
    DETAIL_HREF_RE = re.compile(r"/jobs/\d+")

    def collect_links(self, search_url: str, max_pages: int = 5) -> list[str]:
        self._goto_search(search_url)
        seen: list[str] = []

        prev_count = -1
        for _ in range(3):
            for link in self._gather_links(search_url):
                if link not in seen:
                    seen.append(link)
            if len(seen) == prev_count:
                break
            prev_count = len(seen)
            try:
                self.page.evaluate(
                    "window.scrollTo(0, document.body.scrollHeight)"
                )
                self.page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                break

        for _ in range(max_pages - 1):
            if not self._click_next():
                break
            for link in self._gather_links(search_url):
                if link not in seen:
                    seen.append(link)

        if not seen:
            print(
                f"no list-link selector matched on {self.page.url}",
                file=sys.stderr,
            )
        return seen


class JsonLdProductParser(BaseHtmlParser):
    """Extracts schema.org/Product JSON-LD from a retailer listing/category
    page. v1 contract: source.careers_url is a listing/category page; the
    parser collects detail-page links the same way `BaseHtmlParser` does
    for jobs, then on each detail page reads the first JSON-LD `Product`
    block (with nested `Offer`) and yields one `ProductListing`.

    No CSS fallback in v1 — if the retailer doesn't expose JSON-LD, the
    listing is skipped and logged. This is intentional: see the plan in
    plans/can-we-use-the-pure-narwhal.md §1.
    """

    # Pure JSON-LD: no field-specific selectors needed. We still want to
    # discover detail links from the listing page, so subclasses or
    # source.notes can hint via env in future; for v1 we accept the
    # universal "a[href]" filtered by a common product-URL substring.
    LIST_LINK_SELECTORS = [
        "a[href*='/p/']",
        "a[href*='/product/']",
        "a[href*='/products/']",
        "a[itemprop='url']",
    ]
    DETAIL_TITLE_SELECTORS: list[str] = []  # unused; we read JSON-LD
    NEXT_PAGE_SELECTORS = [
        "a[rel='next']",
        "a[aria-label='Next']",
        "button[aria-label='Next']",
    ]

    DETAIL_JSONLD_SELECTOR = "script[type='application/ld+json']"

    # Regex to split "5kg" / "2.5 L" / "500 g" / "1L" into value + unit.
    _SIZE_RE = re.compile(
        r"(\d+(?:[\.,]\d+)?)\s*(kilogram[s]?|kg|gram[s]?|g|"
        r"milligram[s]?|mg|millilit(?:er|re)s?|ml|"
        r"centilit(?:er|re)s?|cl|lit(?:er|re)s?|l|"
        r"each|ea|piece[s]?|pcs|unit)\b",
        re.IGNORECASE,
    )

    def _read_jsonld_blocks(self) -> list[Any]:
        """Return parsed contents of every <script type=application/ld+json>."""
        out: list[Any] = []
        try:
            els = self.page.query_selector_all(self.DETAIL_JSONLD_SELECTOR)
        except Exception:
            return out
        for el in els:
            try:
                txt = el.inner_text() or el.text_content() or ""
            except Exception:
                continue
            txt = txt.strip()
            if not txt:
                continue
            try:
                data = json.loads(txt)
            except ValueError:
                continue
            if isinstance(data, list):
                out.extend(data)
            else:
                out.append(data)
        return out

    @staticmethod
    def _find_product(blocks: list[Any]) -> dict | None:
        """Find the first node whose @type is Product (handles @graph wrappers)."""
        def is_product(node: Any) -> bool:
            if not isinstance(node, dict):
                return False
            t = node.get("@type")
            if isinstance(t, str):
                return t.lower() == "product"
            if isinstance(t, list):
                return any(isinstance(x, str) and x.lower() == "product" for x in t)
            return False

        for blk in blocks:
            if is_product(blk):
                return blk
            if isinstance(blk, dict) and isinstance(blk.get("@graph"), list):
                for node in blk["@graph"]:
                    if is_product(node):
                        return node
        return None

    @staticmethod
    def _pick_offer(node: dict) -> dict | None:
        offers = node.get("offers")
        if isinstance(offers, dict):
            # AggregateOffer → drill into nested offers if present
            if str(offers.get("@type", "")).lower() == "aggregateoffer":
                nested = offers.get("offers")
                if isinstance(nested, list) and nested:
                    return nested[0] if isinstance(nested[0], dict) else None
                # Fall back to using lowPrice/highPrice off the aggregate itself
                return offers
            return offers
        if isinstance(offers, list) and offers and isinstance(offers[0], dict):
            return offers[0]
        return None

    @staticmethod
    def _brand_text(node: dict) -> str:
        b = node.get("brand")
        if isinstance(b, str):
            return b.strip()
        if isinstance(b, dict):
            return str(b.get("name") or "").strip()
        if isinstance(b, list) and b:
            first = b[0]
            if isinstance(first, str):
                return first.strip()
            if isinstance(first, dict):
                return str(first.get("name") or "").strip()
        return ""

    @staticmethod
    def _gtin(node: dict) -> str | None:
        for key in ("gtin13", "gtin14", "gtin12", "gtin8", "gtin"):
            v = node.get(key)
            if isinstance(v, (str, int)) and str(v).strip():
                return str(v).strip()
        return None

    def _parse_size(self, node: dict, name: str) -> tuple[float | None, str]:
        # Prefer schema.org structured size if available.
        for key in ("size", "weight"):
            v = node.get(key)
            if isinstance(v, dict):
                val = v.get("value")
                unit = v.get("unitText") or v.get("unitCode") or ""
                try:
                    f = float(val) if val is not None else None
                except (TypeError, ValueError):
                    f = None
                if f is not None and unit:
                    return (f, str(unit))
        # Fall back to regex over the product name (very common in groceries).
        m = self._SIZE_RE.search(name or "")
        if not m:
            return (None, "")
        try:
            val = float(m.group(1).replace(",", "."))
        except ValueError:
            return (None, "")
        return (val, m.group(2))

    @staticmethod
    def _price_offer(offer: dict) -> tuple[float, str]:
        # price can be a string ("12.50") or number; currency in priceCurrency
        price_raw = offer.get("price")
        if price_raw is None:
            # AggregateOffer fallback
            price_raw = offer.get("lowPrice") or offer.get("highPrice")
        try:
            price = float(str(price_raw).replace(",", "."))
        except (TypeError, ValueError):
            price = 0.0
        currency = str(offer.get("priceCurrency") or "").strip().upper() or "AED"
        return (price, currency)

    @staticmethod
    def _availability(offer: dict) -> bool | None:
        v = offer.get("availability")
        if not isinstance(v, str):
            return None
        s = v.lower()
        if "instock" in s or "in_stock" in s or "preorder" in s:
            return True
        if "outofstock" in s or "out_of_stock" in s or "soldout" in s:
            return False
        return None

    def parse_product(
        self, retailer_id: str, retailer_name: str, url: str
    ) -> ProductListing | None:
        try:
            self.page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=self.DETAIL_GOTO_TIMEOUT_MS,
            )
        except PWTimeout:
            print(f"timeout loading product {url}", file=sys.stderr)
            return None
        except Exception as e:
            print(
                f"error loading product {url}: {type(e).__name__}: {e}",
                file=sys.stderr,
            )
            return None

        blocks = self._read_jsonld_blocks()
        if not blocks:
            print(f"no JSON-LD on {url}", file=sys.stderr)
            return None

        node = self._find_product(blocks)
        if not node:
            print(f"no schema.org/Product node in JSON-LD on {url}", file=sys.stderr)
            return None

        name = str(node.get("name") or "").strip()
        if not name:
            print(f"JSON-LD Product has no name on {url}", file=sys.stderr)
            return None

        offer = self._pick_offer(node)
        if not offer:
            print(f"JSON-LD Product has no Offer on {url}", file=sys.stderr)
            return None

        price, currency = self._price_offer(offer)
        if price <= 0:
            print(f"JSON-LD Offer has no usable price on {url}", file=sys.stderr)
            return None

        brand = self._brand_text(node)
        gtin = self._gtin(node)
        size_value, size_unit = self._parse_size(node, name)
        unit_price, unit_basis = compute_unit_price(price, size_value, size_unit)
        image = node.get("image")
        if isinstance(image, list):
            image = image[0] if image else ""
        image_url = str(image or "").strip()
        in_stock = self._availability(offer)

        return ProductListing(
            retailer_id=retailer_id,
            retailer_name=retailer_name,
            product_url=url,
            name=name,
            brand=brand,
            gtin=gtin,
            size_value=size_value,
            size_unit=size_unit,
            price_value=price,
            price_currency=currency,
            unit_price_value=unit_price,
            unit_price_basis=unit_basis,
            in_stock=in_stock,
            image_url=image_url,
            raw_jsonld=node if isinstance(node, dict) else {},
        )

    def parse_products(
        self, retailer_id: str, retailer_name: str, search_url: str
    ) -> list[ProductListing]:
        out: list[ProductListing] = []
        for link in self.collect_links(search_url):
            try:
                listing = self.parse_product(retailer_id, retailer_name, link)
            except Exception as e:
                print(
                    f"error parsing product {link}: {type(e).__name__}: {e}",
                    file=sys.stderr,
                )
                continue
            if listing:
                out.append(listing)
        return out


PARSERS: dict[str, type] = {
    # job parsers
    "successfactors": SuccessFactorsParser,
    "jibe": JibeParser,
    # product parsers
    "jsonld_product": JsonLdProductParser,
}


# ---------------------------------------------------------------------------
# Destination client (generic, parameterised by Firestore destination doc)
# ---------------------------------------------------------------------------

class AuthHaltError(Exception):
    """Raised on 401/403 — halts the run."""


def _extract_error(r: requests.Response) -> tuple[str, str]:
    try:
        body = r.json()
    except ValueError:
        return ("UNKNOWN", (r.text or "")[:200])
    err = (body or {}).get("error") or {}
    return (err.get("code") or "UNKNOWN", err.get("message") or "")


def _maybe_sleep_for_rate_limit(r: requests.Response) -> None:
    remaining = r.headers.get("X-RateLimit-Remaining")
    reset = r.headers.get("X-RateLimit-Reset")
    if remaining is None or reset is None:
        return
    try:
        remaining_i = int(remaining)
        reset_i = int(reset)
    except ValueError:
        return
    if remaining_i < RATE_LIMIT_FLOOR:
        wait = max(0, reset_i - int(time.time())) + 1
        print(
            f"rate-limit headroom low ({remaining_i} left); sleeping {wait}s",
            file=sys.stderr,
        )
        time.sleep(wait)


class DestinationClient:
    """
    Generic HTTP client built from a Firestore destination doc + the
    resolved secret value. Supports two operations:

      list_existing()  → GET {base_url}{list_path}, returns rows for dedup.
      post_role(role)  → POST {base_url}{post_path} with the built payload.

    Auth: the header_name + header_format build a single header from the
    secret. Format examples: "{secret}", "Bearer {secret}".
    """

    def __init__(
        self,
        *,
        base_url: str,
        list_path: str,
        post_path: str,
        auth_header_name: str,
        auth_header_format: str,
        secret_value: str,
        field_map: dict[str, str] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.list_path = list_path
        self.post_path = post_path
        self.field_map = field_map or {}
        self.session = requests.Session()
        if auth_header_name:
            header_value = (auth_header_format or "{secret}").replace(
                "{secret}", secret_value
            )
            self.session.headers[auth_header_name] = header_value
        self.session.headers["Accept"] = "application/json"

    def list_existing(self) -> list[dict]:
        """
        Walk the destination's list endpoint, returning all rows. Assumes
        entirelysafe-style { data: [...], meta: { total_pages } } pagination
        when present; otherwise treats the response as a single page.
        """
        results: list[dict] = []
        page = 1
        url = f"{self.base_url}{self.list_path}"
        while True:
            r = self.session.get(url, params={"per_page": 100, "page": page}, timeout=30)
            if r.status_code in (401, 403):
                code, message = _extract_error(r)
                raise AuthHaltError(f"{r.status_code} {code}: {message}")
            if r.status_code != 200:
                code, message = _extract_error(r)
                raise RuntimeError(
                    f"GET {self.list_path}?page={page} → {r.status_code} {code}: {message}"
                )
            try:
                body = r.json() or {}
            except ValueError:
                raise RuntimeError(
                    f"GET {self.list_path}?page={page} returned non-JSON body"
                )
            if isinstance(body, dict) and isinstance(body.get("data"), list):
                results.extend(body["data"])
                meta = body.get("meta") or {}
                try:
                    total_pages = int(meta.get("total_pages") or 1)
                except (TypeError, ValueError):
                    total_pages = 1
            elif isinstance(body, list):
                results.extend(body)
                total_pages = 1
            else:
                total_pages = 1
            _maybe_sleep_for_rate_limit(r)
            if page >= total_pages:
                break
            page += 1
        return results

    def post_role(
        self, payload: dict
    ) -> tuple[str, dict | None, str]:
        """
        Returns (status, data, message) where status is one of:
          - "ok"          — successful create
          - "auth"        — 401/403, caller should halt
          - "validation"  — 400 / VALIDATION_ERROR, skip role and continue
          - "other"       — any other non-success, skip role and continue
        """
        mapped = _apply_field_map(payload, self.field_map)
        url = f"{self.base_url}{self.post_path}"
        r = self.session.post(url, json=mapped, timeout=30)

        if r.status_code == 429:
            reset = r.headers.get("X-RateLimit-Reset")
            try:
                wait = (
                    max(0, int(reset) - int(time.time())) + 1
                    if reset is not None
                    else 60
                )
            except (TypeError, ValueError):
                wait = 60
            print(
                f"429 rate-limited; sleeping {wait}s and retrying once",
                file=sys.stderr,
            )
            time.sleep(wait)
            r = self.session.post(url, json=mapped, timeout=30)

        if r.status_code in (200, 201):
            _maybe_sleep_for_rate_limit(r)
            data: dict | None = None
            try:
                data = (r.json() or {}).get("data") if r.headers.get(
                    "Content-Type", ""
                ).startswith("application/json") else None
            except ValueError:
                data = None
            return ("ok", data, "")

        code, message = _extract_error(r)
        _maybe_sleep_for_rate_limit(r)

        if r.status_code in (401, 403):
            return ("auth", None, f"{r.status_code} {code}: {message}")

        if r.status_code == 400 or code == "VALIDATION_ERROR":
            details_text = ""
            try:
                err = (r.json() or {}).get("error") or {}
                details = err.get("details")
                if details:
                    details_text = f" details={json.dumps(details)}"
            except ValueError:
                pass
            return (
                "validation",
                None,
                f"{r.status_code} {code}: {message}{details_text}",
            )

        return ("other", None, f"HTTP {r.status_code} {code}: {message}")


def _apply_field_map(
    payload: dict, field_map: dict[str, str]
) -> dict:
    """
    Rename keys in `payload` per `field_map`. Keys not in the map are
    passed through unchanged. Lets users configure destinations whose
    API expects different field names without code changes.
    """
    if not field_map:
        return payload
    out: dict = {}
    for k, v in payload.items():
        out[field_map.get(k, k)] = v
    return out


def build_payload(role: Role, slug: str) -> dict:
    """
    Build the canonical role payload. Destinations may rename keys via
    their field_map. Schema matches entirelysafe.com's /vacancies API.
    """
    payload: dict = {
        "title": role.title,
        "slug": slug,
        "company": role.employer,
        "description": sanitize_description(role.description),
        "employmentType": role.employment_type,
        "applicationUrl": role.application_url,
        "status": "published",
        "postedBy": os.environ.get(
            "ENTIRELYSAFE_POSTED_BY", ""
        ).strip() or DEFAULT_POSTED_BY,
    }
    if role.country:
        payload["location"] = {"country": role.country, "remote": False}
    if role.closing_date:
        payload["closingDate"] = role.closing_date
    return payload


# ---------------------------------------------------------------------------
# Firestore plumbing
# ---------------------------------------------------------------------------

_FIRESTORE_CLIENT: Any = None


def get_db() -> Any:
    """
    Build a Firestore client from the service-account JSON in the
    GOOGLE_APPLICATION_CREDENTIALS_JSON env var. Bound to
    FIRESTORE_DATABASE_ID (e.g. "scraper") when set, otherwise the
    project's default database.

    Uses google.cloud.firestore.Client directly rather than going via
    firebase_admin so we can pass `database=` for named DBs — the
    Python firebase-admin wrapper doesn't expose that kwarg.
    """
    global _FIRESTORE_CLIENT
    if _FIRESTORE_CLIENT is not None:
        return _FIRESTORE_CLIENT

    sa_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON", "").strip()
    if not sa_json:
        raise RuntimeError(
            "GOOGLE_APPLICATION_CREDENTIALS_JSON env var is not set"
        )
    try:
        sa_dict = json.loads(sa_json)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: {e}"
        ) from e

    creds = service_account.Credentials.from_service_account_info(sa_dict)
    project_id = sa_dict.get("project_id", "")

    kwargs: dict[str, Any] = {"project": project_id, "credentials": creds}
    db_id = os.environ.get("FIRESTORE_DATABASE_ID", "").strip()
    if db_id:
        kwargs["database"] = db_id
    _FIRESTORE_CLIENT = gcf.Client(**kwargs)
    return _FIRESTORE_CLIENT


def _doc_with_id(snap) -> dict:
    data = snap.to_dict() or {}
    data["__id"] = snap.id
    return data


def load_project(db, project_id: str) -> dict | None:
    snap = db.collection("projects").document(project_id).get()
    if not snap.exists:
        return None
    return _doc_with_id(snap)


def load_sources(db, project_id: str, *, active_only: bool = True) -> list[dict]:
    col = db.collection("projects").document(project_id).collection("sources")
    q = col
    if active_only:
        q = q.where(filter=FieldFilter("active", "==", True))
    return [_doc_with_id(d) for d in q.stream()]


def load_destinations(db, project_id: str) -> list[dict]:
    col = (
        db.collection("projects")
        .document(project_id)
        .collection("destinations")
    )
    return [_doc_with_id(d) for d in col.stream()]


def load_secrets(db, project_id: str) -> dict[str, str]:
    col = (
        db.collection("projects").document(project_id).collection("secrets")
    )
    out: dict[str, str] = {}
    for d in col.stream():
        v = (d.to_dict() or {}).get("value")
        if isinstance(v, str):
            out[d.id] = v
    return out


def list_pending_run_requests(db) -> list[dict]:
    q = (
        db.collection("run_requests")
        .where(filter=FieldFilter("status", "==", "pending"))
        .order_by("created_at")
        .limit(50)
    )
    return [_doc_with_id(d) for d in q.stream()]


def update_run_request(db, request_id: str, updates: dict) -> None:
    db.collection("run_requests").document(request_id).update(updates)


def list_enabled_projects(db) -> list[dict]:
    q = db.collection("projects").where(filter=FieldFilter("enabled", "==", True))
    return [_doc_with_id(d) for d in q.stream()]


def find_due_work(
    db, now: datetime
) -> list[tuple[str, str]]:
    """
    Returns a list of (project_id, trigger) pairs to run this tick.
      trigger == "request:<request_id>" for queued ad-hoc runs
      trigger == "schedule"             for cron-due projects

    Deduplicates: if a project has both a pending request AND its cron
    is due, the request wins (one run satisfies both).
    """
    work: list[tuple[str, str]] = []
    seen_projects: set[str] = set()

    # Ad-hoc requests first — most user-visible.
    for req in list_pending_run_requests(db):
        pid = str(req.get("project_id") or "")
        if not pid or pid in seen_projects:
            continue
        seen_projects.add(pid)
        work.append((pid, f"request:{req['__id']}"))

    # Then schedule-due projects.
    for proj in list_enabled_projects(db):
        pid = proj["__id"]
        if pid in seen_projects:
            continue
        cron = str(proj.get("schedule_cron") or "").strip()
        if not cron:
            continue
        last_run_at = proj.get("last_run_at")
        last_dt: datetime | None = None
        if hasattr(last_run_at, "to_datetime"):
            try:
                last_dt = last_run_at.to_datetime()
            except Exception:
                last_dt = None
        elif isinstance(last_run_at, datetime):
            last_dt = last_run_at
        if not _is_cron_due(cron, last_dt, now):
            continue
        seen_projects.add(pid)
        work.append((pid, "schedule"))

    return work


def _is_cron_due(cron_expr: str, last_run_at: datetime | None, now: datetime) -> bool:
    """
    True if the cron expression's next firing after `last_run_at` falls
    at or before `now`. Never-run projects (last_run_at is None) are
    always due.
    """
    if last_run_at is None:
        return True
    try:
        # Step from the last run forward; if the next scheduled point is
        # already past, we owe at least one run.
        itr = croniter(cron_expr, last_run_at)
        next_run = itr.get_next(datetime)
        if next_run.tzinfo is None:
            next_run = next_run.replace(tzinfo=timezone.utc)
        return next_run <= now
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Per-project runner
# ---------------------------------------------------------------------------

def _verdict(
    *, errors_count: int, published: int, found: int
) -> str:
    if errors_count > 0:
        return "errors"
    if published > 0:
        return "ok"
    if found == 0:
        return "zero_found"
    return "no_new"


def run_project(
    db,
    project_id: str,
    trigger: str,
    *,
    dry_run: bool,
    per_project_deadline: float,
) -> dict:
    """
    Run one project end-to-end. Writes a /runs/{run_id} doc, per-source
    /lessons docs, and /published docs (unless dry_run). Returns a
    summary dict for the workflow logs.
    """
    started_at = utc_now_iso()
    started_mono = time.monotonic()

    project = load_project(db, project_id)
    if project is None:
        return {
            "project_id": project_id,
            "status": "error",
            "error": "project not found",
        }

    project_name = str(project.get("name") or project_id)
    print(f"\n=== Project: {project_name} ({project_id}) trigger={trigger} dry={dry_run} ===")

    # Pre-create the /runs/{run_id} doc so the UI sees the run as running.
    run_ref = (
        db.collection("projects").document(project_id).collection("runs").document()
    )
    run_id = run_ref.id
    run_ref.set({
        "started_at": SERVER_TIMESTAMP,
        "finished_at": None,
        "duration_seconds": 0,
        "status": "running",
        "trigger": trigger,
        "dry_run": dry_run,
        "totals": {
            "checked": 0,
            "found": 0,
            "published": 0,
            "skipped_duplicate": 0,
            "errors_count": 0,
        },
        "errors": [],
    })

    summary = {
        "checked": 0,
        "skipped_inactive": 0,
        "found": 0,
        "published": 0,
        "skipped_duplicate": 0,
        "errors": [],
        "published_roles": [],
    }
    auth_halt = False
    overrun = False

    try:
        sources = load_sources(db, project_id, active_only=True)
        destinations = load_destinations(db, project_id)
        secrets = load_secrets(db, project_id)

        has_job_source = any(
            (s.get("item_kind") or "job") == "job" for s in sources
        )
        if has_job_source and not destinations:
            summary["errors"].append("no destinations configured")
            return _finalize_project_run(
                db, project_id, run_ref, run_id, project, summary,
                started_at, started_mono, trigger, dry_run,
                auth_halt=False, overrun=False,
            )

        # Build clients keyed by destination doc id (used for posting).
        clients: dict[str, DestinationClient] = {}
        for dest in destinations:
            secret_ref = str(dest.get("secret_ref") or "").strip()
            secret_value = secrets.get(secret_ref, "")
            if not secret_value:
                summary["errors"].append(
                    f"destination {dest.get('name') or dest['__id']}: "
                    f"secret '{secret_ref}' not set"
                )
                continue
            clients[dest["__id"]] = DestinationClient(
                base_url=str(dest.get("base_url") or ""),
                list_path=str(dest.get("list_path") or ""),
                post_path=str(dest.get("post_path") or ""),
                auth_header_name=str(dest.get("auth_header_name") or ""),
                auth_header_format=str(dest.get("auth_header_format") or "{secret}"),
                secret_value=secret_value,
                field_map=dest.get("field_map") or {},
            )

        if has_job_source and not clients:
            summary["errors"].append("no usable destinations (all secrets missing)")
            return _finalize_project_run(
                db, project_id, run_ref, run_id, project, summary,
                started_at, started_mono, trigger, dry_run,
                auth_halt=False, overrun=False,
            )

        # Pre-fetch existing items from each destination for dedup.
        # Also record (title_company → destination_slug) so we can give
        # /findings the destination's ACTUAL slug for duplicates — our
        # generated slug may not match the one stored on the
        # destination's side (e.g. when it dedups by title+company).
        existing_slugs: set[str] = set()
        existing_title_company: set[tuple[str, str]] = set()
        dest_slug_by_title_company: dict[tuple[str, str], str] = {}
        for dest_id, client in clients.items():
            try:
                for v in client.list_existing():
                    slug = (v.get("slug") or "").strip()
                    if slug:
                        existing_slugs.add(slug)
                    title = (v.get("title") or "").strip().lower()
                    company = (v.get("company") or "").strip().lower()
                    if title and company:
                        existing_title_company.add((title, company))
                        if slug and (title, company) not in dest_slug_by_title_company:
                            dest_slug_by_title_company[(title, company)] = slug
            except AuthHaltError as e:
                summary["errors"].append(
                    f"auth halt listing existing on destination {dest_id}: {e}"
                )
                auth_halt = True
                return _finalize_project_run(
                    db, project_id, run_ref, run_id, project, summary,
                    started_at, started_mono, trigger, dry_run,
                    auth_halt=True, overrun=False,
                )
            except Exception as e:
                summary["errors"].append(
                    f"failed to list existing on destination {dest_id}: "
                    f"{type(e).__name__}: {e}"
                )

        # Launch one Playwright session for the project (browser reuse across
        # sources). Per-project deadline checked between sources.
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (compatible; CaspianScraper/1.0)"
            )
            page = context.new_page()

            try:
                for source in sources:
                    if time.monotonic() >= per_project_deadline:
                        overrun = True
                        summary["errors"].append(
                            f"per-project timeout reached; stopping "
                            f"({len(sources)} sources configured)"
                        )
                        break

                    src_name = str(source.get("name") or source["__id"])
                    src_ats = str(source.get("ats") or "").strip().lower()
                    src_url = str(source.get("careers_url") or "").strip()
                    src_record = {
                        "name": src_name,
                        "ats": src_ats,
                        "careers_url": src_url,
                        "found": 0,
                        "published": 0,
                        "skipped_duplicate": 0,
                        "errors": [],
                    }

                    if not src_url or not src_ats:
                        src_record["errors"].append(
                            "source missing careers_url or ats"
                        )
                        summary["errors"].append(
                            f"{src_name}: missing careers_url or ats"
                        )
                        _write_lesson(db, project_id, run_id, source, src_record, started_at)
                        continue

                    summary["checked"] += 1
                    parser_cls = PARSERS.get(src_ats)
                    if parser_cls is None:
                        msg = f"no parser registered for ats '{src_ats}'"
                        src_record["errors"].append(msg)
                        summary["errors"].append(f"{src_name}: {msg}")
                        _write_lesson(db, project_id, run_id, source, src_record, started_at)
                        continue

                    src_item_kind = str(source.get("item_kind") or "job")
                    roles: list[Role] = []
                    listings: list[ProductListing] = []
                    try:
                        parser = parser_cls(page)
                        if src_item_kind == "product":
                            if not isinstance(parser, JsonLdProductParser):
                                raise RuntimeError(
                                    f"parser {type(parser).__name__} does "
                                    f"not support product extraction"
                                )
                            listings = parser.parse_products(
                                source["__id"], src_name, src_url
                            )
                        else:
                            roles = parser.parse(src_name, src_url)
                    except Exception as e:
                        msg = f"{type(e).__name__}: {e}"
                        src_record["errors"].append(msg)
                        summary["errors"].append(f"{src_name}: {msg}")
                        _write_lesson(db, project_id, run_id, source, src_record, started_at)
                        continue

                    # Product path: write listings + upsert canonicals, then
                    # move on. No destination POSTs, no dedup-by-slug — the
                    # listing ID is deterministic (sha1 of retailer+url) and
                    # write-once for canonical_id.
                    if src_item_kind == "product":
                        src_record["found"] = len(listings)
                        summary["found"] += len(listings)
                        for listing in listings:
                            if dry_run:
                                src_record["published"] += 1
                                summary["published"] += 1
                                summary["published_roles"].append({
                                    "retailer": src_name,
                                    "name": listing.name,
                                    "brand": listing.brand,
                                    "price": (
                                        f"{listing.price_value:.2f} "
                                        f"{listing.price_currency}"
                                    ),
                                    "gtin": listing.gtin or "",
                                    "destination": "(dry-run)",
                                })
                                continue
                            listing_id, is_new = _upsert_listing(
                                db, project_id, listing, source
                            )
                            _upsert_canonical_gtin(
                                db, project_id, listing, listing_id
                            )
                            if is_new:
                                src_record["published"] += 1
                                summary["published"] += 1
                            else:
                                src_record["skipped_duplicate"] += 1
                                summary["skipped_duplicate"] += 1
                        _write_lesson(
                            db, project_id, run_id, source, src_record, started_at
                        )
                        continue

                    src_record["found"] = len(roles)
                    summary["found"] += len(roles)

                    for role in roles:
                        slug = make_slug(role.title, role.employer)
                        title_company = (
                            role.title.strip().lower(),
                            role.employer.strip().lower(),
                        )
                        if (
                            not slug
                            or slug in existing_slugs
                            or title_company in existing_title_company
                        ):
                            summary["skipped_duplicate"] += 1
                            src_record["skipped_duplicate"] += 1
                            if slug and not dry_run:
                                # Resolve the destination's actual slug
                                # for this role so the Findings UI can
                                # link to it. Prefer slug-match (ours
                                # matches theirs) over title+company
                                # lookup.
                                dest_slug = (
                                    slug if slug in existing_slugs
                                    else dest_slug_by_title_company.get(
                                        title_company, ""
                                    )
                                )
                                _upsert_finding(
                                    db, project_id, run_id, slug,
                                    role, source, "duplicate",
                                    destination_slug=dest_slug,
                                )
                            continue

                        payload = build_payload(role, slug)

                        if dry_run:
                            # In dry-run, count what we would publish but
                            # don't actually POST or write /published.
                            summary["published"] += 1
                            src_record["published"] += 1
                            summary["published_roles"].append({
                                "employer": role.employer,
                                "title": role.title,
                                "location": role.location,
                                "country": role.country,
                                "slug": slug,
                                "destination": "(dry-run)",
                            })
                            continue

                        # Try each destination in order until one succeeds.
                        # If all fail with non-auth errors, log and move on.
                        posted = False
                        for dest in destinations:
                            client = clients.get(dest["__id"])
                            if client is None:
                                continue
                            status, data, message = client.post_role(payload)
                            if status == "ok":
                                existing_slugs.add(slug)
                                existing_title_company.add(title_company)
                                summary["published"] += 1
                                src_record["published"] += 1
                                summary["published_roles"].append({
                                    "employer": role.employer,
                                    "title": role.title,
                                    "location": role.location,
                                    "country": role.country,
                                    "slug": slug,
                                    "destination_id": dest["__id"],
                                    "destination_response_id": (data or {}).get("id", ""),
                                })
                                _write_published(
                                    db, project_id, slug, role, dest, source, data
                                )
                                # The destination MAY return its own
                                # slug in the response — prefer it over
                                # ours for the public-URL template.
                                returned_slug = str(
                                    (data or {}).get("slug") or ""
                                ).strip()
                                _upsert_finding(
                                    db, project_id, run_id, slug,
                                    role, source, "published",
                                    dest=dest, api_data=data,
                                    destination_slug=returned_slug or slug,
                                )
                                posted = True
                                break
                            if status == "auth":
                                summary["errors"].append(
                                    f"auth halt during POST: {message}"
                                )
                                src_record["errors"].append(
                                    f"auth halt: {message}"
                                )
                                auth_halt = True
                                break
                            # validation / other → try next destination
                            summary["errors"].append(
                                f"{src_name} / {role.title}: {message}"
                            )
                            src_record["errors"].append(
                                f"{role.title}: {message}"
                            )
                            _upsert_finding(
                                db, project_id, run_id, slug,
                                role, source, "failed",
                                dest=dest, error=message,
                            )

                        if auth_halt:
                            break

                    _write_lesson(db, project_id, run_id, source, src_record, started_at)

                    if auth_halt:
                        break
            finally:
                try:
                    browser.close()
                except Exception:
                    pass

        return _finalize_project_run(
            db, project_id, run_ref, run_id, project, summary,
            started_at, started_mono, trigger, dry_run,
            auth_halt=auth_halt, overrun=overrun,
        )

    except Exception as e:
        summary["errors"].append(
            f"unexpected error: {type(e).__name__}: {e}"
        )
        return _finalize_project_run(
            db, project_id, run_ref, run_id, project, summary,
            started_at, started_mono, trigger, dry_run,
            auth_halt=False, overrun=False,
        )


def _finalize_project_run(
    db,
    project_id: str,
    run_ref,
    run_id: str,
    project: dict,
    summary: dict,
    started_at: str,
    started_mono: float,
    trigger: str,
    dry_run: bool,
    *,
    auth_halt: bool,
    overrun: bool,
) -> dict:
    duration = max(0, int(time.monotonic() - started_mono))
    errors_count = len(summary["errors"])
    checked = summary["checked"]
    if auth_halt:
        status = "auth_halt"
    elif errors_count == 0:
        status = "ok"
    elif checked > 0 and errors_count < checked:
        # Some sources succeeded, some failed — surface as "partial"
        # so the UI doesn't shout "error" at a run that mostly worked.
        status = "partial"
    else:
        status = "error"

    totals = {
        "checked": checked,
        "found": summary["found"],
        "published": summary["published"],
        "skipped_duplicate": summary["skipped_duplicate"],
        "errors_count": errors_count,
    }

    try:
        run_ref.update({
            "finished_at": SERVER_TIMESTAMP,
            "duration_seconds": duration,
            "status": status,
            "totals": totals,
            "errors": summary["errors"],
            "overrun": overrun,
            "published_roles_sample": summary["published_roles"][:25],
        })
    except Exception as e:
        print(
            f"failed to finalize /runs/{run_id}: {type(e).__name__}: {e}",
            file=sys.stderr,
        )

    if not dry_run:
        try:
            db.collection("projects").document(project_id).update({
                "last_run_at": SERVER_TIMESTAMP,
            })
        except Exception as e:
            print(
                f"failed to update last_run_at: {type(e).__name__}: {e}",
                file=sys.stderr,
            )

    # Mark the run_request done/failed if this was an ad-hoc trigger.
    if trigger.startswith("request:"):
        try:
            update_run_request(
                db,
                trigger.split(":", 1)[1],
                {
                    "status": "failed" if status in ("error", "auth_halt") else "done",
                    "finished_at": SERVER_TIMESTAMP,
                    "run_id": run_id,
                },
            )
        except Exception as e:
            print(
                f"failed to update run_request: {type(e).__name__}: {e}",
                file=sys.stderr,
            )

    print(json.dumps({
        "project_id": project_id,
        "run_id": run_id,
        "status": status,
        "duration_seconds": duration,
        **totals,
    }))

    return {
        "project_id": project_id,
        "run_id": run_id,
        "status": status,
        "duration_seconds": duration,
        **totals,
    }


def _write_lesson(
    db,
    project_id: str,
    run_id: str,
    source: dict,
    src_record: dict,
    started_at: str,
) -> None:
    verdict = _verdict(
        errors_count=len(src_record.get("errors", [])),
        published=src_record.get("published", 0),
        found=src_record.get("found", 0),
    )
    try:
        (
            db.collection("projects").document(project_id)
            .collection("lessons").document()
            .set({
                "run_id": run_id,
                "ts": SERVER_TIMESTAMP,
                "source_id": source["__id"],
                "source_name": source.get("name") or source["__id"],
                "ats": source.get("ats") or "",
                "careers_url": source.get("careers_url") or "",
                "verdict": verdict,
                "found": src_record.get("found", 0),
                "published": src_record.get("published", 0),
                "skipped_duplicate": src_record.get("skipped_duplicate", 0),
                "errors": list(src_record.get("errors", [])),
            })
        )
    except Exception as e:
        print(
            f"failed to write lesson for {source.get('name')}: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )

    # Best-effort update of the source's last_run_summary mirror — gives
    # the Sources table a quick "last X / Y" badge without a runs join.
    try:
        (
            db.collection("projects").document(project_id)
            .collection("sources").document(source["__id"])
            .update({
                "last_run_summary": {
                    "ts": SERVER_TIMESTAMP,
                    "found": src_record.get("found", 0),
                    "published": src_record.get("published", 0),
                    "errors_count": len(src_record.get("errors", [])),
                    "verdict": verdict,
                },
            })
        )
    except Exception:
        pass


def _write_published(
    db,
    project_id: str,
    slug: str,
    role: Role,
    dest: dict,
    source: dict,
    api_data: dict | None,
) -> None:
    try:
        (
            db.collection("projects").document(project_id)
            .collection("published").document(slug)
            .set({
                "title": role.title,
                "employer": role.employer,
                "location": role.location,
                "country": role.country,
                "ats": source.get("ats") or "",
                "published_at": SERVER_TIMESTAMP,
                "destination_id": dest["__id"],
                "destination_response_id": (api_data or {}).get("id", ""),
                "source_id": source["__id"],
                "source_url": role.application_url,
            })
        )
    except Exception as e:
        print(
            f"failed to write /published/{slug}: {type(e).__name__}: {e}",
            file=sys.stderr,
        )


def _upsert_finding(
    db,
    project_id: str,
    run_id: str,
    slug: str,
    role: Role,
    source: dict,
    status: str,
    *,
    dest: dict | None = None,
    api_data: dict | None = None,
    error: str | None = None,
    destination_slug: str | None = None,
) -> None:
    """
    Write a /findings/{slug} doc — one per unique role this project has
    ever seen. Status reflects the upload outcome on the latest run, with
    one exception: a previously "published" finding never downgrades to
    "duplicate" (we DID publish it; the destination just remembers).

    status: "duplicate" | "published" | "failed"
    """
    ref = (
        db.collection("projects").document(project_id)
        .collection("findings").document(slug)
    )
    try:
        snap = ref.get()
        existing = snap.to_dict() if snap.exists else None

        # Fields refreshed every encounter — role / source metadata can
        # drift as the source's careers page updates.
        common: dict = {
            "title": role.title,
            "employer": role.employer,
            "location": role.location,
            "country": role.country,
            "employment_type": role.employment_type,
            "ats": source.get("ats") or "",
            "source_id": source["__id"],
            "source_name": source.get("name") or "",
            "source_url": role.application_url,
            "last_seen_at": SERVER_TIMESTAMP,
            "last_seen_run_id": run_id,
            "attempts": Increment(1),
        }
        # destination_slug always written when known — gives the
        # Findings UI the correct slug for building public URLs (our
        # generated slug may differ from the one the destination
        # actually stores).
        if destination_slug:
            common["destination_slug"] = destination_slug

        if existing is None:
            payload = {
                **common,
                "first_seen_at": SERVER_TIMESTAMP,
                "first_seen_run_id": run_id,
                "status": status,
            }
            if status == "published" and dest is not None:
                payload["destination_id"] = dest["__id"]
                payload["destination_response_id"] = (
                    (api_data or {}).get("id", "")
                )
                payload["published_at"] = SERVER_TIMESTAMP
            elif status == "failed" and dest is not None:
                payload["destination_id"] = dest["__id"]
                if error:
                    payload["error"] = error
            ref.set(payload)
            return

        # Existing finding — preserve "published" against later
        # encounters that legitimately see it as a duplicate.
        prev_status = str(existing.get("status") or "")
        updates: dict = dict(common)
        if prev_status == "published":
            # No status change. Duplicate sightings of an already-
            # published role aren't interesting beyond the timestamp.
            pass
        elif status == "published":
            updates["status"] = "published"
            if dest is not None:
                updates["destination_id"] = dest["__id"]
                updates["destination_response_id"] = (
                    (api_data or {}).get("id", "")
                )
                updates["published_at"] = SERVER_TIMESTAMP
        elif status == "failed":
            updates["status"] = "failed"
            if dest is not None:
                updates["destination_id"] = dest["__id"]
            if error:
                updates["error"] = error
        elif status == "duplicate":
            # Only meaningful as an upgrade path from "failed".
            if prev_status == "failed":
                updates["status"] = "duplicate"
        ref.update(updates)
    except Exception as e:
        print(
            f"failed to upsert /findings/{slug}: {type(e).__name__}: {e}",
            file=sys.stderr,
        )


def _upsert_listing(
    db,
    project_id: str,
    listing: ProductListing,
    source: dict,
) -> tuple[str, bool]:
    """
    Upsert /listings/{listingId}. Returns (listing_id, is_new).

    Preserves:
      - first_seen_at on re-scrapes
      - canonical_id once set (matching is write-once; see plan §4)
    """
    listing_id = listing_id_for(listing.retailer_id, listing.product_url)
    ref = (
        db.collection("projects").document(project_id)
        .collection("listings").document(listing_id)
    )
    try:
        snap = ref.get()
        existing = snap.to_dict() if snap.exists else None
        common = {
            "retailer_id": listing.retailer_id,
            "retailer_name": listing.retailer_name,
            "product_url": listing.product_url,
            "name": listing.name,
            "brand": listing.brand,
            "gtin": listing.gtin,
            "size_value": listing.size_value,
            "size_unit": listing.size_unit,
            "price_value": listing.price_value,
            "price_currency": listing.price_currency,
            "unit_price_value": listing.unit_price_value,
            "unit_price_basis": listing.unit_price_basis,
            "in_stock": listing.in_stock,
            "image_url": listing.image_url,
            "raw_jsonld": listing.raw_jsonld,
            "last_seen_at": SERVER_TIMESTAMP,
        }
        if existing is None:
            # First sighting: stamp first_seen_at; pre-link to GTIN canonical
            # if available (the canonical doc itself is upserted by caller).
            ref.set({
                **common,
                "first_seen_at": SERVER_TIMESTAMP,
                "canonical_id": listing.gtin if listing.gtin else None,
                "source_id": source["__id"],
            })
            return (listing_id, True)
        # Re-scrape: refresh fields but do NOT overwrite canonical_id once
        # set. The matching pipeline is write-once (see plan §4).
        updates = dict(common)
        if not existing.get("canonical_id") and listing.gtin:
            updates["canonical_id"] = listing.gtin
        ref.update(updates)
        return (listing_id, False)
    except Exception as e:
        print(
            f"failed to upsert /listings/{listing_id}: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return (listing_id, False)


def _upsert_canonical_gtin(
    db,
    project_id: str,
    listing: ProductListing,
    listing_id: str,
) -> None:
    """
    Upsert /canonicals/{gtin} when the listing has a GTIN. Adds this
    listing_id + retailer_id to the canonical's denormalised arrays.
    No-op if listing.gtin is None.
    """
    if not listing.gtin:
        return
    ref = (
        db.collection("projects").document(project_id)
        .collection("canonicals").document(listing.gtin)
    )
    try:
        snap = ref.get()
        if not snap.exists:
            ref.set({
                "display_name": listing.name,
                "brand": listing.brand,
                "size_value": listing.size_value,
                "size_unit": listing.size_unit,
                "gtin": listing.gtin,
                "listing_ids": [listing_id],
                "retailer_ids": [listing.retailer_id],
                "created_at": SERVER_TIMESTAMP,
                "confirmed_by": "",  # GTIN-auto
            })
            return
        # Use ArrayUnion-style merging without firestore.ArrayUnion to keep
        # the dependency surface small. Re-read + dedup + write.
        data = snap.to_dict() or {}
        listing_ids = list(data.get("listing_ids") or [])
        retailer_ids = list(data.get("retailer_ids") or [])
        changed = False
        if listing_id not in listing_ids:
            listing_ids.append(listing_id)
            changed = True
        if listing.retailer_id not in retailer_ids:
            retailer_ids.append(listing.retailer_id)
            changed = True
        if changed:
            ref.update({
                "listing_ids": listing_ids,
                "retailer_ids": retailer_ids,
            })
    except Exception as e:
        print(
            f"failed to upsert /canonicals/{listing.gtin}: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _env_bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in {"1", "true", "yes", "y", "on"}


def main() -> int:
    started_mono = time.monotonic()
    try:
        db = get_db()
    except Exception as e:
        print(f"firestore init failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    dry_run = _env_bool("DRY_RUN")
    only_project_id = os.environ.get("ONLY_PROJECT_ID", "").strip() or None
    request_id = os.environ.get("REQUEST_ID", "").strip() or None
    try:
        max_projects = int(
            os.environ.get("MAX_PROJECTS_PER_TICK") or DEFAULT_MAX_PROJECTS_PER_TICK
        )
    except ValueError:
        max_projects = DEFAULT_MAX_PROJECTS_PER_TICK
    try:
        per_project_timeout = int(
            os.environ.get("PER_PROJECT_TIMEOUT_SECONDS")
            or DEFAULT_PER_PROJECT_TIMEOUT_S
        )
    except ValueError:
        per_project_timeout = DEFAULT_PER_PROJECT_TIMEOUT_S

    now = utc_now()

    # Build the work list.
    if only_project_id:
        # If this dispatch satisfies a specific run-request, encode it
        # into the trigger so the existing request-update logic flips
        # the /run_requests doc to done at finalise time.
        trigger = f"request:{request_id}" if request_id else "manual"
        work: list[tuple[str, str]] = [(only_project_id, trigger)]
        print(
            f"ONLY_PROJECT_ID={only_project_id} trigger={trigger} "
            f"dry_run={dry_run}",
            file=sys.stderr,
        )
    else:
        work = find_due_work(db, now)[:max_projects]
        print(
            f"found {len(work)} project(s) due "
            f"(dry_run={dry_run}, max_per_tick={max_projects})",
            file=sys.stderr,
        )

    if not work:
        print(json.dumps({"projects": 0, "status": "idle"}))
        return 0

    # Mark requests as "running" up-front so the UI's Pending list clears.
    for project_id, trigger in work:
        if trigger.startswith("request:"):
            try:
                update_run_request(
                    db,
                    trigger.split(":", 1)[1],
                    {"status": "running", "picked_up_at": SERVER_TIMESTAMP},
                )
            except Exception as e:
                print(
                    f"failed to mark run_request running: "
                    f"{type(e).__name__}: {e}",
                    file=sys.stderr,
                )

    results: list[dict] = []
    has_hard_failure = False
    for project_id, trigger in work:
        per_project_deadline = time.monotonic() + per_project_timeout
        result = run_project(
            db,
            project_id,
            trigger,
            dry_run=dry_run,
            per_project_deadline=per_project_deadline,
        )
        results.append(result)
        # "partial" and "ok" are healthy enough not to fail the workflow
        # run; "error" and "auth_halt" are hard failures.
        if result.get("status") in ("error", "auth_halt"):
            has_hard_failure = True

    total_duration = max(0, int(time.monotonic() - started_mono))
    print(json.dumps({
        "tick_finished_at": utc_now_iso(),
        "duration_seconds": total_duration,
        "projects": len(results),
        "results": results,
    }, indent=2))
    return 2 if has_hard_failure else 0


if __name__ == "__main__":
    sys.exit(main())
