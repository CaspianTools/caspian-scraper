"""Structured 'evidence' the site inspector hands to the AI.

Everything here is deterministic (no LLM) and truncated so a page fits in a few
thousand tokens. The AI reads a PageEvidence to decide which extractor strategy
and selectors to propose, then verifies its guess with run_preview.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class FieldCandidate:
    selector: str          # "h1.product-title" or "time@datetime" (attr form)
    match_count: int       # elements matching on the live page (-1 = not checked)
    sample_text: str       # inner_text or attribute value, truncated
    source: str            # "css" | "jsonld" | "og_meta" | "next_data"


@dataclass
class RepeatedBlock:
    link_selector: str     # e.g. "a[href*='/p/']"
    href_includes: str     # common path substring of the group
    count: int
    sample_hrefs: list[str] = field(default_factory=list)  # first few, absolute


@dataclass
class PageEvidence:
    url: str
    final_url: str = ""
    http_status: int = 0
    title: str = ""
    # structured-data presence (drives extractor choice)
    has_next_data: bool = False
    next_data_keys: list[str] = field(default_factory=list)
    jsonld_types: list[str] = field(default_factory=list)
    jsonld_product_present: bool = False
    jsonld_sample: dict | None = None
    og_meta: dict[str, str] = field(default_factory=dict)
    # link discovery candidates
    repeated_blocks: list[RepeatedBlock] = field(default_factory=list)
    next_page_candidates: list[str] = field(default_factory=list)
    # per-field candidates keyed by semantic guess (title, price, date, ...)
    field_candidates: dict[str, list[FieldCandidate]] = field(default_factory=dict)
    detected_currency: str = ""
    html_excerpt: str = ""
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_prompt_json(self) -> dict[str, Any]:
        """Compact form for the LLM prompt: cap list sizes so the payload stays
        small even on huge pages."""
        d = asdict(self)
        d["repeated_blocks"] = d["repeated_blocks"][:8]
        d["next_page_candidates"] = d["next_page_candidates"][:8]
        d["jsonld_types"] = d["jsonld_types"][:20]
        trimmed: dict[str, list] = {}
        for key, cands in d["field_candidates"].items():
            trimmed[key] = cands[:6]
        d["field_candidates"] = trimmed
        if d.get("html_excerpt"):
            d["html_excerpt"] = d["html_excerpt"][:6000]
        return d
