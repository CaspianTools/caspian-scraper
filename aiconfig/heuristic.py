"""Build an extraction config WITHOUT AI — for scrapes with "Use AI" off.

Deterministic and free: the inspector already finds the listing page's
repeated link groups and probes per-field selectors (see inspector.py). Here we
turn that evidence into candidate configs — one per promising link group, with
fields picked from a sample detail page — and keep the one whose live preview
extracts the most records. No model, no key, no cost.

Tool executors are injected (`impl`) like agent.run_agent, so tests run it
without a browser.
"""

from __future__ import annotations

import re
from typing import Any, Callable
from urllib.parse import urlparse

from .agent import PREVIEW_MAX_ITEMS, AgentResult
from .config_schema import derive_output_schema, validate_extraction
from .evidence import FieldCandidate, PageEvidence, RepeatedBlock
from .persist import parse_schema_hint

# How many link groups to try (each costs a detail inspection + a preview).
MAX_LINK_GROUPS = 3

# Words in a requested field name -> the inspector's semantic probe it maps to.
_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "title": ("title", "name", "headline", "heading", "subject", "position", "role"),
    "date": ("date", "deadline", "closing", "published", "posted", "time", "expires"),
    "price": ("price", "amount", "value", "cost", "salary", "budget", "fee"),
    "author": ("author", "byline", "by", "writer"),
    "description": ("description", "body", "summary", "content", "details", "text"),
    "image": ("image", "photo", "picture", "img", "thumbnail"),
}
# Fields kept when nothing was requested: the ones almost every record has.
_DEFAULT_FIELDS = ("title", "date", "description")

# Link groups that are navigation, not items.
_NAV_RE = re.compile(r"/(tag|tags|category|categories|page|author|search|login|signin|account)/|[?&]page=", re.I)


def _semantic(name: str) -> str | None:
    """'closing_date' -> 'date', 'award_amount' -> 'price'. Whole words only, so
    'body' isn't mistaken for 'by'."""
    tokens = set(re.split(r"[^a-z0-9]+", name.lower()))
    for semantic, words in _FIELD_ALIASES.items():
        if tokens.intersection(words):
            return semantic
    return None


def _pick(cands: list[FieldCandidate]) -> FieldCandidate | None:
    """The most specific candidate that matched with real text: one match beats
    many (a page-wide `img` or `.content` is rarely the field)."""
    usable = [c for c in cands if c.match_count > 0 and c.sample_text.strip()]
    if not usable:
        return None
    return min(usable, key=lambda c: (c.match_count, len(c.selector)))


def build_fields(detail: PageEvidence, record_schema_hint: str = "") -> tuple[dict[str, str], str]:
    """Field map {output name: selector} + the required (title-like) field."""
    wanted: list[tuple[str, str]] = []  # (output name, semantic probe)
    for f in parse_schema_hint(record_schema_hint):
        sem = _semantic(str(f.get("name") or ""))
        if sem and all(s != sem for _, s in wanted):
            wanted.append((str(f["name"]), sem))
    if not any(s == "title" for _, s in wanted):
        wanted.insert(0, ("title", "title"))
    for sem in _DEFAULT_FIELDS:
        if all(s != sem for _, s in wanted):
            wanted.append((sem, sem))

    fields: dict[str, str] = {}
    for out_name, sem in wanted:
        best = _pick(detail.field_candidates.get(sem, []))
        if best is None:
            continue
        # A many-match selector is only worth keeping for the title.
        if sem != "title" and best.match_count > 3:
            continue
        fields[out_name] = best.selector
    title_name = next((n for n, s in wanted if s == "title"), "title")
    return fields, title_name if title_name in fields else ""


def rank_blocks(listing: PageEvidence, detail_url: str = "") -> list[RepeatedBlock]:
    """Promising link groups, best first: the one containing the given sample
    detail URL, then item-like groups (ids in the path) over navigation."""
    host = urlparse(listing.final_url or listing.url).netloc

    def score(b: RepeatedBlock) -> tuple:
        has_sample = bool(detail_url) and (
            detail_url in b.sample_hrefs or b.href_includes in urlparse(detail_url).path
        )
        nav = any(_NAV_RE.search(h) for h in b.sample_hrefs)
        same_host = all(urlparse(h).netloc == host for h in b.sample_hrefs) if host else True
        id_like = any(re.search(r"\d{2,}|-[a-z0-9]+-[a-z0-9]+", urlparse(h).path) for h in b.sample_hrefs)
        return (has_sample, not nav, same_host, id_like, b.count)

    return sorted(listing.repeated_blocks, key=score, reverse=True)


