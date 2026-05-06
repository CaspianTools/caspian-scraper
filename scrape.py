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
EMPLOYERS_FILE = Path(__file__).parent / "employers.json"

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
EMPLOYMENT_TYPE_MAP: list[tuple[str, str]] = [
    ("full time", "FULL_TIME"),
    ("full-time", "FULL_TIME"),
    ("permanent", "FULL_TIME"),
    ("part time", "PART_TIME"),
    ("part-time", "PART_TIME"),
    ("contract", "CONTRACT"),
    ("contractor", "CONTRACT"),
    ("fixed term", "CONTRACT"),
    ("temporary", "TEMPORARY"),
    ("temp", "TEMPORARY"),
    ("intern", "INTERNSHIP"),
    ("internship", "INTERNSHIP"),
    ("graduate", "INTERNSHIP"),
]


# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------

@dataclass
class Role:
    employer: str
    title: str
    location: str = ""
    description: str = ""           # HTML preferred
    application_url: str = ""
    employment_type: str = "FULL_TIME"
    closing_date: str = ""           # ISO YYYY-MM-DD if known


def is_hse(*texts: str) -> bool:
    blob = " ".join(t.lower() for t in texts if t)
    return any(k in blob for k in HSE_KEYWORDS)


def infer_employment_type(*texts: str) -> str:
    blob = " ".join(t.lower() for t in texts if t)
    for needle, value in EMPLOYMENT_TYPE_MAP:
        if needle in blob:
            return value
    return "FULL_TIME"


def make_slug(title: str, company: str) -> str:
    raw = f"{title}-{company}".lower()
    raw = re.sub(r"[^a-z0-9]+", "-", raw)
    return raw.strip("-")


# ---------------------------------------------------------------------------
# Parser registry
# ---------------------------------------------------------------------------

class Parser(Protocol):
    def __init__(self, page: Page) -> None: ...
    def parse(self, employer_name: str, search_url: str) -> list[Role]: ...


class SuccessFactorsParser:
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

    def collect_links(self, search_url: str, max_pages: int = 5) -> list[str]:
        page = self.page
        try:
            page.goto(search_url, wait_until="networkidle", timeout=45000)
        except PWTimeout:
            print(f"timeout loading search page {search_url}", file=sys.stderr)
            return []
        except Exception as e:
            print(
                f"error loading search page {search_url}: "
                f"{type(e).__name__}: {e}",
                file=sys.stderr,
            )
            return []

        seen: list[str] = []
        for page_idx in range(max_pages):
            page_links: list[str] = []
            for sel in self.LIST_LINK_SELECTORS:
                try:
                    els = page.query_selector_all(sel)
                except Exception:
                    els = []
                if not els:
                    continue
                for el in els:
                    try:
                        href = el.get_attribute("href") or ""
                    except Exception:
                        href = ""
                    if href:
                        page_links.append(urljoin(search_url, href))
                break
            if not page_links:
                print(
                    f"no list-link selector matched on {page.url} "
                    f"(page index {page_idx})",
                    file=sys.stderr,
                )

            for link in page_links:
                if link not in seen:
                    seen.append(link)

            advanced = False
            for sel in self.NEXT_PAGE_SELECTORS:
                try:
                    nxt = page.query_selector(sel)
                except Exception:
                    nxt = None
                if not nxt:
                    continue
                try:
                    nxt.click()
                    page.wait_for_load_state("networkidle", timeout=20000)
                    advanced = True
                    break
                except Exception:
                    continue
            if not advanced:
                break
        return seen

    def parse_detail(self, employer: str, url: str) -> Role | None:
        page = self.page
        try:
            page.goto(url, wait_until="networkidle", timeout=45000)
        except PWTimeout:
            print(f"timeout loading detail {url}", file=sys.stderr)
            return None
        except Exception as e:
            print(
                f"error loading detail {url}: {type(e).__name__}: {e}",
                file=sys.stderr,
            )
            return None

        title = self._first_text(page, self.DETAIL_TITLE_SELECTORS)
        if not title:
            print(f"no title selector matched on {url}", file=sys.stderr)
            return None

        location = self._first_text(page, self.DETAIL_LOCATION_SELECTORS)
        description_html = self._first_html(page, self.DETAIL_DESCRIPTION_SELECTORS)
        description_text = self._first_text(page, self.DETAIL_DESCRIPTION_SELECTORS)
        if not description_html and not description_text:
            print(f"no description selector matched on {url}", file=sys.stderr)

        if not is_hse(title):
            return None

        return Role(
            employer=employer,
            title=title,
            location=location,
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


PARSERS: dict[str, type] = {
    "successfactors": SuccessFactorsParser,
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
    }
    if role.location:
        payload["location"] = role.location
    if role.closing_date:
        payload["closingDate"] = role.closing_date
    return payload


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    api_key = os.environ.get("ENTIRELYSAFE_API_KEY", "").strip()
    if not api_key:
        print("ENTIRELYSAFE_API_KEY is not set", file=sys.stderr)
        return 1

    try:
        employers = load_employers()
    except (FileNotFoundError, ValueError) as e:
        print(f"config error: {e}", file=sys.stderr)
        return 1

    client = EntirelySafeClient(api_key)

    summary: dict = {
        "checked": 0,
        "skipped_inactive": 0,
        "found": 0,
        "published": 0,
        "skipped_duplicate": 0,
        "errors": [],
        "published_roles": [],
    }

    try:
        existing = client.list_vacancies()
    except AuthHaltError as e:
        print(f"auth failure listing vacancies (halting): {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(
            f"failed to list existing vacancies: {type(e).__name__}: {e}",
            file=sys.stderr,
        )
        return 1

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

    auth_halt = False

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
                if not name or not url or not ats:
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
                    summary["errors"].append(
                        f"{name}: no parser registered for ATS '{ats}'"
                    )
                    continue

                try:
                    parser = parser_cls(page)
                    roles = parser.parse(name, url)
                except Exception as e:
                    summary["errors"].append(
                        f"{name}: {type(e).__name__}: {e}"
                    )
                    continue

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
                        continue

                    payload = build_payload(role, slug)
                    status, data, message = client.post_vacancy(payload)

                    if status == "ok":
                        existing_slugs.add(slug)
                        existing_title_company.add(title_company)
                        summary["published"] += 1
                        summary["published_roles"].append({
                            "employer": role.employer,
                            "title": role.title,
                            "location": role.location,
                            "slug": slug,
                            "id": (data or {}).get("id", ""),
                            "url": role.application_url,
                        })
                    elif status == "auth":
                        summary["errors"].append(
                            f"auth halt during POST: {message}"
                        )
                        auth_halt = True
                        break
                    else:
                        summary["errors"].append(
                            f"{name} / {role.title}: {message}"
                        )

                if auth_halt:
                    break
        finally:
            try:
                browser.close()
            except Exception:
                pass

    print(json.dumps(summary, indent=2))
    return 1 if auth_halt else 0


if __name__ == "__main__":
    sys.exit(main())
