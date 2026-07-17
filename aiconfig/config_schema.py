"""Python mirror + validator for the extraction config the AI emits.

Mirrors web/lib/firestore/schema.ts → ExtractionConfigSchema / LinkDiscoverySchema
/ ExtractorSchema (including the `fields` extractor added in Phase 0). The Zod
schema is the source of truth; this keeps the CLI/agent honest without a Node
round-trip. Returns a list of human-readable error strings ([] == valid) so the
agent can be told exactly what to fix.
"""

from __future__ import annotations

from typing import Any

LINK_MODES = {"sitemap", "css", "category_seeds"}
EXTRACTOR_TYPES = {"jsonld_product", "microdata", "og_meta", "css", "fields"}

_MAX_SELECTOR = 500


def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _nonempty_str(v: Any, *, limit: int = _MAX_SELECTOR) -> bool:
    return isinstance(v, str) and 0 < len(v) <= limit


def _validate_link_discovery(ld: Any, errs: list[str]) -> None:
    if not isinstance(ld, dict):
        errs.append("link_discovery must be an object")
        return
    mode = ld.get("mode")
    if mode not in LINK_MODES:
        errs.append(
            f"link_discovery.mode must be one of {sorted(LINK_MODES)} (got {mode!r})"
        )
        return
    if mode == "sitemap":
        if not _nonempty_str(ld.get("sitemap_url"), limit=2000):
            errs.append("link_discovery.sitemap_url must be a non-empty URL string")
    elif mode == "css":
        if not _nonempty_str(ld.get("link_selector")):
            errs.append("link_discovery.link_selector must be a non-empty string")
        mp = ld.get("max_pages", 5)
        if not isinstance(mp, int) or not (1 <= mp <= 20):
            errs.append("link_discovery.max_pages must be an int in 1..20")
    elif mode == "category_seeds":
        seeds = ld.get("seed_urls")
        if not isinstance(seeds, list) or not (1 <= len(seeds) <= 50):
            errs.append("link_discovery.seed_urls must be a list of 1..50 URLs")
        elif not all(_nonempty_str(s, limit=2000) for s in seeds):
            errs.append("link_discovery.seed_urls entries must be URL strings")
        if not _nonempty_str(ld.get("link_selector")):
            errs.append("link_discovery.link_selector must be a non-empty string")
        mp = ld.get("max_pages", 3)
        if not isinstance(mp, int) or not (1 <= mp <= 20):
            errs.append("link_discovery.max_pages must be an int in 1..20")


def _validate_extractor(ex: Any, idx: int, errs: list[str]) -> None:
    where = f"extractors[{idx}]"
    if not isinstance(ex, dict):
        errs.append(f"{where} must be an object")
        return
    t = ex.get("type")
    if t not in EXTRACTOR_TYPES:
        errs.append(
            f"{where}.type must be one of {sorted(EXTRACTOR_TYPES)} (got {t!r})"
        )
        return
    if t == "css":
        if not _nonempty_str(ex.get("name_selector")):
            errs.append(f"{where}.name_selector required for css extractor")
        if not _nonempty_str(ex.get("price_selector")):
            errs.append(f"{where}.price_selector required for css extractor")
        cur = ex.get("currency")
        if not (isinstance(cur, str) and len(cur) == 3):
            errs.append(f"{where}.currency must be a 3-letter code")
    elif t == "fields":
        fields = ex.get("fields")
        if not isinstance(fields, dict) or not fields:
            errs.append(f"{where}.fields must be a non-empty object")
        else:
            for name, sel in fields.items():
                if not _is_str(name) or not name:
                    errs.append(f"{where}.fields has an empty field name")
                if not _nonempty_str(sel):
                    errs.append(
                        f"{where}.fields[{name!r}] must be a selector string "
                        f"(<= {_MAX_SELECTOR} chars)"
                    )
        req = ex.get("required_fields")
        if req is not None:
            if not isinstance(req, list) or not all(_is_str(r) for r in req):
                errs.append(f"{where}.required_fields must be a list of field names")
            elif isinstance(fields, dict):
                unknown = [r for r in req if r not in fields]
                if unknown:
                    errs.append(
                        f"{where}.required_fields references undeclared fields: "
                        f"{unknown}"
                    )


def validate_extraction(cfg: Any) -> list[str]:
    """Validate an extraction config dict. Returns [] when valid, else a list
    of error strings. Never raises."""
    errs: list[str] = []
    if not isinstance(cfg, dict):
        return ["extraction config must be a JSON object"]

    _validate_link_discovery(cfg.get("link_discovery"), errs)

    extractors = cfg.get("extractors")
    if not isinstance(extractors, list) or not (1 <= len(extractors) <= 6):
        errs.append("extractors must be a list of 1..6 items")
    else:
        for i, ex in enumerate(extractors):
            _validate_extractor(ex, i, errs)

    delay = cfg.get("request_delay_ms", 1500)
    if not isinstance(delay, int) or not (0 <= delay <= 60000):
        errs.append("request_delay_ms must be an int in 0..60000")

    for opt in ("user_agent", "wait_for_selector"):
        if opt in cfg and cfg[opt] is not None and not isinstance(cfg[opt], str):
            errs.append(f"{opt} must be a string when present")

    if "respect_robots" in cfg and not isinstance(cfg["respect_robots"], bool):
        errs.append("respect_robots must be a boolean when present")

    return errs


def derive_output_schema(cfg: Any) -> list[str]:
    """The field names this config will emit (best-effort). For a `fields`
    extractor these are its keys; for product extractors it's the fixed
    ProductListing surface."""
    if not isinstance(cfg, dict):
        return []
    names: list[str] = []
    product_fields = [
        "name", "brand", "gtin", "size_value", "size_unit",
        "price_value", "price_currency", "in_stock", "image_url",
    ]
    for ex in cfg.get("extractors") or []:
        if not isinstance(ex, dict):
            continue
        if ex.get("type") == "fields" and isinstance(ex.get("fields"), dict):
            for k in ex["fields"].keys():
                if k not in names:
                    names.append(str(k))
        elif ex.get("type") in ("jsonld_product", "og_meta", "css", "microdata"):
            for k in product_fields:
                if k not in names:
                    names.append(k)
    return names