def build_extraction(
    block: RepeatedBlock,
    detail: PageEvidence,
    *,
    next_page: str = "",
    record_schema_hint: str = "",
) -> dict | None:
    """One candidate config for a link group, or None if no fields were found."""
    extractors: list[dict] = []
    if detail.jsonld_product_present:
        extractors.append({"type": "jsonld_product"})
    fields, required = build_fields(detail, record_schema_hint)
    if fields and required:
        extractors.append({"type": "fields", "fields": fields, "required_fields": [required]})
    if not extractors:
        return None
    link_discovery: dict[str, Any] = {
        "mode": "css",
        "link_selector": block.link_selector,
        "href_includes": block.href_includes,
        "max_pages": 5,
    }
    if next_page:
        link_discovery["next_page_selector"] = next_page
    cfg = {
        "link_discovery": link_discovery,
        "extractors": extractors,
        "request_delay_ms": 1500,
        "respect_robots": True,
    }
    return cfg if not validate_extraction(cfg) else None


def _default_impl() -> dict[str, Callable]:
    from .inspector import inspect_url
    from .preview import run_preview

    return {
        "fetch_page": lambda url, kind: inspect_url(url, kind=kind),
        "run_preview": run_preview,
    }


def propose_without_ai(
    intent: str,
    listing_url: str,
    *,
    detail_url: str = "",
    record_schema_hint: str = "",
    evidence: PageEvidence | None = None,
    on_event: Callable[[str, str], None] | None = None,
    impl: dict[str, Callable] | None = None,
    max_groups: int = MAX_LINK_GROUPS,
) -> AgentResult:
    """Same contract as agent.run_agent (an AgentResult, never raises), minus
    the model: path is always "config"; a failure is `incomplete` + `error`."""
    impl = impl or _default_impl()
    result = AgentResult()

    def emit(status: str, text: str) -> None:
        result.transcript.append({"role": "agent", "status": status, "text": text})
        if on_event:
            try:
                on_event(status, text)
            except Exception:
                pass

    def fail(msg: str) -> AgentResult:
        result.incomplete = True
        result.error = (
            f"{msg} Add a sample detail URL and try again, or turn on Use AI."
        )
        return result

    try:
        listing = evidence or impl["fetch_page"](listing_url, "listing")
    except Exception as e:  # noqa: BLE001
        return fail(f"Couldn't open the listing page ({type(e).__name__}: {e}).")
    if listing.http_status >= 400:
        return fail(f"The listing page answered HTTP {listing.http_status} (blocked?).")

    blocks = rank_blocks(listing, detail_url)[:max_groups]
    if not blocks:
        note = f" ({listing.notes[0]})" if listing.notes else ""
        return fail(f"No repeated item links were found on the listing page{note}.")
    next_page = listing.next_page_candidates[0] if listing.next_page_candidates else ""
    emit("inspecting", f"Found {len(listing.repeated_blocks)} groups of item links; trying the best {len(blocks)}.")

    best: dict | None = None
    best_records: list[dict] = []
    best_diag: dict = {}
    for i, block in enumerate(blocks, 1):
        sample = detail_url if (i == 1 and detail_url) else (block.sample_hrefs[0] if block.sample_hrefs else "")
        if not sample:
            continue
        try:
            detail = impl["fetch_page"](sample, "detail")
        except Exception as e:  # noqa: BLE001
            emit("inspecting", f"Couldn't open {sample}: {type(e).__name__}")
            continue
        cfg = build_extraction(block, detail, next_page=next_page, record_schema_hint=record_schema_hint)
        if cfg is None:
            emit("inspecting", f"Links matching {block.href_includes}: no fields recognised on {sample}.")
            continue
        emit("previewing", f"Trying links matching {block.href_includes} ({block.count} on the page)…")
        try:
            records, diag = impl["run_preview"](cfg, listing_url, "", max_items=PREVIEW_MAX_ITEMS)
        except Exception as e:  # noqa: BLE001
            emit("previewing", f"Preview failed: {type(e).__name__}: {e}")
            continue
        emit("previewing", f"{block.href_includes}: {len(records)} record(s).")
        if records and len(records) > len(best_records):
            best, best_records, best_diag = cfg, records, diag
        if len(best_records) >= PREVIEW_MAX_ITEMS:
            break

    if best is None:
        return fail("None of the link groups produced records.")
    result.extraction = best
    result.output_schema = derive_output_schema(best)
    result.sample_records = best_records
    result.diagnostics = best_diag
    result.summary = (
        f"Built without AI: {len(best_records)} sample record(s) from links matching "
        f"{best['link_discovery']['href_includes']}."
    )
    emit("proposed", result.summary)
    return result
