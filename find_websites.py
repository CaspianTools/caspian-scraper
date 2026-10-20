"""Find companies (and their careers websites) — the admin app's "Find
websites". Free: no AI, no API keys, no billing.

    python find_websites.py "HSE jobs" --country Qatar --country UAE
    python find_websites.py "training centres" --country Oman --no-web
    echo '{"query": "...", "countries": [...]}' | python find_websites.py --json
    echo '{"ids": ["adnoc.ae"]}' | python find_websites.py --enrich      # careers pages

Every search reads and grows the findings database (db/companies.jsonl, see
findings_db.py): everything it finds is saved there, and earlier finds that
match come back too, so results get richer over time. No built-in list.

Sources, merged into one list by website domain:
  * db           earlier finds that match the query and countries
  * google_maps  Google Maps places for "<topic> in <country>" (name,
                 category, website) — the richest source for local firms
  * google       Google Search results
  * duckduckgo   DuckDuckGo, for any search Google blocks or leaves empty
  * wikidata     every organisation with a website registered in the chosen
                 countries (free SPARQL endpoint), ranked by the query
  * osm          OpenStreetMap places whose name matches and that list a
                 website (free Overpass API)
The three browser sources run one after another in one off-screen Chrome
window; Wikidata and OpenStreetMap run alongside.

Query words are matched with typo tolerance ("trainign" → "training"), simple
plurals and synonyms (training ≈ education / academy / institute …); generic
words ("agencies", "companies", "jobs") don't narrow anything. With no
specific words (e.g. "HSE jobs"), industries that hire HSE staff are preferred.

Search doesn't open every company's site, so it returns in a minute or two.
Careers pages are found later, for the companies you pick (--enrich): the
homepage's own "Careers" link, else /careers or careers.<site>; the page is
opened to detect its careers platform (SuccessFactors / Jibe have parsers
today) and the result is saved to the database.

The browser: Google and DuckDuckGo block automated clients. Measured here (4
searches in a row): DuckDuckGo 4/4 headed vs 0/4 headless, Google 4/4 in
real Chrome; plain HTTP got blocks or junk everywhere. So the window is
headed but placed off-screen, uses installed Chrome when present, hides
navigator.webdriver and pauses between searches. Google's terms don't allow
automated searching and it may answer with a captcha; when it does, that
source is skipped for the rest of the run and the others carry on.
FIND_WEBSITES_HEADLESS=1 forces headless.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import random
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from urllib.parse import parse_qs, quote_plus, urljoin, urlparse

import requests

import findings_db as fdb

SUPPORTED_ATS = ("successfactors", "jibe")
RESULT_LIMIT = 400
WIKIDATA_ROWS_PER_COUNTRY = 3000
OSM_MAX_COUNTRIES = 4
BROWSER_MAX_COUNTRIES = 4      # Google Maps / Search countries per run
MAPS_MAX_SCROLLS = 12
VERIFY_LIMIT = 40              # known careers pages re-checked per search
RECHECK_AFTER_DAYS = 7
CHECK_TIMEOUT_S = 10
PROBE_TIMEOUT_S = 6
SEARCH_WAIT_MS = 12_000
SEARCH_PAUSE_S = (1.5, 3.0)
HEADLESS_ENV = "FIND_WEBSITES_HEADLESS"

WIKIDATA_URL = "https://query.wikidata.org/sparql"
OVERPASS_URLS = ("https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter")
TOOL_UA = "CaspianScraper/1.0 (careers discovery; local tool)"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")


# ---- countries ---------------------------------------------------------------

REGIONS = {
    "middle east": ["United Arab Emirates", "Saudi Arabia", "Qatar", "Oman", "Kuwait", "Bahrain",
                    "Iraq", "Iran", "Jordan", "Egypt", "Syria", "Lebanon", "Yemen", "Palestine"],
    "gulf": ["United Arab Emirates", "Saudi Arabia", "Qatar", "Oman", "Kuwait", "Bahrain"],
    "gcc": ["United Arab Emirates", "Saudi Arabia", "Qatar", "Oman", "Kuwait", "Bahrain"],
}
# Short / alternative names → the picker's names.
COUNTRY_ALIASES = {
    "uae": "United Arab Emirates", "u.a.e.": "United Arab Emirates", "emirates": "United Arab Emirates",
    "ksa": "Saudi Arabia", "kingdom of saudi arabia": "Saudi Arabia",
    "uk": "United Kingdom", "britain": "United Kingdom", "great britain": "United Kingdom",
    "usa": "United States", "us": "United States", "united states of america": "United States",
    "turkey": "Türkiye", "turkiye": "Türkiye", "state of palestine": "Palestine",
}
# Picker names → Wikidata's English labels where they differ.
WIKIDATA_COUNTRY = {
    "Türkiye": "Turkey", "Côte d'Ivoire": "Ivory Coast", "Czechia": "Czech Republic",
    "Palestine": "State of Palestine",
}


def canon_country(c: str) -> str:
    c = (c or "").strip()
    return COUNTRY_ALIASES.get(c.lower(), c)


def resolve_countries(query: str, countries: list[str]) -> list[str]:
    out = [canon_country(c) for c in countries if c.strip()]
    q = query.lower()
    for region, members in REGIONS.items():
        if re.search(rf"\b{region}\b", q):
            out += members
    return list(dict.fromkeys(out))


# ---- understanding the query -------------------------------------------------

# Concept → words that mean it (matched as word prefixes, lowercase).
SYNONYMS: dict[str, list[str]] = {
    "training": ["training", "trainer", "vocational", "academy", "academies", "institute",
                 "course", "skills", "certification", "coaching"],
    "education": ["education", "educational", "school", "college", "university", "learning"],
    "safety": ["safety", "hse", "health and safety", "occupational", "fire", "security", "risk"],
    "recruitment": ["recruitment", "recruiting", "staffing", "manpower", "employment", "headhunt",
                    "talent", "placement"],
    "oil": ["oil", "petroleum", "gas", "energy", "drilling", "offshore", "refin", "lng", "petrochemical"],
    "construction": ["construction", "contracting", "contractor", "building", "civil", "infrastructure"],
    "engineering": ["engineering", "engineer", "technical", "epc"],
    "consulting": ["consulting", "consultancy", "consultant", "advisory"],
    "health": ["hospital", "healthcare", "health care", "medical", "clinic", "pharma"],
    "logistics": ["logistics", "shipping", "freight", "transport", "port", "maritime", "marine"],
    "aviation": ["aviation", "airline", "airport", "aerospace"],
    "mining": ["mining", "mine", "minerals", "metals", "steel", "aluminium", "cement"],
    "manufacturing": ["manufacturing", "manufacturer", "factory", "industrial", "industries"],
    "utilities": ["utility", "utilities", "electricity", "power", "water"],
}
ALIAS_TO_CONCEPT = {w: c for c, ws in SYNONYMS.items() for w in ws}
# Words that say nothing about *which* organisations.
WEAK_WORDS = {
    "agency", "agencies", "company", "companies", "firm", "firms", "provider", "providers",
    "service", "services", "organisation", "organization", "business", "businesses", "centre",
    "center", "centers", "centres", "group", "groups", "jobs", "job", "careers", "career", "vacancy",
    "vacancies", "role", "roles", "work", "hiring", "the", "and", "for", "with", "in", "of", "near",
    "best", "top", "list", "local",
}
JOB_WORDS = {"jobs", "job", "careers", "career", "vacancy", "vacancies", "hiring", "roles", "role"}
# HSE roles: what "HSE jobs" means when nothing more specific is said.
HSE_INDUSTRIES = re.compile(
    r"petrol|\boil\b|natural gas|\bgas\b|energy|electric|power|utilit|water|construct|"
    r"engineer|chemic|mining|metal|steel|alumin|cement|fertili|manufactur|refin|"
    r"transport|freight|logistic|shipping|\bport|aviation|airline|railway|maritime|"
    r"health ?care|hospitals?\b|pharmac|defen[cs]e|infrastructure|drilling|offshore|contract",
    re.I,
)
# What to look up on Google Maps when the query is just "HSE jobs".
HSE_MAP_TOPICS = ("oil and gas company", "construction company", "engineering company")
VOCABULARY = sorted(set(ALIAS_TO_CONCEPT) | set(SYNONYMS) | WEAK_WORDS)


def _singular(w: str) -> str:
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def understand(query: str) -> dict:
    """{'corrected', 'topic', 'terms', 'hse'}.

    corrected: the query with typos fixed. topic: corrected minus job words
    ("training agencies jobs" → "training agencies"), for map searches.
    terms: one synonym group per specific word; a candidate must match every
    group. hse: prefer industries that hire HSE staff."""
    words = re.findall(r"[a-zà-ÿ0-9&]+", query.lower())
    corrected, terms = [], []
    for raw in words:
        w = raw
        if w not in VOCABULARY and _singular(w) not in VOCABULARY and len(w) >= 4:
            close = difflib.get_close_matches(w, VOCABULARY, n=1, cutoff=0.8)
            if close:
                w = close[0]
        corrected.append(w)
        base = _singular(w)
        if w in WEAK_WORDS or base in WEAK_WORDS or len(base) < 3:
            continue
        concept = ALIAS_TO_CONCEPT.get(w) or ALIAS_TO_CONCEPT.get(base)
        group = SYNONYMS[concept] if concept else [base]
        if group not in terms:
            terms.append(group)
    hse = (not terms) or any(g is SYNONYMS["safety"] for g in terms)
    # "HSE jobs": the safety group alone would only match safety *firms*;
    # HSE staff are hired across industries, so rely on the industry filter.
    if hse and all(g is SYNONYMS["safety"] for g in terms):
        terms = []
    topic = " ".join(w for w in corrected if w not in JOB_WORDS)
    return {"corrected": " ".join(corrected), "topic": topic, "terms": terms, "hse": hse}


def relevance(intent: dict, *, name: str, description: str = "", types=(), industries=()) -> int:
    """0 = not relevant. Name matches weigh most."""
    name_l, desc_l = name.lower(), description.lower()
    kinds = " ".join([*types, *industries]).lower()
    score = 0
    for group in intent["terms"]:
        if any(re.search(rf"\b{re.escape(w)}", name_l) for w in group):
            score += 3
        elif any(re.search(rf"\b{re.escape(w)}", kinds) for w in group):
            score += 2
        elif any(re.search(rf"\b{re.escape(w)}", desc_l) for w in group):
            score += 1
        else:
            return 0  # every specific word must match somewhere
    if intent["hse"]:
        if HSE_INDUSTRIES.search(kinds) or HSE_INDUSTRIES.search(desc_l) or HSE_INDUSTRIES.search(name_l):
            score += 2
        elif not intent["terms"]:
            return 0
    return score


ORG_TYPES = re.compile(
    r"business|compan|enterprise|organi[sz]ation|agency|institut|school|universit|"
    r"college|academy|hospital|clinic|airline|bank|corporation|conglomerate|firm|operator|"
    r"manufacturer|producer|contractor|consult|subsidiary|joint venture|state-owned|holding|"
    r"foundation|association|authority|ministry|provider|cooperative|startup|brand",
    re.I,
)


# ---- careers pages: find + check ----------------------------------------------

CAREERS_WORDS = re.compile(r"career|jobs?\b|vacanc|recruit|join[-_ ]?us|opportunit|work[-_ ]?with", re.I)
# Stricter tests for "this is THE careers page", not just a page mentioning
# jobs ("job seekers", "equal opportunities"): what the link says, where it
# points, and what the page calls itself.
CAREERS_LINK_TEXT = re.compile(
    r"^(careers?|jobs|job openings|vacancies|current (openings|vacancies)|join (us|our team)|"
    r"work (with|for) us|recruitment|careers? (at|with) .+|jobs at .+)$",
    re.I,
)
CAREERS_PATH = re.compile(
    r"/(careers?|jobs|vacanc(y|ies)|join-?us|join-our-team|work-with-us|work-for-us|recruitment|"
    r"current-openings|openings|job-openings)(?=/|$|\?|\.|-|_|#)",
    re.I,
)
CAREERS_HOST = re.compile(r"^(careers?|jobs|recruitment|talent)\.", re.I)
CAREERS_TITLE = re.compile(r"\bcareers?\b|\bvacancies\b|\bjobs at\b|\bjoin our team\b|\bopen positions\b", re.I)


def detect_ats(html: str) -> str:
    h = html.lower()
    if "jibecdn" in h:
        return "jibe"
    if any(m in h for m in ("data-careersite-propertyid", "successfactors", "jobs2web", "rmkcdn")):
        return "successfactors"
    return "unknown"


def _get(url: str, timeout: float = PROBE_TIMEOUT_S):
    try:
        return requests.get(url, headers={"User-Agent": BROWSER_UA, "Accept": "text/html,*/*"},
                            timeout=timeout, allow_redirects=True)
    except requests.RequestException:
        return None


def _clean_url(u: str) -> str:
    """Drop default ports (https://x:443/ → https://x/) so duplicates match."""
    return re.sub(r"^(https://[^/:]+):443(?=/|$)|^(http://[^/:]+):80(?=/|$)",
                  lambda m: m.group(1) or m.group(2), u)


def _strip_tracking(u: str) -> str:
    """Drop utm_* / gclid tracking parameters (Google Maps adds them)."""
    parts = urlparse(u)
    if not parts.query:
        return u
    keep = "&".join(p for p in parts.query.split("&")
                    if p and not re.match(r"(utm_[a-z]+|gclid|fbclid|y_source)=", p, re.I))
    return parts._replace(query=keep).geturl()


def _host(u: str) -> str:
    return re.sub(r"^www\.", "", (urlparse(u).hostname or "").lower())


def is_careers_url(url: str) -> bool:
    u = urlparse(url)
    return bool(CAREERS_HOST.search(u.hostname or "") or CAREERS_PATH.search(u.path))


def _looks_like_careers(r) -> bool:
    if r is None or not r.ok:
        return False
    if is_careers_url(r.url):
        return True
    m = re.search(r"<title[^>]*>(.*?)</title>", r.text[:30_000], re.S | re.I)
    fin = urlparse(r.url)
    return fin.path not in ("", "/") and bool(m and CAREERS_TITLE.search(m.group(1)))


def find_careers_page(website: str):
    """The careers page of a company website: the homepage's own "Careers"
    link first (survives redesigns and moved domains), else the usual
    addresses. Returns the page's response, or None."""
    home = _get(website)
    if home is not None and home.ok:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(home.text[:800_000], "html.parser")
        links = []
        for a in soup.find_all("a", href=True):
            text = " ".join(a.get_text(" ", strip=True).split())
            href = a["href"].strip()
            if href.startswith(("mailto:", "tel:", "javascript:", "#")):
                continue
            url = urljoin(home.url, href)
            if CAREERS_LINK_TEXT.match(text):
                links.append((0, len(href), url))
            elif is_careers_url(url):
                links.append((1, len(href), url))
        for _s, _l, url in sorted(links)[:2]:
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


def check_page(url: str) -> dict:
    """Open a careers page: does it work, which platform is it on."""
    r = _get(url, timeout=CHECK_TIMEOUT_S)
    base = {"checked_at": fdb.now_iso(), "ats": "unknown"}
    if r is None:
        return {**base, "reachable": False}
    if not r.ok:
        return {**base, "reachable": False}
    return {**base, "reachable": True, "ats": detect_ats(r.text[:500_000])}


def enrich(ids: list[str]) -> list[dict]:
    """Find + check careers pages for these database companies; save; return them."""
    records = fdb.load()

    def one(cid: str) -> dict | None:
        rec = records.get(cid)
        if not rec:
            return None
        update = {"id": cid}
        if not rec.get("careers_url") and rec.get("website"):
            r = find_careers_page(rec["website"])
            if r is not None:
                update.update({"careers_url": _clean_url(r.url), "reachable": True,
                               "ats": detect_ats(r.text[:500_000]), "checked_at": fdb.now_iso()})
            else:
                update.update({"reachable": False, "ats": "unknown", "checked_at": fdb.now_iso()})
        elif rec.get("careers_url"):
            update.update(check_page(rec["careers_url"]))
        return update

    with ThreadPoolExecutor(max_workers=12) as pool:
        updates = [u for u in pool.map(one, ids) if u]
    saved = fdb.upsert(updates)
    return [to_finding(saved[u["id"]], known=True) for u in updates if u["id"] in saved]


# ---- source: findings database -------------------------------------------------

def db_matches(intent: dict, countries: list[str], errors: list) -> list[dict]:
    want = {c.lower() for c in countries}
    out = []
    for rec in fdb.load().values():
        if want and not want & {canon_country(c).lower() for c in rec.get("countries", [])}:
            continue
        score = relevance(intent, name=rec.get("name", ""), description=rec.get("description", ""),
                          types=rec.get("types", []), industries=rec.get("industries", []))
        if score:
            out.append({**rec, "_score": score, "_known": True})
    return out


# ---- source: Wikidata ---------------------------------------------------------------

def _wikidata_country(country: str) -> list[dict]:
    label = WIKIDATA_COUNTRY.get(country, country)
    sparql = f"""
SELECT ?co ?coLabel ?coDescription ?site ?links
  (GROUP_CONCAT(DISTINCT ?typeLabel; separator="|") AS ?types)
  (GROUP_CONCAT(DISTINCT ?indLabel; separator="|") AS ?inds) WHERE {{
  ?c rdfs:label {json.dumps(label)}@en ; wdt:P31 wd:Q3624078 .
  ?co wdt:P17 ?c ; wdt:P856 ?site ; wikibase:sitelinks ?links .
  OPTIONAL {{ ?co wdt:P31 ?type . ?type rdfs:label ?typeLabel FILTER(LANG(?typeLabel) = "en") }}
  OPTIONAL {{ ?co wdt:P452 ?ind . ?ind rdfs:label ?indLabel FILTER(LANG(?indLabel) = "en") }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}} GROUP BY ?co ?coLabel ?coDescription ?site ?links LIMIT {WIKIDATA_ROWS_PER_COUNTRY}"""
    r = requests.get(WIKIDATA_URL, params={"query": sparql, "format": "json"},
                     headers={"User-Agent": TOOL_UA, "Accept": "application/sparql-results+json"},
                     timeout=75)
    r.raise_for_status()
    out = []
    for b in r.json()["results"]["bindings"]:
        name = b["coLabel"]["value"]
        site = b["site"]["value"]
        out.append({
            "name": name if not re.fullmatch(r"Q\d+", name) else fdb.company_id(site),
            "website": site,
            "description": b.get("coDescription", {}).get("value", ""),
            "types": [x for x in b.get("types", {}).get("value", "").split("|") if x],
            "industries": [x for x in b.get("inds", {}).get("value", "").split("|") if x],
            "countries": [country],
            "wikidata_id": b["co"]["value"].rsplit("/", 1)[-1],
            "_links": int(b["links"]["value"]),
        })
    return out


def wikidata_matches(intent: dict, countries: list[str], errors: list) -> list[dict]:
    with ThreadPoolExecutor(max_workers=6) as pool:
        batches = list(pool.map(lambda c: _safe(_wikidata_country, c, errors, "wikidata"), countries))
    out = []
    for rec in (r for batch in batches for r in batch):
        if not (rec["industries"] or ORG_TYPES.search(" ".join(rec["types"]) + " " + rec["description"])):
            continue  # buildings, events, websites, …
        score = relevance(intent, name=rec["name"], description=rec["description"],
                          types=rec["types"], industries=rec["industries"])
        if score:
            out.append({**rec, "sources": ["wikidata"], "_score": score})
    return out


# ---- source: OpenStreetMap ------------------------------------------------------------

_OSM_KIND_KEYS = ("office", "amenity", "shop", "craft", "industrial", "healthcare")


def osm_matches(intent: dict, countries: list[str], errors: list) -> list[dict]:
    words = [w for g in intent["terms"] for w in g if " " not in w]
    if not words:
        # HSE default: names that say which industry.
        words = ["oil", "gas", "petroleum", "energy", "engineering", "contracting", "construction",
                 "industrial", "chemical", "drilling", "marine", "safety"]
    pattern = "|".join(re.escape(w) for w in words[:20])
    def one(country: str) -> list[dict]:
        q = (f'[out:json][timeout:55];area["name:en"={json.dumps(country)}]["admin_level"="2"]->.a;'
             f'nwr(area.a)["website"]["name"~{json.dumps(pattern)},i];out tags center 400;')
        elements, last = None, None
        for ep in OVERPASS_URLS:
            try:
                r = requests.post(ep, data={"data": q}, headers={"User-Agent": TOOL_UA}, timeout=60)
                if r.status_code == 200:
                    elements = r.json().get("elements", [])
                    break
                last = f"Overpass HTTP {r.status_code}"
            except (requests.RequestException, ValueError) as e:
                last = type(e).__name__
        if elements is None:
            errors.append(("osm", f"{country}: {last or 'no Overpass server answered'}"))
            return []
        rows = []
        for e in elements:
            tags = e.get("tags", {})
            site = (tags.get("website") or tags.get("contact:website") or "").strip()
            if not site:
                continue
            if not site.startswith("http"):
                site = "https://" + site
            name = tags.get("name:en") or tags.get("name") or ""
            kinds = [tags[k].replace("_", " ") for k in _OSM_KIND_KEYS if tags.get(k) and tags[k] != "yes"]
            score = relevance(intent, name=name, types=kinds)
            if score or not intent["terms"]:
                rows.append({"name": name, "website": site, "types": kinds, "countries": [country],
                             "osm_id": f"{e.get('type')}/{e.get('id')}", "sources": ["osm"],
                             "_score": max(score, 1)})
        return rows

    # One country per query (a multi-area query times out); two at a time
    # to stay within the public servers' fair use.
    with ThreadPoolExecutor(max_workers=2) as pool:
        return [r for rows in pool.map(one, countries[:OSM_MAX_COUNTRIES]) for r in rows]


# ---- browser sources: Google Maps, Google Search, DuckDuckGo -----------------------

SKIP_DOMAINS = (
    "linkedin.", "indeed.", "glassdoor", "bayt.", "naukrigulf.", "naukri.", "gulftalent.", "monster",
    "ziprecruiter.", "simplyhired.", "jooble.", "careerjet.", "dubizzle.", "talent.com", "jobrapido.",
    "adzuna.", "totaljobs.", "reed.co.uk", "facebook.", "twitter.", "x.com", "instagram.", "youtube.",
    "tiktok.", "reddit.", "quora.", "wikipedia.", "medium.com", "google.", "bing.", "duckduckgo.",
    "yahoo.", "amazon.", "apple.com", "jobsora.", "drjob", "laimoon.", "gulfjobs", "qatarliving.",
    "expatriates.", "rozee.", "careerbuilder.", "wuzzuf.", "akhtaboot.", "tanqeeb.", "jora.",
    "whatjobs.", "jobted.", "neuvoo.", "trovit.", "learn4good.", "jobisjob.", "ambitionbox.",
    "jobstreet.", "seek.com", "foundit", "rigzone.", "oilandgasjobsearch.", "yelp.", "tripadvisor.",
    "yellowpages", "zawya.", "crunchbase.", "zoominfo.", "dnb.com", "kompass.", "ramp.directory",
    "wa.me", "whatsapp.", "t.me", "linktr.ee", "business.site", "sites.google.",
)
AGGREGATOR_TITLE = re.compile(
    r"^\s*[\d,.]+\+?\s|\bjobs? in\b.*\b(20\d\d|today|now)\b|\(\w+[- ]20\d\d\)|vacancies in\b|"
    r"\btop \d+\b|\bbest \d+\b|\blist of\b|\bdirectory\b",
    re.I,
)
_BOARD_NAME = re.compile(
    r"job|career|vacanc|recruit|talent|hiring|employ|staffing|cv|blog|guide|study|news|magazine|"
    r"forum|wiki|hse|directory|listing",
    re.I,
)
_SLD = {"co", "com", "org", "net", "gov", "ac", "edu"}

STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = window.chrome || {runtime: {}};
"""
# Each Maps result: [name, website, the card's text lines after the name].
MAPS_JS = r"""els => els.map(a => {
  const card = a.closest('div[jsaction]') || a.parentElement;
  const w = card ? card.querySelector("a[data-value='Website']") : null;
  const lines = card ? card.innerText.split(String.fromCharCode(10)).filter(Boolean) : [];
  return [a.getAttribute('aria-label') || '', w ? w.getAttribute('href') : '', lines.slice(1, 4)];
})"""


def _site_label(host: str) -> str:
    labels = host.split(".")
    if len(labels) >= 3 and labels[-2] in _SLD:
        return labels[-3]
    return labels[-2] if len(labels) >= 2 else host


def _ddg_href(href: str) -> str:
    if "duckduckgo.com/l/" in href:
        full = href if href.startswith("http") else "https:" + href
        return parse_qs(urlparse(full).query).get("uddg", [""])[0]
    return href


def _google_href(href: str) -> str:
    if href.startswith("/url?") or "google.com/url?" in href:
        return parse_qs(urlparse(href).query).get("q", [""])[0]
    return href


def _maps_category(lines: list[str], name: str = "") -> str:
    """'4.6(120) · Training centre · Al Quoz' → 'Training centre'. Only reads
    the card's "·"-separated rating/category line, never the name repeated."""
    for line in lines:
        if "·" not in line:
            continue
        for part in (p.strip() for p in line.split("·")):
            part = re.sub(r"[^\w &/'-]", "", part).strip()
            if (part and not re.search(r"\d", part) and len(part) < 50
                    and part.lower() != name.lower() and not part.startswith(("Open", "Closed"))):
                return part
    return ""


class Browser:
    """One off-screen Chrome window for all browser searches in a run."""

    def __enter__(self) -> "Browser":
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
        ua = BROWSER_UA.replace("Chrome/130.0", f"Chrome/{self._browser.version}")
        ctx = self._browser.new_context(locale="en-US", viewport={"width": 1366, "height": 900}, user_agent=ua)
        ctx.add_init_script(STEALTH_JS)
        self.page = ctx.new_page()
        self.blocked: set[str] = set()
        self._loads = 0
        return self

    def __exit__(self, *exc) -> None:
        try:
            self._browser.close()
        finally:
            self._pw.stop()

    def goto(self, url: str) -> None:
        if self._loads:
            time.sleep(random.uniform(*SEARCH_PAUSE_S))
        self._loads += 1
        self.page.goto(url, timeout=45_000, wait_until="domcontentloaded")
        if "consent." in self.page.url:  # cookie wall (EU visitors)
            for label in ("Reject all", "Accept all", "I agree"):
                btn = self.page.query_selector(f"button:has-text('{label}')")
                if btn:
                    btn.click()
                    self.page.wait_for_load_state("domcontentloaded")
                    break

    def google_blocked(self) -> bool:
        return "/sorry/" in self.page.url or bool(self.page.query_selector("form#captcha-form, #recaptcha"))

    # -- Google Maps --
    def maps(self, query: str) -> list[tuple[str, str, list[str]]]:
        if "google" in self.blocked:
            return []
        self.goto(f"https://www.google.com/maps/search/{quote_plus(query)}?hl=en")
        if self.google_blocked():
            self.blocked.add("google")
            return []
        try:
            self.page.wait_for_selector("div[role='feed']", timeout=SEARCH_WAIT_MS)
        except Exception:  # noqa: BLE001 — a single-place answer or nothing
            return []
        feed = self.page.query_selector("div[role='feed']")
        prev = -1
        for i in range(MAPS_MAX_SCROLLS):  # the list loads ~20 more per scroll
            n = len(self.page.query_selector_all("div[role='feed'] a.hfpxzc"))
            if n == prev and i > 2:
                break
            prev = n
            feed.evaluate("el => el.scrollBy(0, el.scrollHeight)")
            time.sleep(1.2)
        return [tuple(r) for r in self.page.eval_on_selector_all("div[role='feed'] a.hfpxzc", MAPS_JS)]

    # -- Google Search, DuckDuckGo fallback --
    def web(self, query: str) -> tuple[list[tuple[str, str]], str]:
        if "google" not in self.blocked:
            self.goto(f"https://www.google.com/search?q={quote_plus(query)}&hl=en&num=20")
            if self.google_blocked():
                self.blocked.add("google")
            else:
                rows = self._links("#search a:has(h3)", _google_href)
                if rows:
                    return rows, "google"
        self.goto(f"https://html.duckduckgo.com/html/?q={quote_plus(query)}")
        return self._links("a.result__a", _ddg_href), "duckduckgo"

    def _links(self, selector: str, unwrap) -> list[tuple[str, str]]:
        try:
            self.page.wait_for_selector(selector, timeout=SEARCH_WAIT_MS)
        except Exception:  # noqa: BLE001 — no results / blocked
            return []
        rows = self.page.eval_on_selector_all(
            selector,
            "els => els.map(a => [(a.querySelector('h3') || a).innerText || '', a.getAttribute('href') || ''])",
        )
        return [(" ".join(t.split()), unwrap(h)) for t, h in rows if unwrap(h).startswith("http")]


def map_queries(intent: dict, countries: list[str]) -> list[tuple[str, str]]:
    topics = [intent["topic"]] if intent["terms"] and intent["topic"] else list(HSE_MAP_TOPICS)
    targets = countries[:BROWSER_MAX_COUNTRIES] or [""]
    return [(f"{t} in {c}" if c else t, c) for c in targets for t in topics]


def web_queries(intent: dict, countries: list[str]) -> list[tuple[str, str]]:
    topic = intent["corrected"].strip() or "HSE jobs"
    if re.search(r"\bhse\b", topic) and not re.search(r"health|safety|environment", topic):
        topic = re.sub(r"\bhse\b", "HSE health safety environment", topic, count=1)
    targets = countries[:BROWSER_MAX_COUNTRIES]
    if targets:
        return [(f"{topic} {c} company official website", c) for c in targets]
    return [(f"{topic} company official website", ""), (f"{topic} companies careers page", "")]


def is_candidate(title: str, url: str) -> bool:
    host = _host(url)
    if not host or any(s in host for s in SKIP_DOMAINS):
        return False
    if AGGREGATOR_TITLE.search(title) or _BOARD_NAME.search(_site_label(host)):
        return False
    return True


def site_name(title: str, url: str) -> str:
    """'Careers at Acme | Acme Corp' → 'Acme Corp'; falls back to the host."""
    parts = [p.strip() for p in re.split(r"\s[|\-–—:]\s", title) if p.strip()]
    plain = [p for p in parts if not CAREERS_WORDS.search(p) and len(p) < 60]
    if plain:
        return plain[-1][:120]
    m = re.match(r"(?:careers|jobs)\s+(?:at|with)\s+(.+)", title.strip(), re.I)
    if m:
        return m.group(1).strip()[:120]
    return _host(url)


def browser_matches(intent: dict, countries: list[str], errors: list,
                    use_maps: bool = True) -> list[dict]:
    """Google Maps, then Google Search (DuckDuckGo where Google is blocked or
    empty), in one browser window."""
    out: list[dict] = []
    engines: set[str] = set()
    try:
        with Browser() as b:
            if use_maps:
                for q, country in map_queries(intent, countries):
                    for name, site, lines in b.maps(q):
                        if not site or any(s in _host(site) for s in SKIP_DOMAINS):
                            continue
                        engines.add("google_maps")
                        cat = _maps_category(lines, name)
                        # Google already matched these to the words: rank them high.
                        out.append({"name": name, "website": _strip_tracking(site),
                                    "types": [cat] if cat else [],
                                    "countries": [country] if country else [],
                                    "sources": ["google_maps"], "_score": 4})
            for q, country in web_queries(intent, countries):
                rows, engine = b.web(q)
                for title, url in rows:
                    if not is_candidate(title, url):
                        continue
                    engines.add(engine)
                    u = urlparse(url)
                    rec = {"name": site_name(title, url), "website": f"{u.scheme}://{u.netloc}/",
                           "description": title[:200], "countries": [country] if country else [],
                           "sources": [engine], "_score": 1}
                    if is_careers_url(url):
                        rec["careers_url"] = _clean_url(url)
                    out.append(rec)
            if "google" in b.blocked:
                errors.append(("google", "Google asked for a captcha, so its searches were skipped "
                                         "this time - try again later"))
    except Exception as e:  # noqa: BLE001
        errors.append(("web", f"{type(e).__name__}: {e}"[:200]))
    if not out and not errors:
        errors.append(("web", "the search engines returned nothing - try other words"))
    return out


# ---- combining ------------------------------------------------------------------------

def _safe(fn, arg, errors: list, source: str):
    try:
        return fn(arg)
    except Exception as e:  # noqa: BLE001 — one slow country mustn't sink the rest
        errors.append((source, f"{type(e).__name__}: {e}"[:200]))
        return []


def to_finding(rec: dict, *, known: bool) -> dict:
    """A database record in the shape the app shows."""
    ats = rec.get("ats") or "unknown"
    checked = bool(rec.get("checked_at"))
    reachable = rec.get("reachable") if checked else None
    return {
        "id": rec["id"],
        "name": rec.get("name") or rec["id"],
        "website": rec.get("website", ""),
        "careers_url": rec.get("careers_url", ""),
        "description": rec.get("description", ""),
        "countries": rec.get("countries", []),
        "industries": rec.get("industries", []),
        "types": rec.get("types", []),
        "sources": rec.get("sources", []),
        "known": known,
        "ats": ats,
        "checked": checked,
        "reachable": reachable,
        "scrapable": bool(reachable) and ats in SUPPORTED_ATS and bool(rec.get("careers_url")),
    }


def _iso_ts(s: str | None) -> float:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else 0.0
    except ValueError:
        return 0.0


def discover(query: str, countries: list[str], *, use_web: bool = True,
             exclude_urls: list[str] = ()) -> dict:
    intent = understand(query)
    countries = resolve_countries(query, countries)
    errors: list[tuple[str, str]] = []

    jobs = {"db": (db_matches, (intent, countries, errors))}
    if countries:
        jobs["wikidata"] = (wikidata_matches, (intent, countries, errors))
        jobs["osm"] = (osm_matches, (intent, countries, errors))
    if use_web:
        jobs["browser"] = (browser_matches, (intent, countries, errors))
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {k: pool.submit(fn, *args) for k, (fn, args) in jobs.items()}
        found = {k: f.result() for k, f in futures.items()}

    # Merge by company (website domain).
    exclude = {fdb.company_id(u) for u in exclude_urls}
    merged: dict[str, dict] = {}
    meta: dict[str, dict] = {}
    for key in ("db", "browser", "wikidata", "osm"):
        for rec in found.get(key, []):
            cid = fdb.company_id(rec.get("website") or rec.get("careers_url") or "")
            if not cid or cid in exclude or not rec.get("name"):
                continue
            m = meta.setdefault(cid, {"score": 0, "links": 0, "known": False, "hits": 0})
            m["score"] = max(m["score"], rec.get("_score", 0))
            m["links"] = max(m["links"], rec.get("_links", 0))
            m["known"] = m["known"] or rec.get("_known", False)
            m["hits"] += 1
            clean = {k: v for k, v in rec.items() if not k.startswith("_")}
            clean["id"] = cid
            merged[cid] = fdb.merge(merged.get(cid), clean)

    # Found by several sources = more likely what you want.
    ranked = sorted(merged, key=lambda c: (-(meta[c]["score"] + len(merged[c].get("sources", []))),
                                           -meta[c]["links"], merged[c].get("name", "").lower()))
    ranked = ranked[:RESULT_LIMIT]

    # Re-check careers pages we already know (web hits, earlier finds) if stale.
    stale_before = time.time() - RECHECK_AFTER_DAYS * 86400
    to_check = [c for c in ranked if merged[c].get("careers_url")
                and _iso_ts(merged[c].get("checked_at")) < stale_before][:VERIFY_LIMIT]
    with ThreadPoolExecutor(max_workers=12) as pool:
        for cid, chk in zip(to_check, pool.map(lambda c: check_page(merged[c]["careers_url"]), to_check)):
            merged[cid] = fdb.merge(merged[cid], {"id": cid, **chk})

    # Save everything shown to the findings database.
    q = query.strip()
    saved = fdb.upsert([{**merged[c], "found_by": [q] if q else [], "last_seen": fdb.now_iso()}
                        for c in ranked])
    findings = [to_finding(saved.get(c, merged[c]), known=meta[c]["known"]) for c in ranked]

    by_source: dict[str, int] = {}
    for f in findings:
        for s in f["sources"]:
            by_source[s] = by_source.get(s, 0) + 1
    by_source["db"] = sum(1 for f in findings if f["known"])
    return {
        "findings": findings,
        "by_source": by_source,
        "errors": [{"source": s, "message": m} for s, m in errors],
        "query_used": intent["corrected"],
        "countries_used": countries,
        "database_size": len(fdb.load()),
    }


# ---- CLI -------------------------------------------------------------------------------

def _print_table(result: dict) -> None:
    rows = result["findings"]
    print(f"\n{len(rows)} found for {result['query_used']!r} in "
          f"{', '.join(result['countries_used']) or 'any country'}  (by source: {result['by_source']}; "
          f"database now {result['database_size']} companies)")
    for f in rows[:60]:
        status = ("will be scraped" if f["scrapable"] else "not checked" if not f["checked"]
                  else "couldn't open" if not f["reachable"] else f"{f['ats']} platform")
        print(f"  {f['name'][:36]:36} {'+'.join(f['sources'])[:24]:24} {status:15} "
              f"{(f['careers_url'] or f['website'])[:60]}")
    if len(rows) > 60:
        print(f"  ... and {len(rows) - 60} more")
    for e in result["errors"]:
        print(f"\n{e['source']}: {e['message']}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("query", nargs="?", default="", help='e.g. "HSE jobs oil and gas"')
    ap.add_argument("--country", action="append", default=[], help="repeatable")
    ap.add_argument("--no-web", action="store_true", help="skip the browser searches")
    ap.add_argument("--json", action="store_true",
                    help="machine output; with no query, read the request as JSON on stdin")
    ap.add_argument("--enrich", action="store_true",
                    help='find careers pages: read {"ids": [...]} on stdin, print the updated companies')
    args = ap.parse_args(argv)

    if args.enrich:
        req = json.loads(sys.stdin.read() or "{}")
        print(json.dumps({"findings": enrich([str(i) for i in req.get("ids") or []])}))
        return 0
    if args.json and not args.query:
        req = json.loads(sys.stdin.read() or "{}")
        result = discover(str(req.get("query") or ""), [str(c) for c in req.get("countries") or []],
                          use_web=bool(req.get("use_web", True)),
                          exclude_urls=[str(u) for u in req.get("exclude_urls") or []])
    else:
        result = discover(args.query, args.country, use_web=not args.no_web)

    if args.json:
        # ASCII-only JSON: Windows pipes use the console code page, not UTF-8.
        print(json.dumps(result))
    else:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(errors="replace")
        _print_table(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
