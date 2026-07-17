"""AI-driven scraper configuration.

`python -m aiconfig new --url ... --intent ...` inspects a target site with
Playwright, has Claude author an extraction config for the generic (any-schema)
scraper surface, dry-runs it live until it extracts clean sample records, and —
after human approval — writes a /generic_sources doc that the existing cron
scrapes on schedule.

The package deliberately adds NO new dependencies: the Anthropic Messages API
is called over raw `requests` (the same pattern as classifieds/ai.py), and all
Playwright/extraction reuse the classifieds toolkit + scrape.py's
ConfigurableProductParser.
"""

from __future__ import annotations

__all__ = [
    "build_evidence_from_html",
    "inspect_url",
    "validate_extraction",
    "run_agent",
    "run_preview",
]


def __getattr__(name: str):  # lazy re-exports to keep import cost low
    if name in ("build_evidence_from_html", "inspect_url"):
        from . import inspector

        return getattr(inspector, name)
    if name == "validate_extraction":
        from .config_schema import validate_extraction

        return validate_extraction
    if name == "run_agent":
        from .agent import run_agent

        return run_agent
    if name == "run_preview":
        from .preview import run_preview

        return run_preview
    raise AttributeError(name)
