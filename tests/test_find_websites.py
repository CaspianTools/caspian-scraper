"""find_websites.py — "Find websites" suggestions, offline (no network)."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import find_websites as fw  # noqa: E402


class _Resp:
    def __init__(self, status: int, payload: dict | None = None):
        self.status_code = status
        self._payload = payload or {}

    def json(self):
        return self._payload


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
    got = fw.catalog_matches("HSE jobs", ["United Arab Emirates"], set())
    assert [g["name"] for g in got] == ["Emirates Co"]
    # Region words expand to countries; already-saved URLs are skipped.
    got = fw.catalog_matches("HSE jobs Middle East", [], {"c.example/jobs"})
    assert [g["name"] for g in got] == ["Emirates Co"]


def test_brave_search_parses_results_and_sends_key(monkeypatch):
    seen = {}

    def fake_get(url, params, headers, timeout):
        seen.update(url=url, params=params, headers=headers)
        return _Resp(200, {"web": {"results": [
            {"title": "Careers | Acme", "url": "https://acme.example/careers"},
            {"title": "no url"},
        ]}})

    monkeypatch.setattr(fw.requests, "get", fake_get)
    assert fw.brave_search("KEY", "hse jobs") == [("Careers | Acme", "https://acme.example/careers")]
    assert seen["url"] == "https://api.search.brave.com/res/v1/web/search"
    assert seen["headers"]["X-Subscription-Token"] == "KEY"
    assert seen["params"]["q"] == "hse jobs"


# The 422 body is what Brave actually returns for an invalid key.
BAD_TOKEN = {"error": {"code": "SUBSCRIPTION_TOKEN_INVALID", "status": 422,
                       "detail": "The provided subscription token is invalid.",
                       "meta": {"component": "authentication"}}, "type": "ErrorResponse"}


@pytest.mark.parametrize("status,body,kind", [
    (422, BAD_TOKEN, "bad_key"), (401, None, "bad_key"), (403, None, "bad_key"),
    (429, None, "limited"), (402, None, "limited"), (500, None, "error"),
])
def test_brave_errors_are_classified(monkeypatch, status, body, kind):
    monkeypatch.setattr(fw.requests, "get", lambda *a, **k: _Resp(status, body))
    with pytest.raises(fw.SearchError) as e:
        fw.brave_search("KEY", "q")
    assert e.value.status == kind


def test_web_search_filters_boards_and_keeps_one_page_per_site(monkeypatch):
    monkeypatch.setattr(fw, "brave_search", lambda key, q: [
        ("HSE Officer jobs - LinkedIn", "https://www.linkedin.com/jobs/hse"),
        ("Careers | Acme Energy", "https://acme.example/careers"),
        ("Acme Energy - Search jobs", "https://acme.example/careers/search"),
        ("Acme annual report", "https://news.example/acme-results"),
        ("Join us - Beta Drilling", "https://beta.example/join-us"),
    ])
    got = fw.web_search("KEY", "HSE jobs", [], set())
    assert [(g["name"], g["careers_url"]) for g in got] == [
        ("Acme Energy", "https://acme.example/careers"),
        ("Beta Drilling", "https://beta.example/join-us"),
    ]


def test_discover_without_key_returns_catalog_only(monkeypatch):
    monkeypatch.setattr(fw, "catalog_matches", lambda q, c, e: [
        {"name": "A", "careers_url": "https://a.example", "countries": [],
         "catalog_ats": "successfactors", "why": "", "source": "catalog"}])
    monkeypatch.setattr(fw, "verify", lambda url: {
        "reachable": True, "status": 200, "detected_ats": "unknown", "note": ""})
    out = fw.discover("hse", [], search_key="")
    assert out["web_status"] == "no_key" and out["web"] == []
    (a,) = out["catalog"]
    # Platform falls back to the catalog's when the page check can't tell.
    assert a["ats"] == "successfactors" and a["scrapable"] is True


def test_json_mode_reads_stdin(monkeypatch, capsys):
    monkeypatch.setattr(fw, "load_search_key", lambda uid="local": "")
    monkeypatch.setattr(fw, "catalog_matches", lambda q, c, e: [])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"query": "hse", "use_web": True})))
    assert fw.main(["--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["web_status"] == "no_key" and out["catalog"] == []
