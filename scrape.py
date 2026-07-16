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


_DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

# Regex to split "5kg" / "2.5 L" / "500 g" / "1L" / "12 adet" → (value, unit).
_SIZE_RE = re.compile(
    r"(\d+(?:[\.,]\d+)?)\s*(kilogram[s]?|kg|gram[s]?|g|"
    r"milligram[s]?|mg|millilit(?:er|re)s?|ml|"
    r"centilit(?:er|re)s?|cl|lit(?:er|re)s?|l|"
    r"each|ea|piece[s]?|pcs|adet|unit)\b",
    re.IGNORECASE,
)


def _parse_size_text(text: str) -> tuple[float | None, str]:
    """Pull a (value, unit) pair out of free text like '12 adet' or '500ml'."""
    if not text:
        return (None, "")
    m = _SIZE_RE.search(text)
    if not m:
        return (None, "")
    try:
        val = float(m.group(1).replace(",", "."))
    except ValueError:
        return (None, "")
    return (val, m.group(2))


def _parse_price_text(text: str) -> float | None:
    """Best-effort price parser for free text like '₺ 14,90' or '14.99 AED'.
    Returns None if no number can be recovered."""
    if not text:
        return None
    cleaned = re.sub(r"[^\d,.\-]", "", text)
    if not cleaned:
        return None
    # Both separators present → assume European-style (',' is decimal)
    if "," in cleaned and "." in cleaned:
        last_dot = cleaned.rfind(".")
        last_comma = cleaned.rfind(",")
        if last_comma > last_dot:
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    else:
        cleaned = cleaned.replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


