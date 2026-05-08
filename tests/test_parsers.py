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
    BaseHtmlParser,
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


def test_jibe_polluted_fixture_strips_chrome(page):
    """End-to-end: parse a QatarEnergy-shape Jibe page through the full pipeline
    (parse_detail → _post_extract_html → _strip_leading_title_dupe →
    sanitize_description) and assert no UI chrome leaks into the published
    description, while real prose survives.
    """
    parser = JibeParser(page)
    role = parser.parse_detail("Test Co", fixture_url("jibe_qatarenergy_polluted.html"))
    assert role is not None
    assert role.title == "Field Safety Officer"

    out = sanitize_description(role.description, application_url=role.application_url)

    # Chrome MUST be gone.
    chrome_leaks = [
        "JOB_DESCRIPTION",
        "CAROUSEL_PARAGRAPH",
        "mail_outline",
        "<svg",
        "<button",
        "Share This Job",
        "LoginorRegister",
        "Get future jobs matching this search",
        "Report Broken Link",
        "Author's Vacancies",
    ]
    for needle in chrome_leaks:
        assert needle not in out, f"chrome leak survived: {needle!r}"

    # Apply links — none of the apply variants may survive.
    assert "Submit Application" not in out
    assert "/apply" not in out
    assert "Apply Now" not in out
    assert ">Apply<" not in out

    # Title duplicate — the in-body "<h1><u>Field Safety Officer</u></h1>"
    # should be stripped; the description should NOT begin with the title.
    assert not out.lstrip().lower().startswith("<h1>field safety officer</h1>".lower())
    assert "<h1>" not in out  # bleach allowlist rejects h1 anyway

    # Real prose MUST survive.
    assert "Primary Purpose of the Job" in out
    assert "Required Experience and Skills" in out
    assert "Monitor HSE compliance" in out
    assert "Idd El-Shargi" in out
    assert "<ul>" in out
    assert "10+ years in oil" in out
    assert "Bachelor" in out


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


# ---------- chrome-scrubbing tests (Layer 1) ----------

def test_sanitize_strips_i18n_key_paragraph():
    out = sanitize_description(
        "<p>JOB_DESCRIPTION.SHARE.HTML</p><p>Real prose here.</p>"
    )
    assert "JOB_DESCRIPTION" not in out
    assert "Real prose here." in out


def test_sanitize_strips_single_token_screamer():
    out = sanitize_description("<p>CAROUSEL_PARAGRAPH</p><p>Keep me.</p>")
    assert "CAROUSEL_PARAGRAPH" not in out
    assert "Keep me." in out


def test_sanitize_strips_material_icon():
    out = sanitize_description(
        '<p>Email us:</p><i class="material-icons">mail_outline</i>'
    )
    assert "mail_outline" not in out
    assert "Email us:" in out


def test_sanitize_strips_svg_block():
    out = sanitize_description(
        '<p>Apply via</p><svg viewBox="0 0 24 24"><path d="M1 1h2v2"/></svg>'
    )
    assert "<svg" not in out
    assert "<path" not in out


def test_sanitize_strips_button_subtree():
    out = sanitize_description("<p>Hi</p><button>GO</button>")
    assert "<button" not in out
    # "GO" alone would normally survive bleach (it's plain text after tag-strip),
    # but the subtree decompose drops it entirely.
    assert "GO" not in out


def test_sanitize_strips_apply_link_by_text():
    out_apply = sanitize_description('<p>x</p><a href="/x">Apply</a>')
    out_now = sanitize_description('<p>x</p><a href="/x">Apply Now</a>')
    assert "<a" not in out_apply
    assert "<a" not in out_now


def test_sanitize_strips_apply_link_by_href():
    out = sanitize_description(
        '<p>See <a href="https://careers.example.com/apply/123">here</a>.</p>'
    )
    assert "apply/123" not in out
    # Surrounding prose should survive.
    assert "See" in out


def test_sanitize_strips_apply_link_matching_application_url():
    out = sanitize_description(
        '<p>Read more <a href="https://x.com/jobs/9/apply">at our site</a>.</p>',
        application_url="https://x.com/jobs/9/apply",
    )
    assert "x.com/jobs/9/apply" not in out
    assert "Read more" in out


