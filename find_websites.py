"""Find careers websites to scrape — the admin app's "Find websites".
Free: no AI, no API keys, no billing.

    python find_websites.py "HSE jobs" --country Qatar --country UAE
    python find_websites.py "HSE jobs" --no-web          # built-in list only
    echo '{"query": "HSE jobs"}' | python find_websites.py --json   # the app

Three sources:
  * catalog   — employers.json, the repo's curated list of HSE employers,
                matched by country (aliases like "UAE" ↔ "United Arab
                Emirates" and region words like "Middle East" / "GCC").
  * directory — Wikidata (free, open, built for programs — no blocking):
                companies registered in the chosen countries, filtered to
                industries that hire HSE staff (or to the industry words in
                the query), most notable first. Each company's careers page
                is found by following the "Careers" link on its homepage,
                else by trying the usual addresses (/careers, careers.<site>).
                Needs countries (picked, or region words in the query).
  * web       — real web searches run in a Playwright browser: DuckDuckGo
                first, Google for any query DuckDuckGo leaves empty. Job
                boards, blogs, social and news sites are dropped, and each
                website is kept once. Search engines throttle after a few
                queries, so this adds a handful of extra employers per run.

Why a visible-but-off-screen browser: search engines block automated
clients. Measured on this project's machine (4 queries in a row each):
DuckDuckGo answered 4/4 in a headed browser but 0/4 headless; Google
answered 4/4 in real Chrome. Plain HTTP requests got blocks or junk from
DuckDuckGo, Bing, Startpage and Yahoo. So the search browser is headed with
its window placed off-screen, uses installed Google Chrome when present
(falling back to Playwright's Chromium), and hides navigator.webdriver.
Set FIND_WEBSITES_HEADLESS=1 to force headless (e.g. no display).

Every suggestion is then opened to check it works and to detect its careers
platform. Only SuccessFactors and Jibe have parsers today, so anything else is
offered as "saved, not scraped yet".

--json prints one object to stdout:
    {"catalog": [...], "directory": [...], "web": [...],
     "directory_status": "ok"|"error"|"off", "directory_error": str,
     "web_status": "ok"|"blocked"|"error"|"off",
     "web_engines": ["duckduckgo", "google"], "web_error": str}
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urlparse

import requests

REPO_ROOT = Path(__file__).resolve().parent
CATALOG_FILE = REPO_ROOT / "employers.json"

SUPPORTED_ATS = ("successfactors", "jibe")
CATALOG_LIMIT = 25
WEB_LIMIT = 15
VERIFY_TIMEOUT_S = 12
SEARCH_WAIT_MS = 10_000      # for a results page to render
SEARCH_PAUSE_S = (1.5, 3.0)  # random pause between queries, like a person
CHECK_UA = "Mozilla/5.0 (compatible; CaspianScraper/1.0; +careers-discovery)"
HEADLESS_ENV = "FIND_WEBSITES_HEADLESS"
WIKIDATA_URL = "https://query.wikidata.org/sparql"
WIKIDATA_UA = "CaspianScraper/1.0 (careers discovery; local tool)"
DIRECTORY_LIMIT = 30          # companies to look up careers pages for
PROBE_TIMEOUT_S = 6
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

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
    "yahoo.", "amazon.", "apple.com", "jobsora.", "drjobpro.", "drjobs.", "laimoon.",
    "gulfjobs", "qatarliving.", "expatriates.", "jobzpk.", "rozee.", "careerbuilder.",
    "wuzzuf.", "akhtaboot.", "tanqeeb.", "jora.", "whatjobs.", "jobted.", "neuvoo.",
    "trovit.", "learn4good.", "jobisjob.", "glassdoor", "ambitionbox.", "jobstreet.",
    "seek.com", "workday.com/en-us", "hse-jobs", "oilandgasjobsearch.", "rigzone.", "foundit",
)
# Aggregator listing titles: "400+ HSE Jobs, Employment in Qatar", "Hse jobs in
# Qatar (October-2026)". An employer's own careers page doesn't look like this.
AGGREGATOR_TITLE = re.compile(
    r"^\s*[\d,.]+\+?\s|\bjobs? in\b.*\b(20\d\d|today|now)\b|\(\w+[- ]20\d\d\)|vacancies in\b",
    re.I,
)
CAREERS_WORDS = re.compile(r"career|jobs?\b|vacanc|recruit|talent|join[-_ ]?us|opportunit|work[-_ ]?with", re.I)


def fold_country(c: str) -> str:
    c = (c or "").strip().lower()
    return COUNTRY_ALIASES.get(c, c)


def _norm_url(u: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", (u or "").strip().lower()).rstrip("/")


def _host(u: str) -> str:
    return re.sub(r"^www\.", "", (urlparse(u).hostname or "").lower())


def _clean_url(u: str) -> str:
    """Drop default ports (https://x:443/ → https://x/) so duplicates match."""
    return re.sub(r"^(https://[^/:]+):443(?=/|$)|^(http://[^/:]+):80(?=/|$)",
                  lambda m: m.group(1) or m.group(2), u)


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
    v = s.pop("_checked", None) or verify(s["careers_url"])
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


# ---- directory (Wikidata) --------------------------------------------------

# Industries that employ HSE staff — the default filter (Wikidata labels).
HSE_INDUSTRIES = re.compile(
    r"petrol|\boil\b|natural gas|\bgas\b|energy|electric|power|utilit|water|construct|"
    r"engineer|chemic|mining|metal|steel|alumin|cement|fertili|manufactur|refin|"
    r"transport|freight|logistic|shipping|\bport|aviation|airline|railway|maritime|"
    r"health ?care|hospitals?\b|pharmac|defen[cs]e|infrastructure",
    re.I,
)
# Our country names → Wikidata's English labels where they differ.
WIKIDATA_COUNTRY = {
    "uae": "United Arab Emirates", "usa": "United States", "uk": "United Kingdom",
    "turkey": "Turkey", "côte d'ivoire": "Ivory Coast", "czechia": "Czech Republic",
    "palestine": "State of Palestine", "vatican city": "Vatican City",
}


def _country_labels(countries: list[str], query: str) -> list[str]:
    labels = []
    for c in sorted(wanted_countries(query, countries) - {"regional"}):
        labels.append(WIKIDATA_COUNTRY.get(c) or c.title().replace(" And ", " and "))
    return labels


def _wikidata_country(label: str) -> list[dict]:
    """One country's companies (with website + industry), most notable first.
    One query per country: a single query over many countries times out."""
    sparql = f"""
SELECT ?co ?coLabel ?site ?links (GROUP_CONCAT(DISTINCT ?indLabel; separator="|") AS ?inds) WHERE {{
  ?c rdfs:label {json.dumps(label)}@en ; wdt:P31 wd:Q3624078 .
  ?co wdt:P17 ?c ; wdt:P856 ?site ; wdt:P452 ?ind ; wikibase:sitelinks ?links .
  ?ind rdfs:label ?indLabel FILTER(LANG(?indLabel) = "en")
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} GROUP BY ?co ?coLabel ?site ?links ORDER BY DESC(?links) LIMIT 200"""
    r = requests.get(WIKIDATA_URL, params={"query": sparql, "format": "json"},
                     headers={"User-Agent": WIKIDATA_UA, "Accept": "application/sparql-results+json"},
                     timeout=45)
    r.raise_for_status()
    return [{
        "name": b["coLabel"]["value"],
        "website": b["site"]["value"],
        "links": int(b["links"]["value"]),
        "industries": [x for x in b.get("inds", {}).get("value", "").split("|") if x],
        "country": label,
    } for b in r.json()["results"]["bindings"]]


def wikidata_companies(countries: list[str], query: str) -> list[dict]:
    """Companies in the chosen countries, filtered by industry: the industry
    words in the query when they match Wikidata's labels ("construction",
    "aviation"), else the industries that hire HSE staff. Most notable
    (Wikipedia sitelinks) first, capped at DIRECTORY_LIMIT."""
    labels = _country_labels(countries, query)
    if not labels:
        return []
    rows: list[dict] = []
    errors = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        for got in pool.map(lambda lab: _safe(_wikidata_country, lab, errors), labels):
            rows += got
    if not rows and errors:
        raise RuntimeError(errors[0])
    rows.sort(key=lambda r: -r["links"])

    all_inds = " ".join(i for r in rows for i in r["industries"]).lower()
    words = [t for t in re.findall(r"[a-z]{4,}", query.lower())
             if t not in STOPWORDS and t not in {"health", "safety", "environment", "officer",
                                                 "engineer", "middle", "east", "gulf"}]
    typed = [w for w in words if w in all_inds]  # industry words Wikidata knows

    out, seen = [], set()
    for r in rows:
        host = _host(r["website"])
        inds = " ".join(r["industries"])
        if not host or host in seen:
            continue
        if typed:
            if not any(w in inds.lower() for w in typed):
                continue
        elif not HSE_INDUSTRIES.search(inds):
            continue
        seen.add(host)
        out.append(r)
        if len(out) >= DIRECTORY_LIMIT:
            break
    return out


def _safe(fn, arg, errors: list):
    try:
        return fn(arg)
    except Exception as e:  # noqa: BLE001 — one slow country mustn't sink the rest
        errors.append(f"{type(e).__name__}: {e}"[:200])
        return []


def _get(url: str):
    try:
        return requests.get(url, headers={"User-Agent": BROWSER_UA, "Accept": "text/html,*/*"},
                            timeout=PROBE_TIMEOUT_S, allow_redirects=True)
    except requests.RequestException:
        return None


def _looks_like_careers(r) -> bool:
    if r is None or not r.ok:
        return False
    fin = urlparse(r.url)
    m = re.search(r"<title[^>]*>(.*?)</title>", r.text[:30_000], re.S | re.I)
    title = m.group(1) if m else ""
    on_home = fin.path in ("", "/") and not CAREERS_WORDS.search(fin.netloc)
    return not on_home and bool(CAREERS_WORDS.search(fin.netloc + fin.path) or CAREERS_WORDS.search(title))


def find_careers_page(website: str):
    """The careers page of a company website: the homepage's own "Careers"
    link first (survives redesigns and moved domains), else the usual
    addresses. Returns the careers page's response, or None."""
    home = _get(website)
    if home is not None and home.ok:
        from bs4 import BeautifulSoup
        from urllib.parse import urljoin

        soup = BeautifulSoup(home.text[:800_000], "html.parser")
        links = []
        for a in soup.find_all("a", href=True):
            text = " ".join(a.get_text(" ", strip=True).split())
            href = a["href"].strip()
            if href.startswith(("mailto:", "tel:", "javascript:", "#")):
                continue
            if CAREERS_WORDS.search(text) or CAREERS_WORDS.search(href):
                score = 0 if re.fullmatch(r"(?i)careers?|jobs|join us|work with us", text) else 1
                links.append((score, len(href), urljoin(home.url, href)))
        for _score, _len, url in sorted(links)[:2]:
            if any(s in _host(url) for s in SKIP_DOMAINS):
                continue
            r = _get(url)
            if _looks_like_careers(r):
                return r
        base = home.url
    else:
        base = website
    u = urlparse(base)
    origin, dom = f"{u.scheme or 'https'}://{u.netloc}", re.sub(r"^www\.", "", u.netloc)
    for guess in (f"{origin}/careers", f"https://careers.{dom}"):
        r = _get(guess)
        if _looks_like_careers(r):
            return r
    return None


def directory_suggestions(countries: list[str], query: str, exclude: set[str]) -> list[dict]:
    companies = wikidata_companies(countries, query)
    with ThreadPoolExecutor(max_workers=16) as pool:
        pages = list(pool.map(lambda c: find_careers_page(c["website"]), companies))
    out, seen_hosts = [], set()
    for c, resp in zip(companies, pages):
        if resp is None:
            continue
        page = _clean_url(resp.url)
        if _norm_url(page) in exclude or _host(page) in seen_hosts:
            continue
        seen_hosts.add(_host(page))
        # Items without an English label come back as their id ("Q1634762").
        name = c["name"] if not re.fullmatch(r"Q\d+", c["name"]) else _host(c["website"])
        out.append({
            "name": name[:120],
            "careers_url": page,
            "_checked": {"reachable": True, "status": resp.status_code,
                         "detected_ats": detect_ats(resp.text[:500_000]), "note": ""},
            "countries": [c["country"]] if c["country"] else [],
            "catalog_ats": "unknown",
            "why": ", ".join(c["industries"][:3]),
            "source": "directory",
        })
    return out


# ---- web search (Playwright) ----------------------------------------------

class SearchBlocked(Exception):
    """Every engine refused or returned nothing."""


# Hide the automation tells sites check first.
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = window.chrome || {runtime: {}};
"""


def _ddg_href(href: str) -> str:
    """DuckDuckGo wraps results as //duckduckgo.com/l/?uddg=<real url>."""
    if "duckduckgo.com/l/" in href:
        full = href if href.startswith("http") else "https:" + href
        return parse_qs(urlparse(full).query).get("uddg", [""])[0]
    return href


def _google_href(href: str) -> str:
    """Google sometimes links as /url?q=<real url>."""
    if href.startswith("/url?") or "google.com/url?" in href:
        return parse_qs(urlparse(href).query).get("q", [""])[0]
    return href


ENGINES = {
    # name: (results URL for a query, result-link selector, href unwrapper)
    "duckduckgo": (lambda q: f"https://html.duckduckgo.com/html/?q={quote_plus(q)}",
                   "a.result__a", _ddg_href),
    "google": (lambda q: f"https://www.google.com/search?q={quote_plus(q)}&hl=en&num=20",
               "#search a:has(h3)", _google_href),
}
ENGINE_ORDER = ("duckduckgo", "google")


class BrowserSearch:
    """One browser for a whole run of queries (context manager)."""

    def __enter__(self) -> "BrowserSearch":
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        headless = os.environ.get(HEADLESS_ENV, "").strip() in ("1", "true", "yes")
        args = ["--disable-blink-features=AutomationControlled"]
        if not headless:
            args.append("--window-position=-32000,-32000")  # headed, but out of sight
        self._browser = None
        for channel in ("chrome", "chromium"):  # real Chrome is trusted most
            try:
                self._browser = self._pw.chromium.launch(channel=channel, headless=headless, args=args)
                break
            except Exception:  # noqa: BLE001 — that channel isn't installed
                continue
        if self._browser is None:
            self._pw.stop()
            raise RuntimeError("no Chromium/Chrome available - run: python -m playwright install chromium")
        ua = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              f"Chrome/{self._browser.version} Safari/537.36")
        ctx = self._browser.new_context(locale="en-US", viewport={"width": 1366, "height": 900},
                                        user_agent=ua)
        ctx.add_init_script(STEALTH_JS)
        self._page = ctx.new_page()
        self.engines_used: list[str] = []
        self._queries = 0
        return self

    def __exit__(self, *exc) -> None:
        try:
            self._browser.close()
        finally:
            self._pw.stop()

    def _run(self, engine: str, q: str) -> list[tuple[str, str]]:
        url_for, selector, unwrap = ENGINES[engine]
        page = self._page
        page.goto(url_for(q), timeout=30_000, wait_until="domcontentloaded")
        try:
            page.wait_for_selector(selector, timeout=SEARCH_WAIT_MS)
        except Exception:  # noqa: BLE001 — no results / blocked
            return []
        rows = page.eval_on_selector_all(
            selector,
            "els => els.map(a => [(a.querySelector('h3') || a).innerText || '', a.getAttribute('href') || ''])",
        )
        out = []
        for title, href in rows:
            url = unwrap(href)
            if url.startswith("http"):
                out.append((" ".join(title.split()), url))
        return out

    def search(self, q: str) -> list[tuple[str, str]]:
        """Results for one query: DuckDuckGo, else Google."""
        if self._queries:
            time.sleep(random.uniform(*SEARCH_PAUSE_S))
        self._queries += 1
        for engine in ENGINE_ORDER:
            try:
                results = self._run(engine, q)
            except Exception:  # noqa: BLE001 — navigation error; try the next engine
                results = []
            if results:
                if engine not in self.engines_used:
                    self.engines_used.append(engine)
                return results
        return []


