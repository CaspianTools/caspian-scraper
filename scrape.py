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

import io
import json
import os
import re
import sys
import time
from dataclasses import dataclass
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

import firebase_admin
from firebase_admin import credentials, firestore as fa_firestore
from google.cloud.firestore_v1 import (
    FieldFilter,
    Increment,
    SERVER_TIMESTAMP,
)


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


PARSERS: dict[str, type] = {
    "successfactors": SuccessFactorsParser,
    "jibe": JibeParser,
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
    Lazily initialise the Firebase Admin SDK from the SA JSON in the
    GOOGLE_APPLICATION_CREDENTIALS_JSON env var, and return a Firestore
    client bound to FIRESTORE_DATABASE_ID (or the project default).
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

    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(sa_dict))

    db_id = os.environ.get("FIRESTORE_DATABASE_ID", "").strip()
    if db_id:
        _FIRESTORE_CLIENT = fa_firestore.client(database_id=db_id)
    else:
        _FIRESTORE_CLIENT = fa_firestore.client()
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
        existing_slugs: set[str] = set()
        existing_title_company: set[tuple[str, str]] = set()
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
    if auth_halt:
        status = "auth_halt"
    elif summary["errors"]:
        status = "error"
    else:
        status = "ok"

    totals = {
        "checked": summary["checked"],
        "found": summary["found"],
        "published": summary["published"],
        "skipped_duplicate": summary["skipped_duplicate"],
        "errors_count": len(summary["errors"]),
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
        work: list[tuple[str, str]] = [(only_project_id, "manual")]
        print(f"ONLY_PROJECT_ID={only_project_id} dry_run={dry_run}", file=sys.stderr)
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
    has_errors = False
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
        if result.get("status") not in ("ok",):
            has_errors = True

    total_duration = max(0, int(time.monotonic() - started_mono))
    print(json.dumps({
        "tick_finished_at": utc_now_iso(),
        "duration_seconds": total_duration,
        "projects": len(results),
        "results": results,
    }, indent=2))
    return 2 if has_errors else 0


if __name__ == "__main__":
    sys.exit(main())
