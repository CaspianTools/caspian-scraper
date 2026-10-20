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


def test_wikidata_keeps_organisations_ranked_by_query(monkeypatch):
    rows = [
        {"co": {"value": "x/Q1"}, "coLabel": {"value": "Gulf Training Institute"}, "site": {"value": "https://gti.example"},
         "links": {"value": "3"}, "types": {"value": "educational institution"}, "coDescription": {"value": ""}},
        {"co": {"value": "x/Q2"}, "coLabel": {"value": "Training Tower"}, "site": {"value": "https://tower.example"},
         "links": {"value": "9"}, "types": {"value": "skyscraper"}},                       # not an organisation
        {"co": {"value": "x/Q3"}, "coLabel": {"value": "PetroCo"}, "site": {"value": "https://petro.example"},
         "links": {"value": "30"}, "inds": {"value": "petroleum industry"}},              # off-topic
    ]
    monkeypatch.setattr(fw.requests, "get", lambda *a, **k: _Resp("x", payload={"results": {"bindings": rows}}))
    got = fw.wikidata_matches(fw.understand("training"), ["Qatar"], [])
    assert [g["name"] for g in got] == ["Gulf Training Institute"]


# ---- discover: merge, save, rank ---------------------------------------------

def test_discover_merges_sources_by_domain_and_saves_everything(monkeypatch):
    monkeypatch.setattr(fw, "wikidata_matches", lambda i, c, e: [
        {"name": "Acme Training", "website": "https://www.acme.example/", "countries": ["Qatar"],
         "types": ["company"], "sources": ["wikidata"], "_score": 3, "_links": 5}])
    monkeypatch.setattr(fw, "osm_matches", lambda i, c, e: [
        {"name": "Acme Training Centre", "website": "https://acme.example/en", "countries": ["Qatar"],
         "sources": ["osm"], "_score": 3}])
    monkeypatch.setattr(fw, "browser_matches", lambda i, c, e: [
        {"name": "Beta Academy", "website": "https://beta.example/", "countries": ["Qatar"],
         "types": ["Training centre"], "sources": ["google_maps"], "_score": 4}])
    out = fw.discover("training", ["Qatar"])
    by_id = {f["id"]: f for f in out["findings"]}
    assert set(by_id) == {"acme.example", "beta.example"}
    assert by_id["acme.example"]["sources"] == ["wikidata", "osm"]   # one finding, two chips
    assert out["database_size"] == 2 and set(fdb.load()) == {"acme.example", "beta.example"}
    assert fdb.load()["beta.example"]["found_by"] == ["training"]

    # A second search finds them in the database too.
    out2 = fw.discover("training", ["Qatar"], use_web=False)
    assert all(f["known"] for f in out2["findings"] if f["id"] == "beta.example")


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