def _topic(query: str) -> str:
    """The user's words, with a bare 'HSE' spelled out: on the open web 'HSE'
    alone means the UK Health and Safety Executive or Ireland's Health
    Service Executive more often than safety jobs."""
    t = query.strip() or "HSE jobs"
    if re.search(r"\bhse\b", t, re.I) and not re.search(r"health|safety|environment", t, re.I):
        t = re.sub(r"\bhse\b", "HSE health safety environment", t, count=1, flags=re.I)
    return t


def build_queries(query: str, countries: list[str]) -> list[str]:
    """Searches aimed at employers' own careers pages. With countries, the
    budget goes to them (2 per country, up to 3 countries)."""
    topic = _topic(query)
    if countries:
        qs = []
        for c in countries[:3]:
            qs += [f"{topic} {c} company careers site", f"{c} companies careers {topic}"]
        return qs
    return [f"{topic} company careers site", f"companies hiring {topic} careers page",
            f"{topic} jobs employer careers portal"]


# A website whose own name is about jobs ("hsejobs.co.uk", "gulfcareergroup.com")
# is a board or agency; employer careers sites live under the company's own
# name ("jobs.acme.com", "acme.com/careers").
_BOARD_NAME = re.compile(
    r"job|career|vacanc|recruit|talent|hiring|employ|staffing|cv|blog|guide|study|news|magazine|forum|wiki|hse",
    re.I,
)
_SLD = {"co", "com", "org", "net", "gov", "ac", "edu"}


