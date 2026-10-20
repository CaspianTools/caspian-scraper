"""Find careers websites for a job — "Find websites" in the admin app.

    echo '{"query": "...", "countries": [], "exclude_urls": [], "owner_uid": "local"}' \
        | python -m aiconfig.discover

Prints one JSON object to stdout:

    {"catalog": [Suggestion...], "web": [Suggestion...],
     "web_status": "ok" | "no_key" | "error" | "off", "web_mode": "live_search" |
     "model_knowledge" | "", "web_error": str}

Two sources:
  * catalog — employers.json, the repo's curated list of HSE employers.
  * web     — the AI provider saved under AI Setup (/aiconfig_keys/<uid>).
              Anthropic runs a live web search (server-side web_search tool);
              other providers answer from model knowledge via the existing
              adapters. Either way every URL is fetched before it is offered.

Each suggestion is verified: reachable or not, and which careers platform it
runs on — only "successfactors" and "jibe" have parsers today, so anything else
is added as "unknown" (stored, not scraped yet).
"""

from __future__ import annotations

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from .providers import ProviderError, build_provider
from .providers.base import http_post_json

REPO_ROOT = Path(__file__).resolve().parents[1]
CATALOG_FILE = REPO_ROOT / "employers.json"

SUPPORTED_ATS = ("successfactors", "jibe")
CATALOG_LIMIT = 25
WEB_LIMIT = 12
VERIFY_TIMEOUT_S = 12
UA = "Mozilla/5.0 (compatible; CaspianScraper/1.0; +careers-discovery)"

# Region words → countries, so "HSE jobs Middle East" matches catalog entries.
REGIONS = {
    "middle east": ["UAE", "Saudi Arabia", "Qatar", "Oman", "Kuwait", "Bahrain",
                    "Iraq", "Iran", "Jordan", "Egypt", "Syria", "Lebanon", "Yemen"],
    "gulf": ["UAE", "Saudi Arabia", "Qatar", "Oman", "Kuwait", "Bahrain"],
    "gcc": ["UAE", "Saudi Arabia", "Qatar", "Oman", "Kuwait", "Bahrain"],
}
STOPWORDS = {"jobs", "job", "the", "and", "for", "with", "vacancies", "careers",
             "career", "roles", "role", "in", "of", "hse"}


