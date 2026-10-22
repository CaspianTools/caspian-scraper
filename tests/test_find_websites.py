"""find_websites.py — "Find websites", offline (no network, no browser)."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import find_websites as fw  # noqa: E402
import findings_db as fdb  # noqa: E402


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(fdb, "DB_DIR", tmp_path / "db")
    monkeypatch.setattr(fw, "CACHE_DIR", tmp_path / "cache")


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


# ---- understanding the query -------------------------------------------------

def test_typos_are_fixed_and_generic_words_ignored():
    i = fw.understand("Trainign Agencies")
    assert i["corrected"] == "training agencies"
    assert [g[0] for g in i["terms"]] == ["training"] and i["hse"] is False


def test_hse_jobs_means_hse_hiring_industries():
    i = fw.understand("HSE jobs")
    assert i["terms"] == [] and i["hse"] is True and i["topic"] == "hse"


def test_relevance_needs_every_specific_word_and_ranks_name_first():
    i = fw.understand("safety training")
    assert fw.relevance(i, name="Gulf Safety Training Centre") > \
        fw.relevance(i, name="Acme", types=["safety"], description="training courses")
    assert fw.relevance(i, name="Acme Safety") == 0                 # no "training"
    hse = fw.understand("HSE jobs")
    assert fw.relevance(hse, name="PetroCo", industries=["petroleum industry"]) > 0
    assert fw.relevance(hse, name="Club", industries=["sporting activities"]) == 0


def test_regions_expand_to_countries():
    assert "Qatar" in fw.resolve_countries("HSE jobs Middle East", [])
    assert fw.resolve_countries("x", ["UAE", "ksa"]) == ["United Arab Emirates", "Saudi Arabia"]


# ---- careers pages -----------------------------------------------------------

def test_detect_ats():
    assert fw.detect_ats('<script src="https://cms.jibecdn.com/x.js">') == "jibe"
    assert fw.detect_ats('<a data-careersite-propertyid="title">') == "successfactors"
    assert fw.detect_ats("<html>plain careers page</html>") == "unknown"


def test_careers_page_found_from_homepage_link(monkeypatch):
    pages = {
        "https://acme.example": _Resp("https://www.acme.example/",
                                      '<a href="/about">About</a><a href="/en/careers">Careers</a>'),
        "https://www.acme.example/en/careers": _Resp("https://www.acme.example/en/careers",
                                                     "<title>Careers at Acme</title>"),
    }
    monkeypatch.setattr(fw, "_get", lambda url, timeout=0: pages.get(url))
    assert fw.find_careers_page("https://acme.example").url == "https://www.acme.example/en/careers"


def test_careers_page_falls_back_to_usual_address(monkeypatch):
    pages = {
        "https://acme.example": _Resp("https://acme.example/", "<p>no links</p>"),
        "https://careers.acme.example": _Resp("https://careers.acme.example/", "<title>Jobs</title>"),
    }
    monkeypatch.setattr(fw, "_get", lambda url, timeout=0: pages.get(url))
    assert fw.find_careers_page("https://acme.example").url == "https://careers.acme.example/"


def test_enrich_saves_the_careers_page(monkeypatch):
    fdb.upsert([{"id": "acme.example", "name": "Acme", "website": "https://acme.example"}])
    monkeypatch.setattr(fw, "find_careers_page", lambda site: _Resp(
        "https://careers.acme.example:443/", '<script src="//cms.jibecdn.com/a.js">'))
    (f,) = fw.enrich(["acme.example", "missing.example"])
    assert f["careers_url"] == "https://careers.acme.example/" and f["scrapable"] is True
    assert fdb.load()["acme.example"]["ats"] == "jibe"


# ---- sources -----------------------------------------------------------------

def test_search_result_links_are_unwrapped():
    assert fw._ddg_href("//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.example%2Fcareers&rut=x") \
        == "https://acme.example/careers"
    assert fw._google_href("/url?q=https://acme.example/jobs&sa=U") == "https://acme.example/jobs"


def test_maps_category_and_tracking_params():
    assert fw._maps_category(["4.6(120) · Training centre · Al Quoz", "Open · Closes 6 pm"]) == "Training centre"
    assert fw._strip_tracking("http://www.rei.ae/?utm_source=gmb&utm_medium=organic") == "http://www.rei.ae/"


def test_web_candidates_drop_boards_and_aggregators():
    assert not fw.is_candidate("400+ HSE Jobs, Employment in Qatar", "https://qa.indeed.com/hse")
    assert not fw.is_candidate("HSE jobs - The HSE Leader", "https://jobs.thehseleader.com/")
    assert not fw.is_candidate("Top 10 Training Agencies in Bahrain", "https://acme.example/blog")
    assert fw.is_candidate("Careers | Acme Energy", "https://acme.example/careers")


def test_wikidata_keeps_organisations_scored_by_query(monkeypatch):
    rows = [
        {"co": {"value": "x/Q1"}, "coLabel": {"value": "Gulf Training Institute"}, "site": {"value": "https://gti.example"},
         "links": {"value": "3"}, "types": {"value": "educational institution"}, "coDescription": {"value": ""}},
        {"co": {"value": "x/Q2"}, "coLabel": {"value": "Training Tower"}, "site": {"value": "https://tower.example"},
         "links": {"value": "9"}, "types": {"value": "skyscraper"}},                       # not an organisation
        {"co": {"value": "x/Q3"}, "coLabel": {"value": "PetroCo"}, "site": {"value": "https://petro.example"},
         "links": {"value": "30"}, "inds": {"value": "petroleum industry"}},              # off-topic, kept for details
    ]
    monkeypatch.setattr(fw.requests, "get", lambda *a, **k: _Resp("x", payload={"results": {"bindings": rows}}))
    got = {g["name"]: g for g in fw.wikidata_matches(fw.understand("training"), ["Qatar"], [])}
    assert set(got) == {"Gulf Training Institute", "PetroCo"}
    assert got["Gulf Training Institute"]["_score"] > 0 and got["PetroCo"]["_score"] == 0
    assert got["PetroCo"]["wikidata_id"] == "Q3"


# ---- OpenStreetMap -------------------------------------------------------------

def test_osm_searches_a_countrys_cities_or_a_city_or_the_whole_country():
    areas = fw.osm_areas("Azerbaijan")
    assert [a[1] for a in areas] == ["Baku, Azerbaijan", "Sumgait, Azerbaijan", "Ganja, Azerbaijan"]
    assert areas[0][0] == "Azerbaijan" and areas[0][2] == "nwr(around:35000,40.4093,49.8671)"
    assert len(fw.osm_areas("Saudi Arabia")) == fw.OSM_AREAS_PER_COUNTRY
    assert fw.osm_areas("dubai") == [("United Arab Emirates", "Dubai", "nwr(around:30000,25.2048,55.2708)")]
    ((country, label, where),) = fw.osm_areas("Narnia")
    assert label == "Narnia" and 'area["name:en"="Narnia"]["admin_level"="2"]' in where


def test_overpass_falls_back_to_backup_servers_with_growing_waits(monkeypatch):
    calls, waits = [], []
    answers = iter([
        fw.requests.Timeout("slow"),                                                 # main: timeout
        _Resp("k", status=429),                                                      # backup 1: busy
        _Resp("c", payload={"elements": [], "remark": "runtime error: Query timed out"}),  # backup 2: gave up
        _Resp("m", payload={"elements": [{"id": 1}]}),                               # main again: ok
    ])

    def post(url, data=None, headers=None, timeout=None):
        calls.append((url, timeout))
        a = next(answers)
        if isinstance(a, Exception):
            raise a
        return a

    monkeypatch.setattr(fw.requests, "post", post)
    monkeypatch.setattr(fw, "_pause", waits.append)
    elements, err = fw.overpass("[out:json];")
    assert elements == [{"id": 1}] and err == ""
    assert [c[0] for c in calls] == [*fw.OVERPASS_URLS, fw.OVERPASS_URLS[0]]
    assert all(t >= fw.OSM_TIMEOUT_S for _, t in calls)
    assert waits == list(fw.OSM_RETRY_WAITS_S) and waits == sorted(waits)


def test_overpass_gives_up_with_a_clear_message(monkeypatch):
    monkeypatch.setattr(fw.requests, "post", lambda *a, **k: _Resp("x", status=504))
    monkeypatch.setattr(fw, "_pause", lambda s: None)
    elements, err = fw.overpass("q")
    assert elements is None and "HTTP 504" in err


def test_osm_matches_queries_each_city_and_dedupes(monkeypatch):
    queries = []

    def fake_overpass(q):
        queries.append(q)
        if "40.6828" in q:                      # Ganja fails
            return None, "overpass-api.de: timed out"
        return [{"type": "node", "id": 7, "tags": {"name": "Baku Training Centre", "website": "btc.example"}},
                {"type": "node", "id": 8, "tags": {"name": "No Site Training"}}], ""

    monkeypatch.setattr(fw, "overpass", fake_overpass)
    errors = []
    rows = fw.osm_matches(fw.understand("training"), ["Azerbaijan"], errors)
    assert len(queries) == 3 and all("around:" in q and "[timeout:180]" in q for q in queries)
    assert [(r["name"], r["website"], r["countries"]) for r in rows] == \
        [("Baku Training Centre", "https://btc.example", ["Azerbaijan"])]      # same place twice → once
    assert errors == [("osm", "Ganja, Azerbaijan: overpass-api.de: timed out")]


# ---- browser captchas --------------------------------------------------------

class _FakePage:
    def __init__(self, html="", selectors=()):
        self.url, self.html, self.selectors = "https://html.duckduckgo.com/html/", html, set(selectors)

    def query_selector(self, sel):
        return any(s in sel for s in self.selectors) or None

    def content(self):
        return self.html


def test_duckduckgo_robot_check_is_reported_once_not_retried(monkeypatch):
    b = object.__new__(fw.Browser)
    b.page, b.blocked, b._loads = _FakePage("Unfortunately, bots use DuckDuckGo too."), {"google"}, 0
    loads = []
    monkeypatch.setattr(b, "goto", lambda url: loads.append(url), raising=False)
    assert b.web("training Qatar") == ([], "duckduckgo")
    assert b.web("training Oman") == ([], "duckduckgo")
    assert len(loads) == 1 and b.blocked == {"google", "duckduckgo"}


def test_captchas_end_up_in_errors(monkeypatch):
    class FakeBrowser:
        def __enter__(self):
            self.blocked = {"google", "duckduckgo"}
            return self

        def __exit__(self, *a):
            pass

        def maps(self, q):
            return []

        def web(self, q):
            return [], "duckduckgo"

    monkeypatch.setattr(fw, "Browser", FakeBrowser)
    errors = []
    assert fw.browser_matches(fw.understand("training"), ["Qatar"], errors) == []
    assert {s for s, _ in errors} == {"google", "duckduckgo"}
    assert "captcha" in dict(errors)["google"]


# ---- discover: merge, save, rank ---------------------------------------------

def test_discover_merges_sources_by_domain_and_saves_everything(monkeypatch):
    monkeypatch.setattr(fw, "wikidata_matches", lambda i, c, e: [
        {"name": "Acme Training", "website": "https://www.acme.example/", "countries": ["Qatar"],
         "description": "training company in Qatar", "wikidata_id": "Q1", "industries": ["education"],
         "types": ["company"], "sources": ["wikidata"], "_score": 3, "_links": 5},
        {"name": "Qatar University", "website": "https://qu.example/", "countries": ["Qatar"],
         "types": ["university"], "sources": ["wikidata"], "_score": 1, "_links": 50}])  # Wikidata only
    monkeypatch.setattr(fw, "osm_matches", lambda i, c, e: [
        {"name": "Acme Training Centre", "website": "https://acme.example/en", "countries": ["Qatar"],
         "sources": ["osm"], "_score": 3}])
    monkeypatch.setattr(fw, "browser_matches", lambda i, c, e: [
        {"name": "Beta Academy", "website": "https://beta.example/", "countries": ["Qatar"],
         "types": ["Training centre"], "sources": ["google_maps"], "_score": 4}])
    out = fw.discover("training", ["Qatar"])
    by_id = {f["id"]: f for f in out["findings"]}
    assert set(by_id) == {"acme.example", "beta.example"}               # no Wikidata-only company
    assert by_id["acme.example"]["sources"] == ["osm"]
    assert by_id["acme.example"]["description"] == "training company in Qatar"  # details from Wikidata
    assert out["database_size"] == 2 and set(fdb.load()) == {"acme.example", "beta.example"}
    assert fdb.load()["acme.example"]["wikidata_id"] == "Q1"
    assert fdb.load()["beta.example"]["found_by"] == ["training"]

    # A second search finds them in the database too.
    out2 = fw.discover("training", ["Qatar"], use_web=False)
    assert all(f["known"] for f in out2["findings"] if f["id"] == "beta.example")


def test_wikidata_matches_a_company_by_name_when_the_domain_differs(monkeypatch):
    monkeypatch.setattr(fw, "wikidata_matches", lambda i, c, e: [
        {"name": "ACME Training L.L.C.", "website": "https://acme-group.example/", "wikidata_id": "Q9",
         "description": "vocational training", "sources": ["wikidata"], "_score": 3}])
    monkeypatch.setattr(fw, "osm_matches", lambda i, c, e: [])
    monkeypatch.setattr(fw, "browser_matches", lambda i, c, e: [
        {"name": "Acme Training LLC", "website": "https://acme.example/", "sources": ["google_maps"], "_score": 4}])
    (f,) = fw.discover("training", ["Qatar"])["findings"]
    assert f["id"] == "acme.example" and f["website"] == "https://acme.example/"
    assert fdb.load()["acme.example"]["wikidata_id"] == "Q9"


def test_earlier_wikidata_only_finds_are_left_out(monkeypatch):
    fdb.upsert([{"id": "uni.example", "name": "Training University", "countries": ["Qatar"],
                 "website": "https://uni.example/", "sources": ["wikidata"]},
                {"id": "both.example", "name": "Both Training", "countries": ["Qatar"],
                 "website": "https://both.example/", "sources": ["wikidata", "osm"]}])
    for name in ("wikidata_matches", "osm_matches", "browser_matches"):
        monkeypatch.setattr(fw, name, lambda i, c, e: [])
    out = fw.discover("training", ["Qatar"])
    assert [f["id"] for f in out["findings"]] == ["both.example"]
    assert "uni.example" in fdb.load()                                   # still in the database


def test_results_put_the_search_words_first(monkeypatch):
    monkeypatch.setattr(fw, "wikidata_matches", lambda i, c, e: [])
    monkeypatch.setattr(fw, "osm_matches", lambda i, c, e: [
        {"name": "Gulf Training Centre", "website": "https://gtc.example/", "sources": ["osm"], "_score": 3}])
    monkeypatch.setattr(fw, "browser_matches", lambda i, c, e: [
        {"name": "Sky Flight Academy", "website": "https://sky.example/", "types": ["Flight school"],
         "sources": ["google_maps"], "_score": 4},
        {"name": "Acme", "website": "https://acme.example/", "description": "Safety training courses",
         "sources": ["google"], "_score": 1}])
    out = fw.discover("training agencies", ["Qatar"])
    assert [(f["id"], f["relevance"]) for f in out["findings"]] == \
        [("gtc.example", 85), ("acme.example", 70), ("sky.example", 40)]
    assert fw.query_words(fw.understand("trainign agencies jobs")) == ["training"]
    assert fw.query_words(fw.understand("HSE jobs")) == []
    again = fw.discover("training agencies", ["Qatar"])                  # the cached replay too
    assert again["cached"] and [f["relevance"] for f in again["findings"]] == [85, 70, 40]


def test_json_mode_reads_stdin(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"query": "hse", "use_web": False})))
    assert fw.main(["--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["findings"] == [] and out["countries_used"] == []


def test_careers_url_is_strict_about_what_counts():
    assert fw.is_careers_url("https://www.adnoc.ae/en/careers")
    assert fw.is_careers_url("https://careers.slb.com/")
    assert fw.is_careers_url("https://x.example/jobs.html")
    # Pages that only mention jobs aren't the careers page.
    assert not fw.is_careers_url("https://almashreqbh.com/customer-type/job-seekers/")
    assert not fw.is_careers_url("https://aztechtraining.com/about-us/equal-opportunity-ip-policies")
    assert fw.CAREERS_LINK_TEXT.match("Join Our Team") and not fw.CAREERS_LINK_TEXT.match("Job Seekers")


def test_maps_category_never_repeats_the_name():
    lines = ["Al Mashreq Training", "4.8(52) · Training centre · Manama"]
    assert fw._maps_category(lines, "Al Mashreq Training") == "Training centre"


def test_repeat_search_is_served_from_cache_with_fresh_records(monkeypatch):
    calls = []

    def fake_browser(i, c, e):
        calls.append(1)
        return [{"name": "Beta Academy", "website": "https://beta.example/", "countries": ["Qatar"],
                 "sources": ["google_maps"], "_score": 4}]

    monkeypatch.setattr(fw, "wikidata_matches", lambda i, c, e: [])
    monkeypatch.setattr(fw, "osm_matches", lambda i, c, e: [])
    monkeypatch.setattr(fw, "browser_matches", fake_browser)
    first = fw.discover("training", ["Qatar"])
    assert first["cached"] is False and len(calls) == 1

    # A careers page found after the search shows up in the replay.
    fdb.upsert([{"id": "beta.example", "careers_url": "https://beta.example/careers",
                 "ats": "jibe", "reachable": True, "checked_at": fdb.now_iso()}])
    again = fw.discover("Trainign", ["Qatar"])           # same words once the typo is fixed
    assert again["cached"] is True and len(calls) == 1
    assert again["findings"][0]["scrapable"] is True

    fresh = fw.discover("training", ["Qatar"], refresh=True)
    assert fresh["cached"] is False and len(calls) == 2


def test_browse_lists_the_whole_database():
    fdb.upsert([{"id": "b.example", "name": "Beta", "sources": ["osm"]},
                {"id": "a.example", "name": "Acme", "sources": ["wikidata", "osm"]}])
    out = fw.browse()
    assert [f["name"] for f in out["findings"]] == ["Acme", "Beta"]
    assert out["by_source"] == {"wikidata": 1, "osm": 2} and out["browse"] is True


def test_mark_hides_and_unhides_known_companies_only(monkeypatch, capsys):
    fdb.upsert([{"id": "a.example", "name": "Acme"}])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"ids": ["a.example", "nope.example"], "hidden": True})))
    assert fw.main(["--mark"]) == 0
    assert json.loads(capsys.readouterr().out) == {"updated": 1}
    assert fw.browse()["findings"][0]["hidden"] is True and "nope.example" not in fdb.load()


def test_tag_adds_and_removes_and_findings_carry_tags(monkeypatch, capsys):
    fdb.upsert([{"id": "a.example", "name": "Acme"}, {"id": "b.example", "name": "Beta"}])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(
        {"ids": ["a.example", "b.example", "nope.example"], "add": ["priority", "Gulf"]})))
    assert fw.main(["--tag"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out == {"updated": 2, "tags": {"a.example": ["Gulf", "priority"], "b.example": ["Gulf", "priority"]}}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"ids": ["b.example"], "remove": ["gulf"]})))
    assert fw.main(["--tag"]) == 0
    capsys.readouterr()
    tags = {f["id"]: f["tags"] for f in fw.browse()["findings"]}
    assert tags == {"a.example": ["Gulf", "priority"], "b.example": ["priority"]}