def _site_label(host: str) -> str:
    labels = host.split(".")
    if len(labels) >= 3 and labels[-2] in _SLD:
        return labels[-3]
    return labels[-2] if len(labels) >= 2 else host


def is_candidate(title: str, url: str) -> bool:
    host = _host(url)
    if not host or any(s in host for s in SKIP_DOMAINS):
        return False
    if AGGREGATOR_TITLE.search(title) or _BOARD_NAME.search(_site_label(host)):
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


def pick_sites(results: list[tuple[str, str]], exclude: set[str]) -> list[dict]:
    """Employer careers pages from raw search results, one per website."""
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


def web_search(query: str, countries: list[str], exclude: set[str]) -> tuple[list[dict], list[str]]:
    with BrowserSearch() as browser:
        results: list[tuple[str, str]] = []
        for q in build_queries(query, countries):
            results += browser.search(q)
        engines = browser.engines_used
    if not results:
        raise SearchBlocked("the search engines returned nothing - they may be blocking "
                            "automated searches right now; try again in a few minutes")
    return pick_sites(results, exclude), engines


# ---- entry points ----------------------------------------------------------

def discover(query: str, countries: list[str], *, use_web: bool = True,
             exclude_urls: list[str] = ()) -> dict:
    exclude = {_norm_url(u) for u in exclude_urls}
    catalog = catalog_matches(query, countries, exclude)
    result: dict = {"catalog": [], "directory": [], "web": [],
                    "directory_status": "off", "directory_error": "",
                    "web_status": "off", "web_engines": [], "web_error": ""}

    directory: list[dict] = []
    web: list[dict] = []
    if use_web:
        skip_urls = exclude | {_norm_url(c["careers_url"]) for c in catalog}
        # The directory (HTTP) and the search browser don't compete, so run
        # them side by side.
        with ThreadPoolExecutor(max_workers=2) as pool:
            dir_job = (pool.submit(directory_suggestions, countries, query, skip_urls)
                       if _country_labels(countries, query) else None)
            web_job = pool.submit(web_search, query, countries, skip_urls)
            if dir_job is not None:
                try:
                    directory = dir_job.result()
                    result["directory_status"] = "ok"
                except Exception as e:  # noqa: BLE001 — never lose the other results
                    result["directory_status"] = "error"
                    result["directory_error"] = f"{type(e).__name__}: {e}"[:300]
            try:
                web, result["web_engines"] = web_job.result()
                result["web_status"] = "ok"
            except SearchBlocked as e:
                result["web_status"], result["web_error"] = "blocked", str(e)
            except Exception as e:  # noqa: BLE001
                result["web_status"], result["web_error"] = "error", f"{type(e).__name__}: {e}"[:300]
        known_hosts = {_host(c["careers_url"]) for c in catalog}
        directory = [d for d in directory if _host(d["careers_url"]) not in known_hosts]
        known_hosts |= {_host(d["careers_url"]) for d in directory}
        web = [w for w in web if _host(w["careers_url"]) not in known_hosts]

    checked = verify_all(catalog + directory + web)
    for key in ("catalog", "directory", "web"):
        result[key] = [s for s in checked if s["source"] == key]
    return result


def _print_table(result: dict) -> None:
    def status(s: dict) -> str:
        if not s["reachable"]:
            return "couldn't check"
        return f"{s['ats']} - will be scraped" if s["scrapable"] else "other platform"

    for title, key in (("Companies in the chosen countries (Wikidata)", "directory"),
                       ("From the web", "web"), ("From the built-in list", "catalog")):
        print(f"\n{title} ({len(result[key])}):")
        for s in result[key]:
            print(f"  {s['name'][:40]:40}  {status(s):32}  {s['careers_url']}")
    if result["directory_error"]:
        print(f"\nCompany directory failed: {result['directory_error']}")
    if result["web_engines"]:
        print(f"\nWeb results via: {', '.join(result['web_engines'])}")
    if result["web_error"]:
        print(f"\nWeb search {result['web_status']}: {result['web_error']}")


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
