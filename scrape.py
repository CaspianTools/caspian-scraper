#!/usr/bin/env python3
"""
HSE scraper.

Reads `employers.json`, scrapes each active employer's careers site for HSE
job postings, and publishes new ones to entirelysafe.com via its REST API.
The API is the single source of truth — there is no local cache or database;
dedup is performed by listing existing vacancies before posting.

Required environment variables:
  ENTIRELYSAFE_API_KEY    API key, sent as `X-API-Key` on every request.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol
from urllib.parse import urljoin

import requests
from playwright.sync_api import (
    Page,
    TimeoutError as PWTimeout,
    sync_playwright,
)


API_BASE = "https://entirelysafe.com/api/v1"
RATE_LIMIT_FLOOR = 10
REPO_ROOT = Path(__file__).parent
EMPLOYERS_FILE = REPO_ROOT / "employers.json"
DATA_FILE = REPO_ROOT / "docs" / "data.json"
RUN_HISTORY_LIMIT = 30
RECENT_PUBLISHED_LIMIT = 50
DATA_SCHEMA_VERSION = 1

# Firebase Auth UID of the user that scraped vacancies are attributed to.
# Override via ENTIRELYSAFE_POSTED_BY env var if a different account should own them.
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

# Order matters — first match wins.
# Values must match the entirelysafe schema: 'full-time' | 'part-time' | 'contract' | 'temporary'.
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

# Country-name → ISO-2 code (lowercase, matches src/data/countries.ts in entirelysafe).
# Longest names match first in infer_country() so "united states" beats "states".
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


# ---------------------------------------------------------------------------
# Domain types
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
    return ""


def make_slug(title: str, company: str) -> str:
    raw = f"{title}-{company}".lower()
    raw = re.sub(r"[^a-z0-9]+", "-", raw)
    return raw.strip("-")


# ---------------------------------------------------------------------------
# Parser registry
# ---------------------------------------------------------------------------

class ScrapeTimeoutError(RuntimeError):
    """Raised when a parser can't load a search page — surfaced as a
    per-employer error rather than swallowed into a silent `found: 0`."""


class Parser(Protocol):
    def __init__(self, page: Page) -> None: ...
    def parse(self, employer_name: str, search_url: str) -> list[Role]: ...


class BaseHtmlParser:
    """
    Shared scaffolding for HTML-scraping parsers. Concrete subclasses
    declare five class-level selector chains plus an optional
    ``DETAIL_HREF_RE`` filter; they may override ``collect_links`` if
    their site uses something other than click-Next pagination.
    """

    LIST_LINK_SELECTORS: list[str] = []
    DETAIL_TITLE_SELECTORS: list[str] = []
    DETAIL_LOCATION_SELECTORS: list[str] = []
    DETAIL_DESCRIPTION_SELECTORS: list[str] = []
    NEXT_PAGE_SELECTORS: list[str] = []
    DETAIL_HREF_RE: "re.Pattern[str] | None" = None

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

    SEARCH_GOTO_TIMEOUT_MS = 45_000
    SEARCH_SELECTOR_TIMEOUT_MS = 8_000
    DETAIL_GOTO_TIMEOUT_MS = 30_000
    DETAIL_SELECTOR_TIMEOUT_MS = 6_000

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
        # Give SPA-style careers sites a chance to render their list before we
        # gather. Failures here are non-fatal — _gather_links logs its own miss.
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
        """Default: load search page, gather links, click Next, repeat."""
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

        # Gate on title BEFORE extracting the description — most jobs on a
        # search page that lacks an HSE filter will fail this check, so
        # skipping description extraction is a 50%+ saving on per-page work.
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
    """
    SAP SuccessFactors career-site parser. Aramco, Halliburton, and many
    other large employers use SF; skin-level differences between tenants
    are absorbed by the per-field selector fallback chains below.
    """

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
    """
    Jibe (iCIMS recruitment marketing) career-site parser.
    Used by QatarEnergy and other employers whose sites are served via
    cms.jibecdn.com. Job detail URLs follow /jobs/<numeric-id>?lang=en-us.
    """

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
    # Drop nav links that share /jobs/ prefix (e.g. /jobs/categories/...).
    DETAIL_HREF_RE = re.compile(r"/jobs/\d+")

    def collect_links(self, search_url: str, max_pages: int = 5) -> list[str]:
        """Jibe lazy-loads via scroll, with click-Next fallback."""
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
# entirelysafe.com client
# ---------------------------------------------------------------------------

class AuthHaltError(Exception):
    """Raised on 401/403 responses — a halting condition for the run."""


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


class EntirelySafeClient:
    def __init__(self, api_key: str, base_url: str = API_BASE) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "X-API-Key": api_key,
            "Accept": "application/json",
        })

    def list_vacancies(self) -> list[dict]:
        results: list[dict] = []
        page = 1
        while True:
            r = self.session.get(
                f"{self.base_url}/vacancies",
                params={"per_page": 100, "page": page},
                timeout=30,
            )
            if r.status_code in (401, 403):
                code, message = _extract_error(r)
                raise AuthHaltError(f"{r.status_code} {code}: {message}")
            if r.status_code != 200:
                code, message = _extract_error(r)
                raise RuntimeError(
                    f"GET /vacancies?page={page} → {r.status_code} {code}: {message}"
                )
            try:
                body = r.json() or {}
            except ValueError:
                raise RuntimeError(
                    f"GET /vacancies?page={page} returned non-JSON body"
                )
            results.extend(body.get("data") or [])
            meta = body.get("meta") or {}
            try:
                total_pages = int(meta.get("total_pages") or 1)
            except (TypeError, ValueError):
                total_pages = 1
            _maybe_sleep_for_rate_limit(r)
            if page >= total_pages:
                break
            page += 1
        return results

    def post_vacancy(
        self, payload: dict
    ) -> tuple[str, dict | None, str]:
        """
        Post a vacancy. Returns (status, data, message) where status is one of:
          - "ok"          — successful create
          - "auth"        — 401/403, caller should halt
          - "validation"  — 400 / VALIDATION_ERROR, skip role and continue
          - "other"       — any other non-success, skip role and continue
        """
        r = self._post_once(payload)

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
            r = self._post_once(payload)

        if r.status_code in (200, 201):
            _maybe_sleep_for_rate_limit(r)
            data: dict | None = None
            try:
                data = (r.json() or {}).get("data")
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

    def _post_once(self, payload: dict) -> requests.Response:
        return self.session.post(
            f"{self.base_url}/vacancies",
            json=payload,
            timeout=30,
        )


# ---------------------------------------------------------------------------
# Config + payload helpers
# ---------------------------------------------------------------------------

def load_employers() -> list[dict]:
    if not EMPLOYERS_FILE.exists():
        raise FileNotFoundError(
            f"employers.json not found at {EMPLOYERS_FILE}"
        )
    try:
        data = json.loads(EMPLOYERS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"employers.json is not valid JSON: {e}") from e
    if not isinstance(data, list):
        raise ValueError("employers.json must be a JSON array")
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            raise ValueError(f"employers.json[{i}] must be an object")
        for key in ("name", "url", "ats", "active"):
            if key not in entry:
                raise ValueError(
                    f"employers.json[{i}] missing required key '{key}'"
                )
    return data


def build_payload(role: Role, slug: str) -> dict:
    payload: dict = {
        "title": role.title,
        "slug": slug,
        "company": role.employer,
        "description": role.description,
        "employmentType": role.employment_type,
        "applicationUrl": role.application_url,
        "status": "published",
        "postedBy": os.environ.get("ENTIRELYSAFE_POSTED_BY", "").strip() or DEFAULT_POSTED_BY,
    }
    if role.country:
        payload["location"] = {"country": role.country, "remote": False}
    if role.closing_date:
        payload["closingDate"] = role.closing_date
    return payload


# ---------------------------------------------------------------------------
# Dashboard data file (docs/data.json)
# ---------------------------------------------------------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def repo_full_name() -> str:
    return os.environ.get("GITHUB_REPOSITORY", "CaspianTools/caspian-scraper")


def load_data_file() -> dict:
    if not DATA_FILE.exists():
        return {}
    try:
        loaded = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def employer_meta(employers: list[dict]) -> list[dict]:
    return [
        {
            "name": str(e.get("name") or "").strip(),
            "ats": str(e.get("ats") or "").strip(),
            "active": bool(e.get("active")),
        }
        for e in employers
    ]


def update_data_json(run_record: dict, employers_meta: list[dict]) -> None:
    """Append the run to docs/data.json, trimming history and updating totals."""
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    existing = load_data_file()

    runs = list(existing.get("runs") or [])
    runs.append(run_record)
    runs = runs[-RUN_HISTORY_LIMIT:]

    recent = list(existing.get("recent_published") or [])
    role_ts = run_record.get("finished_at") or run_record.get("started_at")
    for role in run_record.get("published_roles") or []:
        recent.append({"ts": role_ts, **role})
    recent = recent[-RECENT_PUBLISHED_LIMIT:]

    prev_totals = existing.get("totals") or {}
    totals = {
        "runs": int(prev_totals.get("runs") or 0) + 1,
        "found_alltime": int(prev_totals.get("found_alltime") or 0)
                         + int(run_record.get("found") or 0),
        "published_alltime": int(prev_totals.get("published_alltime") or 0)
                             + int(run_record.get("published") or 0),
        "errors_alltime": int(prev_totals.get("errors_alltime") or 0)
                          + len(run_record.get("errors") or []),
    }

    payload = {
        "schema_version": DATA_SCHEMA_VERSION,
        "scraper_repo": repo_full_name(),
        "last_updated": run_record.get("finished_at") or utc_now_iso(),
        "employers": employers_meta,
        "totals": totals,
        "runs": runs,
        "recent_published": recent,
    }

    DATA_FILE.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def finalize_run(
    summary: dict,
    by_employer: list[dict],
    employers: list[dict],
    started_at: str,
    started_mono: float,
    auth_halt: bool,
) -> None:
    finished_at = utc_now_iso()
    duration = max(0, int(time.monotonic() - started_mono))
    run_record = {
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_seconds": duration,
        "status": "auth_halt" if auth_halt else (
            "error" if summary["errors"] else "ok"
        ),
        **summary,
        "by_employer": by_employer,
    }
    try:
        update_data_json(run_record, employer_meta(employers))
    except Exception as e:
        print(
            f"failed to update {DATA_FILE}: {type(e).__name__}: {e}",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    started_at = utc_now_iso()
    started_mono = time.monotonic()

    summary: dict = {
        "checked": 0,
        "skipped_inactive": 0,
        "found": 0,
        "published": 0,
        "skipped_duplicate": 0,
        "errors": [],
        "published_roles": [],
    }
    by_employer: list[dict] = []
    employers: list[dict] = []
    auth_halt = False
    exit_code = 0

    try:
        api_key = os.environ.get("ENTIRELYSAFE_API_KEY", "").strip()
        if not api_key:
            msg = "ENTIRELYSAFE_API_KEY is not set"
            print(msg, file=sys.stderr)
            summary["errors"].append(msg)
            exit_code = 1
            return exit_code

        try:
            employers = load_employers()
        except (FileNotFoundError, ValueError) as e:
            msg = f"config error: {e}"
            print(msg, file=sys.stderr)
            summary["errors"].append(msg)
            exit_code = 1
            return exit_code

        client = EntirelySafeClient(api_key)

        try:
            existing = client.list_vacancies()
        except AuthHaltError as e:
            msg = f"auth failure listing vacancies (halting): {e}"
            print(msg, file=sys.stderr)
            summary["errors"].append(msg)
            exit_code = 1
            return exit_code
        except Exception as e:
            msg = f"failed to list existing vacancies: {type(e).__name__}: {e}"
            print(msg, file=sys.stderr)
            summary["errors"].append(msg)
            exit_code = 1
            return exit_code

        existing_slugs: set[str] = set()
        existing_title_company: set[tuple[str, str]] = set()
        for v in existing:
            slug = (v.get("slug") or "").strip()
            if slug:
                existing_slugs.add(slug)
            title = (v.get("title") or "").strip().lower()
            company = (v.get("company") or "").strip().lower()
            if title and company:
                existing_title_company.add((title, company))

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (compatible; HSE-Scraper/1.0)"
            )
            page = context.new_page()

            try:
                for emp in employers:
                    name = str(emp.get("name") or "").strip()
                    url = str(emp.get("url") or "").strip()
                    ats = str(emp.get("ats") or "").strip().lower()
                    active = bool(emp.get("active"))

                    emp_record = {
                        "name": name or "(unnamed)",
                        "ats": ats,
                        "active": active,
                        "found": 0,
                        "published": 0,
                        "skipped_duplicate": 0,
                        "errors": [],
                    }
                    by_employer.append(emp_record)

                    if not name or not url or not ats:
                        emp_record["errors"].append(
                            "employer entry missing name/url/ats"
                        )
                        summary["errors"].append(
                            f"employer entry missing name/url/ats: {emp!r}"
                        )
                        continue
                    if not active:
                        summary["skipped_inactive"] += 1
                        continue

                    summary["checked"] += 1
                    parser_cls = PARSERS.get(ats)
                    if parser_cls is None:
                        msg = f"no parser registered for ATS '{ats}'"
                        emp_record["errors"].append(msg)
                        summary["errors"].append(f"{name}: {msg}")
                        continue

                    try:
                        parser = parser_cls(page)
                        roles = parser.parse(name, url)
                    except Exception as e:
                        msg = f"{type(e).__name__}: {e}"
                        emp_record["errors"].append(msg)
                        summary["errors"].append(f"{name}: {msg}")
                        continue

                    emp_record["found"] = len(roles)
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
                            emp_record["skipped_duplicate"] += 1
                            continue

                        payload = build_payload(role, slug)
                        status, data, message = client.post_vacancy(payload)

                        if status == "ok":
                            existing_slugs.add(slug)
                            existing_title_company.add(title_company)
                            summary["published"] += 1
                            emp_record["published"] += 1
                            summary["published_roles"].append({
                                "employer": role.employer,
                                "title": role.title,
                                "location": role.location,
                                "country": role.country,
                                "employment_type": role.employment_type,
                                "slug": slug,
                                "id": (data or {}).get("id", ""),
                                "url": role.application_url,
                            })
                        elif status == "auth":
                            summary["errors"].append(
                                f"auth halt during POST: {message}"
                            )
                            emp_record["errors"].append(
                                f"auth halt during POST: {message}"
                            )
                            auth_halt = True
                            break
                        else:
                            summary["errors"].append(
                                f"{name} / {role.title}: {message}"
                            )
                            emp_record["errors"].append(
                                f"{role.title}: {message}"
                            )

                    if auth_halt:
                        break
            finally:
                try:
                    browser.close()
                except Exception:
                    pass

        if auth_halt:
            exit_code = 1
        return exit_code
    finally:
        finalize_run(
            summary, by_employer, employers, started_at, started_mono, auth_halt
        )
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    sys.exit(main())