def _norm_url(u: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", (u or "").strip().lower()).rstrip("/")


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
                         headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    except requests.RequestException as e:
        return {"reachable": False, "status": None, "detected_ats": "unknown",
                "note": f"couldn't open the page ({type(e).__name__})"}
    if r.status_code in (401, 403, 429):
        return {"reachable": False, "status": r.status_code, "detected_ats": "unknown",
                "note": "the site blocked the automatic check — it may still open in a browser"}
    if r.status_code >= 400:
        return {"reachable": False, "status": r.status_code, "detected_ats": "unknown",
                "note": f"page returned HTTP {r.status_code}"}
    return {"reachable": True, "status": r.status_code,
            "detected_ats": detect_ats(r.text[:500_000]), "note": ""}


def _finish(s: dict) -> dict:
    """Merge verification into a suggestion and settle its ats."""
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

def catalog_matches(query: str, countries: list[str], exclude: set[str]) -> list[dict]:
    try:
        entries = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    q = (query or "").lower()
    want = {c.lower() for c in countries}
    for region, members in REGIONS.items():
        if region in q:
            want |= {m.lower() for m in members} | {"regional"}
    tokens = [t for t in re.findall(r"[a-z0-9]{3,}", q) if t not in STOPWORDS]

    scored = []
    for e in entries:
        url = str(e.get("careers_url") or "").strip()
        if not url.startswith("http") or _norm_url(url) in exclude:
            continue
        ecountries = [str(c) for c in e.get("countries") or []]
        hay = " ".join(str(e.get(k) or "") for k in
                       ("name", "segment", "notes", "headquarters", "kind", "type")).lower()
        hay += " " + " ".join(ecountries).lower()
        score = 3 * sum(1 for c in ecountries if c.lower() in want)
        score += sum(1 for t in tokens if t in hay)
        if (want or tokens) and score == 0:
            continue
        scored.append((score, e.get("ats") in SUPPORTED_ATS, e, url, ecountries))

    scored.sort(key=lambda x: (-x[0], not x[1], str(x[2].get("name") or "").lower()))
    out = []
    for _score, _sup, e, url, ecountries in scored[:CATALOG_LIMIT]:
        out.append({
            "name": str(e.get("name") or url),
            "careers_url": url,
            "countries": ecountries,
            "catalog_ats": str(e.get("ats") or "unknown"),
            "why": str(e.get("segment") or e.get("notes") or "")[:200],
            "source": "catalog",
        })
    return out


# ---- web -------------------------------------------------------------------

PROMPT = """Find employers whose careers websites list jobs matching this request:

  {query}{countries_line}

Return up to {limit} employers. For each, give the URL of the page that LISTS
open jobs (ideally a search already filtered to the request, e.g. ?q=hse), not
the company homepage or a single job ad. Prefer official employer career sites;
include recruitment agencies only if they are major sources for this request.
Skip these, which the user already has: {skip}.

Answer with ONLY a JSON array, no prose, in this exact shape:
[{{"name": "Company", "careers_url": "https://...", "countries": ["UAE"], "why": "one short reason"}}]"""

# Models that take the dynamic-filtering web search tool; older ones get the
# basic variant.
_DYNAMIC_SEARCH = re.compile(r"claude-(opus-(5|4-[6-9])|sonnet-(5|4-6)|fable)")
# Models where the server-side refusal fallback should be on by default.
_FALLBACK_MODELS = ("claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5")
ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5"


def _parse_list(text: str) -> list[dict]:
    m = re.search(r"\[[\s\S]*\]", text or "")
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return []
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


def _anthropic_search(cfg: dict, prompt: str) -> str:
    model = cfg.get("model") or ANTHROPIC_DEFAULT_MODEL
    base = (cfg.get("base_url") or "https://api.anthropic.com").rstrip("/")
    headers = {
        "x-api-key": cfg["value"],
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body: dict = {
        "model": model,
        "max_tokens": 16000,
        "tools": [{
            "type": "web_search_20260209" if _DYNAMIC_SEARCH.search(model) else "web_search_20250305",
            "name": "web_search",
            "max_uses": 8,
        }],
    }
    if model in _FALLBACK_MODELS:
        headers["anthropic-beta"] = "server-side-fallback-2026-07-01"
        body["fallbacks"] = "default"

    messages: list[dict] = [{"role": "user", "content": prompt}]
    for _ in range(5):  # pause_turn continuations
        resp = http_post_json(f"{base}/v1/messages", headers, {**body, "messages": messages})
        if resp.get("stop_reason") == "refusal":
            raise ProviderError("the model declined this search")
        if resp.get("stop_reason") != "pause_turn":
            return "".join(
                b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text"
            )
        # Resume: resend the paused assistant turn as-is, no extra user message.
        messages = [messages[0], {"role": "assistant", "content": resp.get("content", [])}]
    raise ProviderError("web search didn't finish after several continuations")


def web_suggestions(cfg: dict, query: str, countries: list[str],
                    skip_names: list[str]) -> tuple[list[dict], str]:
    prompt = PROMPT.format(
        query=query.strip() or "HSE (health, safety, environment) jobs",
        countries_line=f"\n  Countries: {', '.join(countries)}" if countries else "",
        limit=WEB_LIMIT,
        skip=", ".join(skip_names[:60]) or "none",
    )
    provider = (cfg.get("provider") or "anthropic").strip().lower()
    if provider == "anthropic":
        text, mode = _anthropic_search(cfg, prompt), "live_search"
    else:
        llm = build_provider(provider, api_key=cfg["value"], model=cfg.get("model") or "",
                             base_url=cfg.get("base_url") or "")
        text = llm.complete(system="You are a careful research assistant.", tools=[],
                            history=[{"role": "user", "text": prompt}]).text
        mode = "model_knowledge"
    out = []
    for d in _parse_list(text)[:WEB_LIMIT]:
        url = str(d.get("careers_url") or "").strip()
        if not url.startswith("http"):
            continue
        out.append({
            "name": str(d.get("name") or url)[:120],
            "careers_url": url,
            "countries": [str(c) for c in d.get("countries") or []][:20],
            "catalog_ats": "unknown",
            "why": str(d.get("why") or "")[:200],
            "source": "web",
        })
    return out, mode


def load_key(owner_uid: str) -> dict | None:
    from scrape import get_db

    snap = get_db().collection("aiconfig_keys").document(owner_uid).get()
    d = snap.to_dict() if snap.exists else None
    return d if d and str(d.get("value") or "").strip() else None


def main() -> int:
    req = json.loads(sys.stdin.read() or "{}")
    query = str(req.get("query") or "")
    countries = [str(c).strip() for c in req.get("countries") or [] if str(c).strip()]
    exclude = {_norm_url(u) for u in req.get("exclude_urls") or []}
    skip_names = [str(n) for n in req.get("exclude_names") or []]

    catalog = catalog_matches(query, countries, exclude)
    result: dict = {"catalog": [], "web": [], "web_status": "off", "web_mode": "", "web_error": ""}

    web: list[dict] = []
    if req.get("use_web", True):
        cfg = load_key(str(req.get("owner_uid") or "local"))
        if cfg is None:
            result["web_status"] = "no_key"
        else:
            try:
                web, result["web_mode"] = web_suggestions(
                    cfg, query, countries, skip_names + [c["name"] for c in catalog])
                result["web_status"] = "ok"
            except (ProviderError, requests.RequestException, KeyError, ValueError) as e:
                result["web_status"] = "error"
                result["web_error"] = str(e)[:300]

    seen = set(exclude) | {_norm_url(c["careers_url"]) for c in catalog}
    web = [w for w in web if _norm_url(w["careers_url"]) not in seen]

    checked = verify_all(catalog + web)
    result["catalog"] = [s for s in checked if s["source"] == "catalog"]
    result["web"] = [s for s in checked if s["source"] == "web"]
    # ASCII-only JSON: Windows pipes use the console code page, not UTF-8.
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
