"""Selector-drift tests for the HTML parsers.

These run against minimal synthetic fixtures rather than live careers
sites so they're fast, hermetic, and catch breakage on a PR rather than
silently in cron.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scrape import (  # noqa: E402  (sys.path tweak before import)
    JibeParser,
    SuccessFactorsParser,
    is_hse,
    infer_country,
    infer_employment_type,
    sanitize_description,
    make_slug,
)
from tests.conftest import fixture_url  # noqa: E402


# ---------- parser-level tests (use Playwright + fixture HTML) ----------

def test_successfactors_parses_minimal(page):
    parser = SuccessFactorsParser(page)
    role = parser.parse_detail("Test Co", fixture_url("sf_detail_minimal.html"))
    assert role is not None
    assert role.title == "HSE Engineer Test"
    assert "Dhahran" in role.location
    assert role.country == "sa"
    assert role.employment_type == "full-time"
    assert "<ul>" in role.description or "Bachelor" in role.description


def test_jibe_parses_minimal(page):
    parser = JibeParser(page)
    role = parser.parse_detail("Test Co", fixture_url("jibe_detail_minimal.html"))
    assert role is not None
    assert role.title == "Safety Officer Test"
    assert role.country == "qa"
    assert role.employment_type == "contract"


def test_non_hse_title_is_filtered(page):
    parser = SuccessFactorsParser(page)
    role = parser.parse_detail("Test Co", fixture_url("sf_non_hse_minimal.html"))
    # Title is "Marketing Coordinator" — no HSE keyword in title.
    # Pre-tightening this would have matched on the description's "safety";
    # the title-only filter must reject it.
    assert role is None


# ---------- pure-function tests (no Playwright needed) ----------

@pytest.mark.parametrize("text,expected", [
    ("HSE Manager", True),
    ("Loss Prevention Lead", True),
    ("Field Compliance Officer", True),
    ("Marketing Coordinator", False),
    ("Senior Software Engineer", False),
    ("Safety Engineer", True),
    ("", False),
])
def test_is_hse(text, expected):
    assert is_hse(text) is expected


@pytest.mark.parametrize("text,expected", [
    ("Dhahran",                   "sa"),
    ("Aberdeen",                  "gb"),
    ("Houston, TX",               "us"),
    ("Doha, Qatar",               "qa"),
    ("Stavanger",                 "no"),
    ("Calgary, Alberta",          "ca"),
    ("Mars",                      ""),
    ("",                          ""),
])
def test_infer_country(text, expected):
    assert infer_country(text) == expected


@pytest.mark.parametrize("text,expected", [
    ("Permanent role",  "full-time"),
    ("Full Time",       "full-time"),
    ("contract role",   "contract"),
    ("12-month fixed term", "contract"),
    ("part-time",       "part-time"),
    ("temporary",       "temporary"),
    ("",                "full-time"),  # default
])
def test_infer_employment_type(text, expected):
    assert infer_employment_type(text) == expected


def test_make_slug_basic():
    assert make_slug("HSE Manager", "Aramco") == "hse-manager-aramco"


def test_make_slug_strips_special_chars():
    assert make_slug(
        "Health & Safety Officer", "Halliburton (Global)"
    ) == "health-safety-officer-halliburton-global"


# ---------- sanitization tests ----------

def test_sanitize_strips_script():
    out = sanitize_description("<p>Hello <script>alert(1)</script>world</p>")
    assert "<script>" not in out
    assert "alert(1)" not in out
    assert "<p>Hello" in out and "world</p>" in out


def test_sanitize_strips_javascript_url():
    out = sanitize_description('<a href="javascript:bad()">click</a>')
    assert "javascript:" not in out


def test_sanitize_strips_inline_handler():
    out = sanitize_description('<p onclick="x()">hi</p>')
    assert "onclick" not in out


def test_sanitize_keeps_basic_formatting():
    out = sanitize_description("<p>HSE <strong>safety</strong> matters</p>")
    assert "<strong>safety</strong>" in out


def test_sanitize_strips_style_with_content():
    out = sanitize_description(
        "<style>body{display:none}</style><p>ok</p>"
    )
    assert "<style>" not in out
    assert "display:none" not in out
    assert "<p>ok</p>" in out


def test_sanitize_passes_plain_text():
    assert sanitize_description("plain text") == "plain text"


def test_sanitize_handles_empty():
    assert sanitize_description("") == ""