def test_sanitize_keeps_unrelated_links():
    out = sanitize_description(
        '<p>Learn about <a href="https://en.wikipedia.org/wiki/HSE">HSE</a>.</p>'
    )
    assert 'href="https://en.wikipedia.org/wiki/HSE"' in out
    assert "HSE</a>" in out


def test_sanitize_strips_chrome_phrase_leaves():
    out = sanitize_description(
        "<p>Get future jobs matching this search</p>"
        "<p>Report Broken Link</p>"
        "<p>LoginorRegister</p>"
        "<p>Back</p>"
        "<p>Author's Vacancies</p>"
        "<p>Real job description content.</p>"
    )
    for phrase in (
        "Get future jobs",
        "Report Broken Link",
        "LoginorRegister",
        "Author",
    ):
        assert phrase not in out, f"{phrase!r} leaked through"
    assert "Real job description content." in out


def test_sanitize_keeps_clean_html():
    """Regression guard — clean prose with allowed tags must survive untouched
    in content (whitespace may be normalized by the BS4 round-trip)."""
    src = (
        "<p>Primary purpose of the role is HSE compliance.</p>"
        "<h2>Required Experience</h2>"
        "<ul><li>10+ years in oil &amp; gas</li><li>Bachelor's degree</li></ul>"
    )
    out = sanitize_description(src)
    assert "Primary purpose of the role is HSE compliance." in out
    assert "<h2>Required Experience</h2>" in out
    assert "<ul>" in out
    assert "10+ years in oil" in out
    assert "Bachelor" in out


def test_sanitize_drops_i18n_key_does_not_eat_prose_with_acronym():
    # An acronym like "HSE" appearing in a sentence must not be eaten by the
    # i18n-key regex (which requires the *entire* text to be all-caps tokens).
    out = sanitize_description("<p>HSE matters in oil &amp; gas operations.</p>")
    assert "HSE matters in oil" in out


# ---------- title-dedup tests (Layer 3) ----------

def test_strip_leading_title_dupe_h1():
    src = "<h1>HEAD, PROCESS SAFETY (OFFSHORE)</h1><p>Primary purpose...</p>"
    out = BaseHtmlParser._strip_leading_title_dupe(
        src, "HEAD, PROCESS SAFETY (OFFSHORE)"
    )
    assert "<h1>" not in out
    assert "Primary purpose" in out


def test_strip_leading_title_dupe_h2_case_insensitive():
    src = "<h2>head, process safety (offshore)</h2><p>Body.</p>"
    out = BaseHtmlParser._strip_leading_title_dupe(
        src, "HEAD, PROCESS SAFETY (OFFSHORE)"
    )
    assert "<h2>" not in out
    assert "Body." in out


def test_strip_leading_title_dupe_p_with_underline():
    src = "<p><u>Safety Officer Test</u></p><p>Real body.</p>"
    out = BaseHtmlParser._strip_leading_title_dupe(src, "Safety Officer Test")
    assert "<u>Safety Officer Test</u>" not in out
    assert "Real body." in out


def test_strip_leading_title_dupe_does_not_strip_prose_paragraph():
    # Prose paragraph that mentions the title should NOT be stripped — only
    # heading-shaped elements are eligible.
    src = (
        "<p>Safety Officer Test is responsible for HSE compliance "
        "across operations.</p>"
    )
    out = BaseHtmlParser._strip_leading_title_dupe(src, "Safety Officer Test")
    assert "Safety Officer Test is responsible" in out


def test_strip_leading_title_dupe_keeps_non_matching_heading():
    src = "<h2>Primary Purpose of the Job</h2><p>Body.</p>"
    out = BaseHtmlParser._strip_leading_title_dupe(src, "Safety Officer Test")
    assert "Primary Purpose of the Job" in out


def test_strip_leading_title_dupe_handles_empty():
    assert BaseHtmlParser._strip_leading_title_dupe("", "Title") == ""
    assert BaseHtmlParser._strip_leading_title_dupe("<p>x</p>", "") == "<p>x</p>"
