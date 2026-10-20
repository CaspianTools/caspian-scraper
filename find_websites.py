"""Find careers websites to scrape — the admin app's "Find websites", no AI.

    python find_websites.py "HSE jobs" --country Qatar --country UAE
    python find_websites.py "HSE jobs" --no-web          # built-in list only
    echo '{"query": "HSE jobs"}' | python find_websites.py --json   # the app

Two sources:
  * catalog — employers.json, the repo's curated list of HSE employers,
              matched by country (aliases like "UAE" ↔ "United Arab Emirates"
              and region words like "Middle East" / "GCC") and keywords.
  * web     — a few searches on the Brave Search API (a normal search engine
              API, no AI), filtered to employers' own careers pages: job
              boards, social networks and news sites are dropped, and each
              website is kept once. Needs a Brave Search API key: saved in the
              admin app (stored in local-data/, never committed) or the
              BRAVE_SEARCH_API_KEY environment variable.

Every suggestion is then opened to check it works and to detect its careers
platform. Only SuccessFactors and Jibe have parsers today, so anything else is
offered as "saved, not scraped yet".

Plain search-engine scraping isn't used: DuckDuckGo and Bing block or feed
junk to automated queries, even from a real headless browser.

--json prints one object to stdout:
    {"catalog": [...], "web": [...],
     "web_status": "ok"|"no_key"|"bad_key"|"limited"|"error"|"off", "web_error": str}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import requests

REPO_ROOT = Path(__file__).resolve().parent
CATALOG_FILE = REPO_ROOT / "employers.json"

SUPPORTED_ATS = ("successfactors", "jibe")
CATALOG_LIMIT = 25
WEB_LIMIT = 15
VERIFY_TIMEOUT_S = 12
SEARCH_TIMEOUT_S = 15
CHECK_UA = "Mozilla/5.0 (compatible; CaspianScraper/1.0; +careers-discovery)"
BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
KEY_ENV = "BRAVE_SEARCH_API_KEY"

REGIONS = {
    "middle east": ["uae", "saudi arabia", "qatar", "oman", "kuwait", "bahrain", "iraq",
                    "iran", "jordan", "egypt", "syria", "lebanon", "yemen", "palestine"],
    "gulf": ["uae", "saudi arabia", "qatar", "oman", "kuwait", "bahrain"],
    "gcc": ["uae", "saudi arabia", "qatar", "oman", "kuwait", "bahrain"],
}
# Country spellings that mean the same place (keys and values are canonical-folded).
COUNTRY_ALIASES = {
    "united arab emirates": "uae", "u.a.e.": "uae", "emirates": "uae",
    "kingdom of saudi arabia": "saudi arabia", "ksa": "saudi arabia",
    "türkiye": "turkey", "turkiye": "turkey",
    "united kingdom": "uk", "great britain": "uk", "britain": "uk",
    "united states": "usa", "united states of america": "usa", "us": "usa",
    "state of palestine": "palestine",
}
STOPWORDS = {"jobs", "job", "the", "and", "for", "with", "vacancies", "careers",
             "career", "roles", "role", "in", "of", "hse"}

# Never suggest these: job boards, aggregators, social and reference sites.
SKIP_DOMAINS = (
    "linkedin.", "indeed.", "glassdoor.", "bayt.", "naukrigulf.", "naukri.",
    "gulftalent.", "monster", "ziprecruiter.", "simplyhired.", "jooble.", "careerjet.",
    "dubizzle.", "talent.com", "jobrapido.", "adzuna.", "totaljobs.", "reed.co.uk",
    "facebook.", "twitter.", "x.com", "instagram.", "youtube.", "tiktok.", "reddit.",
    "quora.", "wikipedia.", "medium.com", "google.", "bing.", "duckduckgo.",
    "yahoo.", "amazon.", "apple.com",
)
CAREERS_WORDS = re.compile(r"career|jobs?\b|vacanc|recruit|talent|join[-_ ]?us|opportunit|work[-_ ]?with", re.I)


def fold_country(c: str) -> str:
    c = (c or "").strip().lower()
    return COUNTRY_ALIASES.get(c, c)


def _norm_url(u: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", (u or "").strip().lower()).rstrip("/")


def _host(u: str) -> str:
    return re.sub(r"^www\.", "", urlparse(u).netloc.lower())


# ---- verification ----------------------------------------------------------

def detect_ats(html: str) -> str:
    h = html.lower()
    if "jibecdn" in h:
        return "jibe"
    if any(m in h for m in ("data-careersite-propertyid", "successfactors",
                            "jobs2web", "rmkcdn")):
        return "successfactors"
    return "unknown"


def verify(url: str) -> dict:
    try:
        r = requests.get(url, timeout=VERIFY_TIMEOUT_S, allow_redirects=True,
                         headers={"User-Agent": CHECK_UA, "Accept": "text/html,*/*"})
    except requests.RequestException as e:
        return {"reachable": False, "status": None, "detected_ats": "unknown",
                "note": f"couldn't open the page ({type(e).__name__})"}
    if r.status_code in (401, 403, 429):
        return {"reachable": False, "status": r.status_code, "detected_ats": "unknown",
                "note": "the site blocked the automatic check - it may still open in a browser"}
    if r.status_code >= 400:
        return {"reachable": False, "status": r.status_code, "detected_ats": "unknown",
                "note": f"page returned HTTP {r.status_code}"}
    return {"reachable": True, "status": r.status_code,
            "detected_ats": detect_ats(r.text[:500_000]), "note": ""}


def _finish(s: dict) -> dict:
    v = verify(s["careers_url"])
    s.update(v)
    known = s.pop("catalog_ats", "unknown")
    s["ats"] = v["detected_ats"] if v["detected_ats"] != "unknown" else (
        known if known in SUPPORTED_ATS else "unknown")
    s["scrapable"] = s["reachable"] and s["ats"] in SUPPORTED_ATS
    return s


def verify_all(items: list[dict]) -> list[dict]:
    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(_finish, items))


# ---- catalog ---------------------------------------------------------------

def wanted_countries(query: str, countries: list[str]) -> set[str]:
    want = {fold_country(c) for c in countries if c.strip()}
    q = (query or "").lower()
    for region, members in REGIONS.items():
        if region in q:
            want |= set(members) | {"regional"}
    return want


def catalog_matches(query: str, countries: list[str], exclude: set[str]) -> list[dict]:
    try:
        entries = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    want = wanted_countries(query, countries)
    tokens = [t for t in re.findall(r"[a-z0-9]{3,}", (query or "").lower()) if t not in STOPWORDS]

    scored = []
    for e in entries:
        url = str(e.get("careers_url") or "").strip()
        if not url.startswith("http") or _norm_url(url) in exclude:
            continue
        ecountries = [str(c) for c in e.get("countries") or []]
        hay = " ".join(str(e.get(k) or "") for k in
                       ("name", "segment", "notes", "headquarters", "kind", "type")).lower()
        hay += " " + " ".join(ecountries).lower()
        score = 3 * sum(1 for c in ecountries if fold_country(c) in want)
        score += sum(1 for t in tokens if t in hay)
        if (want or tokens) and score == 0:
            continue
        scored.append((score, e.get("ats") in SUPPORTED_ATS, e, url, ecountries))

    scored.sort(key=lambda x: (-x[0], not x[1], str(x[2].get("name") or "").lower()))
    return [{
        "name": str(e.get("name") or url),
        "careers_url": url,
        "countries": ecountries,
        "catalog_ats": str(e.get("ats") or "unknown"),
        "why": str(e.get("segment") or e.get("notes") or "")[:200],
        "source": "catalog",
    } for _s, _sup, e, url, ecountries in scored[:CATALOG_LIMIT]]


# ---- web search (Brave Search API) ------------------------------------------

class SearchError(Exception):
    def __init__(self, status: str, message: str):
        super().__init__(message)
        self.status = status  # "bad_key" | "limited" | "error"


def brave_search(key: str, q: str) -> list[tuple[str, str]]:
    """One Brave web search → [(title, url)]."""
    try:
        r = requests.get(BRAVE_URL, params={"q": q, "count": 20},
                         headers={"Accept": "application/json", "X-Subscription-Token": key},
                         timeout=SEARCH_TIMEOUT_S)
    except requests.RequestException as e:
        raise SearchError("error", f"couldn't reach Brave Search ({type(e).__name__})") from e
    if r.status_code >= 400:
        # Brave reports the reason in {"error": {"code", "detail", "meta":
        # {"component"}}} — e.g. a bad key is 422 SUBSCRIPTION_TOKEN_INVALID.
        try:
            err = (r.json() or {}).get("error") or {}
        except ValueError:
            err = {}
        code = str(err.get("code") or "").upper()
        detail = str(err.get("detail") or "")
        if (r.status_code in (401, 403) or "TOKEN" in code
                or (err.get("meta") or {}).get("component") == "authentication"):
            raise SearchError("bad_key", "Brave Search rejected the API key")
        if r.status_code in (402, 429) or "RATE" in code or "QUOTA" in code:
            raise SearchError("limited", "Brave Search quota or rate limit reached - check your plan")
        raise SearchError("error", f"Brave Search returned HTTP {r.status_code}"
                                   + (f": {detail}" if detail else ""))
    try:
        items = (r.json().get("web") or {}).get("results") or []
    except ValueError as e:
        raise SearchError("error", "Brave Search returned invalid JSON") from e
    return [(str(i.get("title") or ""), str(i.get("url") or "")) for i in items
            if str(i.get("url") or "").startswith("http")]


def build_queries(query: str, countries: list[str]) -> list[str]:
    base = query.strip() or "HSE health safety environment jobs"
    if not CAREERS_WORDS.search(base):
        base += " careers"
    qs = [base, f"{base} official careers site"]
    qs += [f"{base} {c}" for c in countries[:3]]
    return qs


def is_candidate(title: str, url: str) -> bool:
    host = _host(url)
    if not host or any(s in host for s in SKIP_DOMAINS):
        return False
    return bool(CAREERS_WORDS.search(url) or CAREERS_WORDS.search(title))


def site_name(title: str, url: str) -> str:
    """'Careers at Acme | Acme Corp' → 'Acme Corp'; falls back to the host."""
    parts = [p.strip() for p in re.split(r"\s[|\-–—:]\s", title) if p.strip()]
    plain = [p for p in parts if not CAREERS_WORDS.search(p)]
    if plain:
        return plain[-1][:120]
    m = re.match(r"(?:careers|jobs)\s+(?:at|with)\s+(.+)", title.strip(), re.I)
    if m:
        return m.group(1).strip()[:120]
    return _host(url)


def web_search(key: str, query: str, countries: list[str], exclude: set[str]) -> list[dict]:
    results: list[tuple[str, str]] = []
    for q in build_queries(query, countries):
        results += brave_search(key, q)

    out, seen_hosts = [], set()
    for title, url in results:
        host = _host(url)
        if host in seen_hosts or _norm_url(url) in exclude or not is_candidate(title, url):
            continue
        seen_hosts.add(host)
        out.append({
            "name": site_name(title, url),
            "careers_url": url,
            "countries": [],
            "catalog_ats": "unknown",
            "why": title[:200],
            "source": "web",
        })
        if len(out) >= WEB_LIMIT:
            break
    return out


def load_search_key(owner_uid: str = "local") -> str:
    """The admin app's saved key (local-data/search_settings/<uid>.json),
    else the BRAVE_SEARCH_API_KEY environment variable."""
    try:
        from localdb import LocalDB

        snap = LocalDB().collection("search_settings").document(owner_uid).get()
        saved = str((snap.to_dict() or {}).get("value") or "").strip() if snap.exists else ""
    except Exception:  # noqa: BLE001 — fall back to the environment
        saved = ""
    return saved or os.environ.get(KEY_ENV, "").strip()


# ---- entry points ----------------------------------------------------------

def discover(query: str, countries: list[str], *, use_web: bool = True,
             exclude_urls: list[str] = (), search_key: str | None = None) -> dict:
    exclude = {_norm_url(u) for u in exclude_urls}
    catalog = catalog_matches(query, countries, exclude)
    result: dict = {"catalog": [], "web": [], "web_status": "off", "web_error": ""}

    web: list[dict] = []
    if use_web:
        key = search_key if search_key is not None else load_search_key()
        if not key:
            result["web_status"] = "no_key"
        else:
            skip_urls = exclude | {_norm_url(c["careers_url"]) for c in catalog}
            try:
                web = web_search(key, query, countries, skip_urls)
                result["web_status"] = "ok"
            except SearchError as e:
                result["web_status"], result["web_error"] = e.status, str(e)[:300]
            catalog_hosts = {_host(c["careers_url"]) for c in catalog}
            web = [w for w in web if _host(w["careers_url"]) not in catalog_hosts]

    checked = verify_all(catalog + web)
    result["catalog"] = [s for s in checked if s["source"] == "catalog"]
    result["web"] = [s for s in checked if s["source"] == "web"]
    return result


def _print_table(result: dict) -> None:
    def status(s: dict) -> str:
        if not s["reachable"]:
            return "couldn't check"
        return f"{s['ats']} - will be scraped" if s["scrapable"] else "other platform"

    for title, key in (("From the web", "web"), ("From the built-in list", "catalog")):
        print(f"\n{title} ({len(result[key])}):")
        for s in result[key]:
            print(f"  {s['name'][:40]:40}  {status(s):32}  {s['careers_url']}")
    if result["web_status"] == "no_key":
        print(f"\nWeb search skipped: no Brave Search API key (save one in the app or set {KEY_ENV}).")
    elif result["web_error"]:
        print(f"\nWeb search failed: {result['web_error']}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("query", nargs="?", default="", help='e.g. "HSE jobs oil and gas"')
    ap.add_argument("--country", action="append", default=[], help="repeatable")
    ap.add_argument("--no-web", action="store_true", help="built-in list only")
    ap.add_argument("--json", action="store_true",
                    help="machine output; with no query, read the request as JSON on stdin")
    args = ap.parse_args(argv)

    if args.json and not args.query:
        req = json.loads(sys.stdin.read() or "{}")
        result = discover(
            str(req.get("query") or ""),
            [str(c) for c in req.get("countries") or []],
            use_web=bool(req.get("use_web", True)),
            exclude_urls=[str(u) for u in req.get("exclude_urls") or []],
            search_key=load_search_key(str(req.get("owner_uid") or "local")),
        )
    else:
        result = discover(args.query, args.country, use_web=not args.no_web)

    if args.json:
        # ASCII-only JSON: Windows pipes use the console code page, not UTF-8.
        print(json.dumps(result))
    else:
        _print_table(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