class ConfigurableProductParser(BaseHtmlParser):
    """Multi-strategy product scraper driven by per-source configuration.

    The source carries an `extraction` config (see web/lib/firestore/schema.ts
    → ExtractionConfigSchema): how to discover detail-page URLs (sitemap /
    css / category seeds) and an ordered chain of extractors to try
    (jsonld_product → microdata → og_meta → css). First extractor that
    yields a non-None `ProductListing` wins.

    Used by the top-level Comparison surface. Per-project HSE-jobs flow is
    untouched. See plan v2 (plans/can-we-use-the-pure-narwhal.md) §3.

    Diagnostics: every parse_products() call accumulates link/page/
    extractor counts that the caller surfaces on the run doc, so a
    zero-found result explains itself (e.g. "links_discovered: 0" vs
    "links_discovered: 30 but extractor_hits all zero").
    """

    DETAIL_JSONLD_SELECTOR = "script[type='application/ld+json']"

    def __init__(
        self,
        page: Page,
        extraction: dict,
        retailer_id: str,
        retailer_name: str,
    ) -> None:
        super().__init__(page)
        self.extraction = extraction or {}
        self.retailer_id = retailer_id
        self.retailer_name = retailer_name
        self.diagnostics: dict[str, Any] = {
            "links_discovered": 0,
            "pages_visited": 0,
            "extractor_hits": {
                "jsonld_product": 0,
                "microdata": 0,
                "og_meta": 0,
                "css": 0,
            },
            "http_errors": {},
        }

    def _user_agent(self) -> str:
        return str(self.extraction.get("user_agent") or _DEFAULT_UA)

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
        return _parse_size_text(name or "")

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

    # ----- Link discovery --------------------------------------------------

    def _discover_links_sitemap(
        self, sitemap_url: str, href_includes: str | None
    ) -> list[str]:
        try:
            resp = requests.get(
                sitemap_url,
                timeout=20,
                headers={"User-Agent": self._user_agent()},
            )
        except Exception as e:
            print(f"sitemap fetch failed {sitemap_url}: {e}", file=sys.stderr)
            return []
        if resp.status_code >= 400:
            self._record_http_error(resp.status_code)
            print(
                f"sitemap {sitemap_url} returned HTTP {resp.status_code}",
                file=sys.stderr,
            )
            return []
        try:
            # sitemap.xml uses xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
            import xml.etree.ElementTree as _ET
            root = _ET.fromstring(resp.content)
        except Exception as e:
            print(f"sitemap parse failed {sitemap_url}: {e}", file=sys.stderr)
            return []
        ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
        out: list[str] = []
        for loc in root.iter(ns + "loc"):
            u = (loc.text or "").strip()
            if not u:
                continue
            if href_includes and href_includes not in u:
                continue
            out.append(u)
        return out

    def _discover_links_css(
        self,
        search_url: str,
        link_selector: str,
        href_includes: str | None,
        next_page_selector: str | None,
        max_pages: int,
    ) -> list[str]:
        # Drive BaseHtmlParser's existing pagination machinery via instance
        # attrs. (BaseHtmlParser reads from .LIST_LINK_SELECTORS /
        # .NEXT_PAGE_SELECTORS / .DETAIL_HREF_RE — those become instance
        # attrs once we assign to self.)
        self.LIST_LINK_SELECTORS = [link_selector] if link_selector else []
        self.NEXT_PAGE_SELECTORS = (
            [next_page_selector] if next_page_selector else []
        )
        self.DETAIL_HREF_RE = (
            re.compile(re.escape(href_includes)) if href_includes else None
        )
        try:
            return self.collect_links(search_url, max_pages=max_pages)
        except ScrapeTimeoutError as e:
            print(f"css discovery timeout: {e}", file=sys.stderr)
            return []
        except Exception as e:
            print(f"css discovery error: {e}", file=sys.stderr)
            return []

    def discover_links(self, start_url: str) -> list[str]:
        ld = self.extraction.get("link_discovery") or {}
        mode = ld.get("mode")
        if mode == "sitemap":
            return self._discover_links_sitemap(
                str(ld.get("sitemap_url") or ""),
                ld.get("href_includes"),
            )
        if mode == "css":
            return self._discover_links_css(
                start_url,
                str(ld.get("link_selector") or "a[href]"),
                ld.get("href_includes"),
                ld.get("next_page_selector"),
                int(ld.get("max_pages") or 5),
            )
        if mode == "category_seeds":
            seeds = ld.get("seed_urls") or []
            link_sel = str(ld.get("link_selector") or "a[href]")
            includes = ld.get("href_includes")
            max_p = int(ld.get("max_pages") or 3)
            out: list[str] = []
            seen: set[str] = set()
            for seed in seeds:
                for link in self._discover_links_css(
                    str(seed), link_sel, includes, None, max_p
                ):
                    if link not in seen:
                        seen.add(link)
                        out.append(link)
            return out
        print(f"unknown link_discovery.mode '{mode}'", file=sys.stderr)
        return []

    def _record_http_error(self, status: int) -> None:
        key = str(status)
        self.diagnostics["http_errors"][key] = (
            self.diagnostics["http_errors"].get(key, 0) + 1
        )

    # ----- Per-page extractor chain ---------------------------------------

    def _meta_content(self, name: str) -> str:
        for sel in (f'meta[property="{name}"]', f'meta[name="{name}"]'):
            try:
                el = self.page.query_selector(sel)
            except Exception:
                continue
            if not el:
                continue
            try:
                c = (el.get_attribute("content") or "").strip()
            except Exception:
                continue
            if c:
                return c
        return ""

    def _extract_jsonld(self, url: str) -> ProductListing | None:
        blocks = self._read_jsonld_blocks()
        if not blocks:
            return None
        node = self._find_product(blocks)
        if not node:
            return None
        name = str(node.get("name") or "").strip()
        if not name:
            return None
        offer = self._pick_offer(node)
        if not offer:
            return None
        price, currency = self._price_offer(offer)
        if price <= 0:
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
            retailer_id=self.retailer_id,
            retailer_name=self.retailer_name,
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

    def _extract_og_meta(self, url: str) -> ProductListing | None:
        name = (
            self._meta_content("og:title")
            or self._meta_content("twitter:title")
        )
        if not name:
            return None
        price_str = self._meta_content(
            "product:price:amount"
        ) or self._meta_content("og:price:amount")
        price = _parse_price_text(price_str)
        if price is None or price <= 0:
            return None
        currency = (
            self._meta_content("product:price:currency")
            or self._meta_content("og:price:currency")
            or ""
        ).upper() or "USD"
        brand = (
            self._meta_content("product:brand")
            or self._meta_content("og:brand")
            or ""
        )
        image_url = self._meta_content("og:image")
        size_value, size_unit = _parse_size_text(name)
        unit_price, unit_basis = compute_unit_price(price, size_value, size_unit)
        return ProductListing(
            retailer_id=self.retailer_id,
            retailer_name=self.retailer_name,
            product_url=url,
            name=name.strip(),
            brand=brand.strip(),
            gtin=None,
            size_value=size_value,
            size_unit=size_unit,
            price_value=price,
            price_currency=currency,
            unit_price_value=unit_price,
            unit_price_basis=unit_basis,
            in_stock=None,
            image_url=image_url,
            raw_jsonld={},
        )

    def _extract_css(self, url: str, cfg: dict) -> ProductListing | None:
        name_sel = str(cfg.get("name_selector") or "")
        price_sel = str(cfg.get("price_selector") or "")
        if not name_sel or not price_sel:
            return None
        name = self._first_text(self.page, [name_sel])
        if not name:
            return None
        price_text = self._first_text(self.page, [price_sel])
        price = _parse_price_text(price_text)
        if price is None or price <= 0:
            return None
        currency = str(cfg.get("currency") or "USD").upper()
        brand = ""
        if cfg.get("brand_selector"):
            brand = self._first_text(self.page, [str(cfg["brand_selector"])])
        image_url = ""
        if cfg.get("image_selector"):
            try:
                el = self.page.query_selector(str(cfg["image_selector"]))
                if el:
                    image_url = (
                        el.get_attribute("src")
                        or el.get_attribute("data-src")
                        or el.get_attribute("data-original")
                        or ""
                    ).strip()
                    if image_url.startswith("//"):
                        image_url = "https:" + image_url
            except Exception:
                pass
        size_text = ""
        if cfg.get("size_selector"):
            size_text = self._first_text(self.page, [str(cfg["size_selector"])])
        size_value, size_unit = _parse_size_text(size_text or name)

        in_stock: bool | None = None
        if cfg.get("in_stock_selector"):
            stock_text = self._first_text(
                self.page, [str(cfg["in_stock_selector"])]
            )
            match = str(cfg.get("in_stock_text_match") or "").strip()
            if match:
                in_stock = bool(stock_text) and match.lower() in stock_text.lower()
            else:
                in_stock = bool(stock_text)

        gtin: str | None = None
        if cfg.get("gtin_selector"):
            g = self._first_text(self.page, [str(cfg["gtin_selector"])]).strip()
            if g.isdigit() and len(g) in (8, 12, 13, 14):
                gtin = g

        unit_price, unit_basis = compute_unit_price(price, size_value, size_unit)
        return ProductListing(
            retailer_id=self.retailer_id,
            retailer_name=self.retailer_name,
            product_url=url,
            name=name.strip(),
            brand=brand.strip(),
            gtin=gtin,
            size_value=size_value,
            size_unit=size_unit,
            price_value=price,
            price_currency=currency,
            unit_price_value=unit_price,
            unit_price_basis=unit_basis,
            in_stock=in_stock,
            image_url=image_url,
            raw_jsonld={},
        )

    def _extract_microdata(self, _url: str) -> ProductListing | None:
        # Phase B — schema.org microdata via itemtype/itemprop walking.
        # Stubbed so the dispatch doesn't crash if a config lists it.
        return None

    def _try_extractors(self, url: str) -> ProductListing | None:
        for ex in self.extraction.get("extractors") or []:
            t = str(ex.get("type") or "")
            listing: ProductListing | None = None
            if t == "jsonld_product":
                listing = self._extract_jsonld(url)
            elif t == "og_meta":
                listing = self._extract_og_meta(url)
            elif t == "css":
                listing = self._extract_css(url, ex)
            elif t == "microdata":
                listing = self._extract_microdata(url)
            if listing is not None:
                self.diagnostics["extractor_hits"][t] = (
                    self.diagnostics["extractor_hits"].get(t, 0) + 1
                )
                return listing
        return None

    # ----- Top-level entry ------------------------------------------------

    def parse_one(self, url: str) -> ProductListing | None:
        """Load `url`, run the extractor chain, return the first hit (or None).
        Surfaces upstream HTTP errors into self.diagnostics so the run-detail
        page can explain zero-found outcomes."""
        wait_sel = self.extraction.get("wait_for_selector")
        try:
            resp = self.page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=self.DETAIL_GOTO_TIMEOUT_MS,
            )
            status_code = resp.status if resp is not None else 0
            if status_code and status_code >= 400:
                self._record_http_error(status_code)
                return None
        except PWTimeout:
            print(f"timeout loading {url}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"error loading {url}: {type(e).__name__}: {e}", file=sys.stderr)
            return None
        self.diagnostics["pages_visited"] += 1
        if wait_sel:
            try:
                self.page.wait_for_selector(
                    wait_sel, timeout=self.DETAIL_SELECTOR_TIMEOUT_MS
                )
            except PWTimeout:
                pass
        return self._try_extractors(url)

    def parse_products(self, start_url: str) -> list[ProductListing]:
        ua = self._user_agent()
        try:
            self.page.context.set_extra_http_headers({"User-Agent": ua})
        except Exception:
            pass

        links = self.discover_links(start_url)
        self.diagnostics["links_discovered"] += len(links)
        if not links:
            print(
                f"no detail-page links discovered from {start_url} "
                f"(mode={(self.extraction.get('link_discovery') or {}).get('mode')})",
                file=sys.stderr,
            )
            return []

        delay_ms = int(self.extraction.get("request_delay_ms") or 1500)
        out: list[ProductListing] = []
        for link in links:
            try:
                listing = self.parse_one(link)
            except Exception as e:
                print(
                    f"unhandled parse error {link}: {type(e).__name__}: {e}",
                    file=sys.stderr,
                )
                continue
            if listing:
                out.append(listing)
            if delay_ms > 0:
                try:
                    self.page.wait_for_timeout(delay_ms)
                except Exception:
                    pass
        return out


PARSERS: dict[str, type] = {
    # job parsers
    "successfactors": SuccessFactorsParser,
    "jibe": JibeParser,
}

# Note: product extraction lives outside this registry. The comparison
# pipeline uses ConfigurableProductParser directly with a per-source
# extraction config (see run_comparison_source). The `jsonld_product`
# value still exists in web/lib/firestore/schema.ts → AtsType for
# backwards-compat on the SourceCreateSchema; it just doesn't dispatch
# anywhere on the project pipeline.


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


def list_active_comparison_sources(db) -> list[dict]:
    """Top-level /comparison_sources, active==True. Used by find_due_work
    + the run-now request handler."""
    q = db.collection("comparison_sources").where(
        filter=FieldFilter("active", "==", True)
    )
    return [_doc_with_id(d) for d in q.stream()]


def load_comparison_source(db, source_id: str) -> dict | None:
    snap = db.collection("comparison_sources").document(source_id).get()
    if not snap.exists:
        return None
    return _doc_with_id(snap)


def list_active_car_sources(db) -> list[dict]:
    """Top-level /car_sources, active==True. Used by find_due_work
    + the run-now request handler."""
    q = db.collection("car_sources").where(
        filter=FieldFilter("active", "==", True)
    )
    return [_doc_with_id(d) for d in q.stream()]


def load_car_source(db, source_id: str) -> dict | None:
    snap = db.collection("car_sources").document(source_id).get()
    if not snap.exists:
        return None
    return _doc_with_id(snap)


def _to_datetime(v: Any) -> datetime | None:
    """Coerce a Firestore timestamp / native datetime / None into UTC datetime."""
    if v is None:
        return None
    if hasattr(v, "to_datetime"):
        try:
            return v.to_datetime()
        except Exception:
            return None
    if isinstance(v, datetime):
        return v
    return None


def find_due_work(
    db, now: datetime
) -> list[tuple[str, str, str]]:
    """
    Returns (kind, id, trigger) tuples to run this tick.
      kind == "project"            → id is a project_id, dispatched to run_project
      kind == "comparison_source"  → id is a comparison_source_id, dispatched to
                                      run_comparison_source
      kind == "car_source"         → id is a car_source_id, dispatched to
                                      run_car_source
      trigger == "request:<request_id>"  queued ad-hoc run
      trigger == "schedule"              cron-due

    Deduplicates: if a target has both a pending request AND its cron is
    due, the request wins. Comparison sources and projects have separate
    seen-sets so a comparison-source request doesn't suppress a project
    or vice versa.
    """
    work: list[tuple[str, str, str]] = []
    seen_projects: set[str] = set()
    seen_comparison: set[str] = set()
    seen_cars: set[str] = set()

    # Ad-hoc requests first — most user-visible.
    for req in list_pending_run_requests(db):
        pid = str(req.get("project_id") or "")
        csid = str(req.get("comparison_source_id") or "")
        carsid = str(req.get("car_source_id") or "")
        trig = f"request:{req['__id']}"
        if pid and pid not in seen_projects:
            seen_projects.add(pid)
            work.append(("project", pid, trig))
        elif csid and csid not in seen_comparison:
            seen_comparison.add(csid)
            work.append(("comparison_source", csid, trig))
        elif carsid and carsid not in seen_cars:
            seen_cars.add(carsid)
            work.append(("car_source", carsid, trig))

    # Then schedule-due projects.
    for proj in list_enabled_projects(db):
        pid = proj["__id"]
        if pid in seen_projects:
            continue
        cron = str(proj.get("schedule_cron") or "").strip()
        if not cron:
            continue
        last_dt = _to_datetime(proj.get("last_run_at"))
        if not _is_cron_due(cron, last_dt, now):
            continue
        seen_projects.add(pid)
        work.append(("project", pid, "schedule"))

    # Then schedule-due comparison sources (top-level, per-user).
    for src in list_active_comparison_sources(db):
        sid = src["__id"]
        if sid in seen_comparison:
            continue
        cron = str(src.get("schedule_cron") or "").strip()
        if not cron:
            continue
        last_dt = _to_datetime(src.get("last_run_at"))
        if not _is_cron_due(cron, last_dt, now):
            continue
        seen_comparison.add(sid)
        work.append(("comparison_source", sid, "schedule"))

    # Then schedule-due car sources (top-level, per-user).
    for src in list_active_car_sources(db):
        sid = src["__id"]
        if sid in seen_cars:
            continue
        cron = str(src.get("schedule_cron") or "").strip()
        if not cron:
            continue
        last_dt = _to_datetime(src.get("last_run_at"))
        if not _is_cron_due(cron, last_dt, now):
            continue
        seen_cars.add(sid)
        work.append(("car_source", sid, "schedule"))

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

        if not destinations:
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

        if not clients:
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

                    try:
                        parser = parser_cls(page)
                        roles = parser.parse(src_name, src_url)
                    except Exception as e:
                        msg = f"{type(e).__name__}: {e}"
                        src_record["errors"].append(msg)
                        summary["errors"].append(f"{src_name}: {msg}")
                        _write_lesson(db, project_id, run_id, source, src_record, started_at)
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


def _upsert_comparison_listing(
    db,
    owner_uid: str,
    source_id: str,
    listing: ProductListing,
) -> tuple[str, bool]:
    """Upsert /comparison_listings/{listingId}. Returns (listing_id, is_new).

    Top-level collection (not under any project). Preserves first_seen_at
    + canonical_id on re-scrapes — matching is write-once (plan v2 §4).
    """
    listing_id = listing_id_for(listing.retailer_id, listing.product_url)
    ref = db.collection("comparison_listings").document(listing_id)
    try:
        snap = ref.get()
        existing = snap.to_dict() if snap.exists else None
        common: dict[str, Any] = {
            "owner_uid": owner_uid,
            "source_id": source_id,
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
            "raw_blob": listing.raw_jsonld,
            "last_seen_at": SERVER_TIMESTAMP,
        }
        if existing is None:
            ref.set({
                **common,
                "first_seen_at": SERVER_TIMESTAMP,
                "canonical_id": listing.gtin if listing.gtin else None,
                "status": "linked" if listing.gtin else "new",
            })
            return (listing_id, True)
        updates = dict(common)
        if not existing.get("canonical_id") and listing.gtin:
            updates["canonical_id"] = listing.gtin
            updates["status"] = "linked"
        elif existing.get("canonical_id"):
            updates["status"] = "linked"
        ref.update(updates)
        return (listing_id, False)
    except Exception as e:
        print(
            f"failed to upsert /comparison_listings/{listing_id}: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return (listing_id, False)


def _upsert_comparison_canonical_gtin(
    db,
    owner_uid: str,
    listing: ProductListing,
    listing_id: str,
) -> None:
    """Upsert /comparison_canonicals/{gtin} when the listing has a GTIN.

    No-op if listing.gtin is None. Append-only listing_ids + retailer_ids
    arrays (read-modify-write rather than ArrayUnion to stay dependency-
    free). Plan v2 §4 — canonical matching is write-once.
    """
    if not listing.gtin:
        return
    ref = db.collection("comparison_canonicals").document(listing.gtin)
    try:
        snap = ref.get()
        if not snap.exists:
            ref.set({
                "owner_uid": owner_uid,
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
            f"failed to upsert /comparison_canonicals/{listing.gtin}: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# Comparison-source runner (top-level, per-user)
# ---------------------------------------------------------------------------

def run_comparison_source(
    db,
    source_id: str,
    trigger: str,
    *,
    dry_run: bool,
    per_source_deadline: float,
) -> dict:
    """Run one comparison source end-to-end. Writes a /comparison_runs/{rid}
    doc, upserts /comparison_listings, and (when a GTIN is present) upserts
    /comparison_canonicals. Returns a summary dict the workflow logs.

    Mirrors run_project's shape but is dramatically simpler: one source
    per run, no destinations, no dedup-by-slug, no auth halts."""
    started_at = utc_now_iso()
    started_mono = time.monotonic()

    source = load_comparison_source(db, source_id)
    if source is None:
        return {
            "comparison_source_id": source_id,
            "status": "error",
            "error": "comparison source not found",
        }

    owner_uid = str(source.get("owner_uid") or "")
    if not owner_uid:
        return {
            "comparison_source_id": source_id,
            "status": "error",
            "error": "comparison source has no owner_uid",
        }

    src_name = str(source.get("name") or source_id)
    retailer_id = str(source.get("retailer_id") or source_id)
    start_urls = source.get("start_urls") or []
    if not isinstance(start_urls, list) or not start_urls:
        return {
            "comparison_source_id": source_id,
            "status": "error",
            "error": "comparison source has no start_urls",
        }
    extraction = source.get("extraction") or {}

    print(
        f"\n=== Comparison: {src_name} ({source_id}) trigger={trigger} "
        f"dry={dry_run} ===",
        file=sys.stderr,
    )

    # Pre-create /comparison_runs/{rid} so the UI sees it as running.
    run_ref = db.collection("comparison_runs").document()
    run_id = run_ref.id
    run_ref.set({
        "owner_uid": owner_uid,
        "source_id": source_id,
        "source_name": src_name,
        "started_at": SERVER_TIMESTAMP,
        "finished_at": None,
        "duration_seconds": 0,
        "status": "running",
        "trigger": trigger,
        "dry_run": dry_run,
        "totals": {
            "checked": 0,
            "found": 0,
            "extracted": 0,
            "skipped_duplicate": 0,
            "errors_count": 0,
        },
        "errors": [],
    })

    summary: dict[str, Any] = {
        "found": 0,
        "extracted": 0,
        "skipped_duplicate": 0,
        "errors": [],
    }
    diagnostics: dict[str, Any] = {
        "links_discovered": 0,
        "pages_visited": 0,
        "extractor_hits": {
            "jsonld_product": 0,
            "microdata": 0,
            "og_meta": 0,
            "css": 0,
        },
        "http_errors": {},
    }

    overrun = False
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            ua = str(extraction.get("user_agent") or _DEFAULT_UA)
            context = browser.new_context(user_agent=ua)
            page = context.new_page()
            try:
                parser = ConfigurableProductParser(
                    page, extraction, retailer_id, src_name
                )
                for url in start_urls:
                    if time.monotonic() >= per_source_deadline:
                        overrun = True
                        summary["errors"].append(
                            "per-source timeout reached"
                        )
                        break
                    try:
                        listings = parser.parse_products(str(url))
                    except Exception as e:
                        msg = f"{type(e).__name__}: {e}"
                        summary["errors"].append(f"{url}: {msg}")
                        continue
                    summary["found"] += len(listings)
                    for listing in listings:
                        if dry_run:
                            summary["extracted"] += 1
                            continue
                        lid, is_new = _upsert_comparison_listing(
                            db, owner_uid, source_id, listing
                        )
                        _upsert_comparison_canonical_gtin(
                            db, owner_uid, listing, lid
                        )
                        if is_new:
                            summary["extracted"] += 1
                        else:
                            summary["skipped_duplicate"] += 1
            finally:
                try:
                    browser.close()
                except Exception:
                    pass

        diagnostics = parser.diagnostics  # noqa: F821 — set inside the with-block
    except Exception as e:
        summary["errors"].append(
            f"unexpected error: {type(e).__name__}: {e}"
        )

    duration = max(0, int(time.monotonic() - started_mono))
    errors_count = len(summary["errors"])
    if errors_count == 0:
        status = "ok"
    elif summary["extracted"] > 0:
        status = "partial"
    else:
        status = "error"

    totals = {
        "checked": len(start_urls),
        "found": summary["found"],
        "extracted": summary["extracted"],
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
            "diagnostics": diagnostics,
        })
    except Exception as e:
        print(
            f"failed to finalise /comparison_runs/{run_id}: "
            f"{type(e).__name__}: {e}",
            file=sys.stderr,
        )

    if not dry_run:
        try:
            db.collection("comparison_sources").document(source_id).update({
                "last_run_at": SERVER_TIMESTAMP,
                "last_run_summary": {
                    "ts": SERVER_TIMESTAMP,
                    "found": summary["found"],
                    "extracted": summary["extracted"],
                    "errors_count": errors_count,
                },
            })
        except Exception as e:
            print(
                f"failed to update comparison source last_run_at: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )

    if trigger.startswith("request:"):
        try:
            update_run_request(
                db,
                trigger.split(":", 1)[1],
                {
                    "status": "done",
                    "finished_at": SERVER_TIMESTAMP,
                    "run_id": run_id,
                },
            )
        except Exception as e:
            print(
                f"failed to mark comparison run_request done: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )

    return {
        "comparison_source_id": source_id,
        "source_name": src_name,
        "status": status,
        "totals": totals,
        "diagnostics": diagnostics,
        "errors": summary["errors"][:10],
    }


# ---------------------------------------------------------------------------
# Car-classifieds runner (top-level, per-user)
#
# Reuses the standalone `classifieds/` scraper as the extraction engine. The
# site adapter (e.g. OpenSooq) owns its OWN Playwright browser via
# classifieds.browser.browser_context(), so this runner must NOT open a
# sync_playwright() context of its own — just build the spec, build the
# adapter, and iterate its generator.
# ---------------------------------------------------------------------------

def _upsert_car_listing(
    db,
    owner_uid: str,
    source_id: str,
    listing: Any,
) -> tuple[str, bool]:
    """Upsert /car_listings/{uid}. Returns (uid, is_new). Doc id is the
    classifieds Listing.uid (site:listing_id). Preserves first_seen_at on
    re-scrapes; refreshes every mutable field + last_seen_at."""
    uid = listing.uid
    ref = db.collection("car_listings").document(uid)
    try:
        snap = ref.get()
        data = listing.to_dict()
        data.update({
            "owner_uid": owner_uid,
            "source_id": source_id,
            "last_seen_at": SERVER_TIMESTAMP,
        })
        if not snap.exists:
            ref.set({
                **data,
                "first_seen_at": SERVER_TIMESTAMP,
                "status": "new",
            })
            return (uid, True)
        data["status"] = "seen"
        ref.update(data)
        return (uid, False)
    except Exception as e:
        print(
            f"failed to upsert /car_listings/{uid}: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return (uid, False)


def _diag_search_url(site: str, source: dict) -> str:
    """Best-effort public search URL for a diagnostic pre-flight GET.
    Currently OpenSooq only; returns '' to skip the pre-flight otherwise."""
    if site == "opensooq":
        category = str(source.get("category") or "cars")
        base = f"https://om.opensooq.com/en/{category}/cars-for-sale"
        query = str(source.get("query") or "").strip()
        if query:
            return base + "?search=" + query.replace(" ", "+")
        return base
    return ""


def run_car_source(
    db,
    source_id: str,
    trigger: str,
    *,
    dry_run: bool,
    per_source_deadline: float,
) -> dict:
    """Run one car-classifieds source end-to-end via the `classifieds`
    engine. Writes a /car_runs/{rid} doc and upserts /car_listings. One
    source (site + country + city + query) per run."""
    started_mono = time.monotonic()

    source = load_car_source(db, source_id)
    if source is None:
        return {
            "car_source_id": source_id,
            "status": "error",
            "error": "car source not found",
        }
    owner_uid = str(source.get("owner_uid") or "")
    if not owner_uid:
        return {
            "car_source_id": source_id,
            "status": "error",
            "error": "car source has no owner_uid",
        }

    src_name = str(source.get("name") or source_id)
    site_key = str(source.get("site") or "opensooq")

    print(
        f"\n=== Cars: {src_name} ({source_id}) site={site_key} "
        f"trigger={trigger} dry={dry_run} ===",
        file=sys.stderr,
    )

    # Pre-create /car_runs/{rid} so the UI sees it as running.
    run_ref = db.collection("car_runs").document()
    run_id = run_ref.id
    run_ref.set({
        "owner_uid": owner_uid,
        "source_id": source_id,
        "source_name": src_name,
        "site": site_key,
        "started_at": SERVER_TIMESTAMP,
        "finished_at": None,
        "duration_seconds": 0,
        "status": "running",
        "trigger": trigger,
        "dry_run": dry_run,
        "totals": {"found": 0, "new": 0, "updated": 0, "errors_count": 0},
        "errors": [],
    })

    summary: dict[str, Any] = {"found": 0, "new": 0, "updated": 0, "errors": []}
    overrun = False

    # Diagnostic pre-flight: a plain-HTTP GET of the site's public search page
    # from THIS runner. Recorded on the run doc + printed to the logs so we can
    # tell an anti-bot / datacenter-IP block ("0 found") apart from a parser or
    # schema problem. `has_serp`/`has_next_data` true + a real title means the
    # page is reachable and structured as expected from here; the real scrape
    # below still goes through the classifieds adapter (Playwright).
    diag: dict[str, Any] = {}
    _diag_url = _diag_search_url(site_key, source)
    if _diag_url:
        try:
            import requests as _rq
            _ua = (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            )
            _r = _rq.get(_diag_url, headers={"User-Agent": _ua}, timeout=30)
            _html = _r.text or ""
            _tm = re.search(r"<title[^>]*>([^<]*)</title>", _html, re.I)
            diag = {
                "preflight_url": _diag_url,
                "http_status": _r.status_code,
                "final_url": str(_r.url),
                "html_len": len(_html),
                "has_next_data": "__NEXT_DATA__" in _html,
                "has_serp": "serpApiResponse" in _html,
                "title": (_tm.group(1)[:120] if _tm else ""),
            }
        except Exception as e:
            diag = {"preflight_error": f"{type(e).__name__}: {e}"}
        print(f"car preflight {site_key}: {json.dumps(diag)}", file=sys.stderr)

    try:
        # Import lazily so non-car ticks don't pay the classifieds import.
        from classifieds import sites as _sites
        from classifieds.sites.base import SearchSpec as _SearchSpec

        # Default the date window to 1 (today's new listings) when the field
        # is absent (older source docs), else honour it (0 = no filter).
        _pwd = source.get("posted_within_days")
        spec = _SearchSpec(
            category=str(source.get("category") or "cars"),
            country=str(source.get("country") or "om").lower(),
            city=str(source.get("city") or ""),
            query=str(source.get("query") or ""),
            max_listings=int(source.get("max_listings") or 50),
            with_details=bool(source.get("with_details", True)),
            posted_within_days=(int(_pwd) if _pwd is not None else 1),
        )
        adapter = _sites.build(site_key)
        started_iso = utc_now_iso()
        seen: set[str] = set()
        gen = adapter.search(spec)
        try:
            for listing in gen:
                if time.monotonic() >= per_source_deadline:
                    overrun = True
                    summary["errors"].append("per-source timeout reached")
                    break
                if listing.uid in seen:
                    continue
                seen.add(listing.uid)
                listing.scraped_at = started_iso
                summary["found"] += 1
                if dry_run:
                    continue
                _uid, is_new = _upsert_car_listing(
                    db, owner_uid, source_id, listing
                )
                if is_new:
                    summary["new"] += 1
                else:
                    summary["updated"] += 1
        finally:
            # Close the generator so its browser_context() cleans up promptly
            # even when we break early on the per-source deadline.
            gclose = getattr(gen, "close", None)
            if callable(gclose):
                gclose()
    except Exception as e:
        summary["errors"].append(
            f"unexpected error: {type(e).__name__}: {e}"
        )

    duration = max(0, int(time.monotonic() - started_mono))
    errors_count = len(summary["errors"])
    if errors_count == 0:
        status = "ok" if summary["found"] > 0 else "zero_found"
    elif summary["found"] > 0:
        status = "partial"
    else:
        status = "error"

    totals = {
        "found": summary["found"],
        "new": summary["new"],
        "updated": summary["updated"],
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
            "diagnostics": diag,
        })
    except Exception as e:
        print(
            f"failed to finalise /car_runs/{run_id}: {type(e).__name__}: {e}",
            file=sys.stderr,
        )

    if not dry_run:
        try:
            db.collection("car_sources").document(source_id).update({
                "last_run_at": SERVER_TIMESTAMP,
                "last_run_summary": {
                    "ts": SERVER_TIMESTAMP,
                    "found": summary["found"],
                    "new": summary["new"],
                    "errors_count": errors_count,
                },
            })
        except Exception as e:
            print(
                f"failed to update car source last_run_at: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )

    if trigger.startswith("request:"):
        try:
            update_run_request(
                db,
                trigger.split(":", 1)[1],
                {
                    "status": "failed" if status == "error" else "done",
                    "finished_at": SERVER_TIMESTAMP,
                    "run_id": run_id,
                },
            )
        except Exception as e:
            print(
                f"failed to mark car run_request done: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )

    return {
        "car_source_id": source_id,
        "source_name": src_name,
        "status": status,
        "totals": totals,
        "diagnostics": diag,
        "errors": summary["errors"][:10],
    }


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

    only_comparison_source_id = (
        os.environ.get("ONLY_COMPARISON_SOURCE_ID", "").strip() or None
    )
    only_car_source_id = (
        os.environ.get("ONLY_CAR_SOURCE_ID", "").strip() or None
    )

    now = utc_now()

    # Build the work list.
    if only_project_id:
        trigger = f"request:{request_id}" if request_id else "manual"
        work: list[tuple[str, str, str]] = [
            ("project", only_project_id, trigger)
        ]
        print(
            f"ONLY_PROJECT_ID={only_project_id} trigger={trigger} "
            f"dry_run={dry_run}",
            file=sys.stderr,
        )
    elif only_comparison_source_id:
        trigger = f"request:{request_id}" if request_id else "manual"
        work = [("comparison_source", only_comparison_source_id, trigger)]
        print(
            f"ONLY_COMPARISON_SOURCE_ID={only_comparison_source_id} "
            f"trigger={trigger} dry_run={dry_run}",
            file=sys.stderr,
        )
    elif only_car_source_id:
        trigger = f"request:{request_id}" if request_id else "manual"
        work = [("car_source", only_car_source_id, trigger)]
        print(
            f"ONLY_CAR_SOURCE_ID={only_car_source_id} "
            f"trigger={trigger} dry_run={dry_run}",
            file=sys.stderr,
        )
    else:
        work = find_due_work(db, now)[:max_projects]
        print(
            f"found {len(work)} work item(s) due "
            f"(dry_run={dry_run}, max_per_tick={max_projects})",
            file=sys.stderr,
        )

    if not work:
        print(json.dumps({"projects": 0, "status": "idle"}))
        return 0

    # Mark requests as "running" up-front so the UI's Pending list clears.
    for _kind, _id, trigger in work:
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
    errored = 0
    for kind, work_id, trigger in work:
        per_item_deadline = time.monotonic() + per_project_timeout
        if kind == "project":
            result = run_project(
                db,
                work_id,
                trigger,
                dry_run=dry_run,
                per_project_deadline=per_item_deadline,
            )
        elif kind == "comparison_source":
            result = run_comparison_source(
                db,
                work_id,
                trigger,
                dry_run=dry_run,
                per_source_deadline=per_item_deadline,
            )
        elif kind == "car_source":
            result = run_car_source(
                db,
                work_id,
                trigger,
                dry_run=dry_run,
                per_source_deadline=per_item_deadline,
            )
        else:
            print(f"unknown work kind '{kind}'; skipping", file=sys.stderr)
            continue
        results.append(result)
        if result.get("status") in ("error", "auth_halt"):
            errored += 1

    total_duration = max(0, int(time.monotonic() - started_mono))
    print(json.dumps({
        "tick_finished_at": utc_now_iso(),
        "duration_seconds": total_duration,
        "items": len(results),
        "errored": errored,
        "results": results,
    }, indent=2))
    # Per-item errors (a misconfigured project, a site blocking a scrape, a
    # transient timeout) are recorded in each run doc and surfaced in the
    # dashboard's Runs views — they do NOT fail the tick. The workflow only
    # exits non-zero for infrastructure failures (e.g. the Firestore-init
    # guard near the top returns 1), so one bad source can't red the cron and
    # spam the failure-issue alert every 15 minutes.
    if errored:
        print(
            f"{errored}/{len(results)} item(s) finished with errors — see the "
            "per-run docs / dashboard for details",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
