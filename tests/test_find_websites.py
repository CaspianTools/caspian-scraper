"""find_websites.py — "Find websites" suggestions, offline (no network)."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import find_websites as fw  # noqa: E402


class _Resp:
    def __init__(self, url: str, text: str = "", status: int = 200, payload: dict | None = None):
        self.url, self.text, self.status_code = url, text, status
        self._payload = payload or {}

    @property
    def ok(self) -> bool:
        return self.status_code < 400

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(self.status_code)


def test_detect_ats():
    assert fw.detect_ats('<script src="https://cms.jibecdn.com/x.js">') == "jibe"
    assert fw.detect_ats('<a data-careersite-propertyid="title">') == "successfactors"
    assert fw.detect_ats("<html>plain careers page</html>") == "unknown"


def test_catalog_country_aliases_and_regions(tmp_path, monkeypatch):
    cat = tmp_path / "employers.json"
    cat.write_text(json.dumps([
        {"name": "Emirates Co", "careers_url": "https://a.example/jobs", "countries": ["UAE"], "ats": "jibe"},
        {"name": "Far Co", "careers_url": "https://b.example/jobs", "countries": ["Brazil"]},
        {"name": "Have Co", "careers_url": "https://www.c.example/jobs/", "countries": ["Qatar"]},
    ]), encoding="utf-8")
    monkeypatch.setattr(fw, "CATALOG_FILE", cat)
    # The picker sends full names; the catalog says "UAE".
    assert [g["name"] for g in fw.catalog_matches("HSE jobs", ["United Arab Emirates"], set())] == ["Emirates Co"]
    # Region words expand to countries; already-saved URLs are skipped.
    got = fw.catalog_matches("HSE jobs Middle East", [], {"c.example/jobs"})
    assert [g["name"] for g in got] == ["Emirates Co"]


def test_search_result_links_are_unwrapped():
    assert fw._ddg_href("//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.example%2Fcareers&rut=x") \
        == "https://acme.example/careers"
    assert fw._google_href("/url?q=https://acme.example/jobs&sa=U") == "https://acme.example/jobs"
    assert fw._google_href("https://acme.example/jobs") == "https://acme.example/jobs"


def test_queries_spell_out_hse_and_spend_budget_on_countries():
    qs = fw.build_queries("HSE jobs", ["Qatar", "Oman"])
    assert len(qs) == 4 and all("health safety environment" in q for q in qs)
    assert any("Qatar" in q for q in qs) and any("Oman" in q for q in qs)
    assert all("jobs jobs" not in q for q in qs)


def test_pick_sites_keeps_employers_one_per_site():
    results = [
        ("400+ HSE Jobs, Employment in Qatar", "https://qa.indeed.com/hse"),  # board domain
        ("HSE Jobs in Qatar (Oct 2026) - Bayt.com", "https://www.bayt.com/x"),
        ("HSE jobs - The HSE Leader", "https://jobs.thehseleader.com/"),      # 'hse' site name
        ("Hse jobs in Qatar (October-2026)", "https://aimgulf.com/x"),          # aggregator title
        ("Careers | Acme Energy", "https://acme.example/careers"),
        ("Acme Energy - Search jobs", "https://acme.example/careers/search"),  # same site
        ("Acme annual report", "https://news.example/acme"),                   # not careers
        ("Join us - Beta Drilling", "https://beta.example/join-us"),
    ]
    got = fw.pick_sites(results, set())
    assert [(g["name"], g["careers_url"]) for g in got] == [
        ("Acme Energy", "https://acme.example/careers"),
        ("Beta Drilling", "https://beta.example/join-us"),
    ]


def test_wikidata_filters_by_hse_industries_or_typed_words(monkeypatch):
    rows = [
        {"coLabel": {"value": "PetroCo"}, "site": {"value": "https://petro.example"},
         "links": {"value": "30"}, "inds": {"value": "petroleum industry"}},
        {"coLabel": {"value": "Club"}, "site": {"value": "https://club.example"},
         "links": {"value": "40"}, "inds": {"value": "sporting activities"}},
        {"coLabel": {"value": "BuildCo"}, "site": {"value": "https://build.example"},
         "links": {"value": "5"}, "inds": {"value": "construction"}},
        {"coLabel": {"value": "Hotel"}, "site": {"value": "https://hotel.example"},
         "links": {"value": "9"}, "inds": {"value": "hospitality industry"}},
    ]
    monkeypatch.setattr(fw.requests, "get",
                        lambda *a, **k: _Resp("x", payload={"results": {"bindings": rows}}))
    names = [c["name"] for c in fw.wikidata_companies(["Qatar"], "HSE jobs")]
    assert names == ["PetroCo", "BuildCo"]          # HSE industries, notable first
    names = [c["name"] for c in fw.wikidata_companies(["Qatar"], "HSE construction jobs")]
    assert names == ["BuildCo"]                     # typed industry narrows it


def test_careers_page_found_from_homepage_link(monkeypatch):
    pages = {
        "https://acme.example": _Resp(
            "https://www.acme.example/",
            '<a href="/about">About</a><a href="/en/careers">Careers</a>'),
        "https://www.acme.example/en/careers": _Resp(
            "https://www.acme.example/en/careers", "<title>Careers at Acme</title>"),
    }
    monkeypatch.setattr(fw, "_get", lambda url: pages.get(url))
    r = fw.find_careers_page("https://acme.example")
    assert r is not None and r.url == "https://www.acme.example/en/careers"


def test_careers_page_falls_back_to_usual_address(monkeypatch):
    pages = {
        "https://acme.example": _Resp("https://acme.example/", "<p>no links</p>"),
        "https://careers.acme.example": _Resp("https://careers.acme.example/", "<title>Jobs</title>"),
    }
    monkeypatch.setattr(fw, "_get", lambda url: pages.get(url))
    assert fw.find_careers_page("https://acme.example").url == "https://careers.acme.example/"


def test_default_ports_dont_break_duplicate_matching():
    assert fw._clean_url("https://careerportal.qatarenergy.qa:443/") == "https://careerportal.qatarenergy.qa/"
    assert fw._host("https://careerportal.qatarenergy.qa:443/") == "careerportal.qatarenergy.qa"


def test_discover_offline_returns_catalog_only(monkeypatch):
    monkeypatch.setattr(fw, "catalog_matches", lambda q, c, e: [
        {"name": "A", "careers_url": "https://a.example", "countries": [],
         "catalog_ats": "successfactors", "why": "", "source": "catalog"}])
    monkeypatch.setattr(fw, "verify", lambda url: {
        "reachable": True, "status": 200, "detected_ats": "unknown", "note": ""})
    out = fw.discover("hse", [], use_web=False)
    assert out["web_status"] == "off" and out["directory_status"] == "off"
    (a,) = out["catalog"]
    # Platform falls back to the catalog's when the page check can't tell.
    assert a["ats"] == "successfactors" and a["scrapable"] is True


def test_json_mode_reads_stdin(monkeypatch, capsys):
    monkeypatch.setattr(fw, "catalog_matches", lambda q, c, e: [])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"query": "hse", "use_web": False})))
    assert fw.main(["--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["catalog"] == [] and out["directory"] == [] and out["web_status"] == "off"
