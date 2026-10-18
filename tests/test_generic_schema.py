"""Pure (no-browser, no-network) tests for the generic-source plumbing:
record normalisation, deterministic record uids, and the record-schema
field-spec shape the Zod GenericSourceCreateSchema mirrors.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scrape import (  # noqa: E402  (sys.path tweak before import)
    GenericRecord,
    ProductListing,
    _generic_record_to_data,
    listing_id_for,
)


# ---------- record normalisation ----------

def test_normalise_generic_record():
    rec = GenericRecord(source_id="s", url="u", fields={"title": "Hello", "n": "1"})
    assert _generic_record_to_data(rec) == {"title": "Hello", "n": "1"}


def test_normalise_product_listing_drops_raw_jsonld():
    pl = ProductListing(
        retailer_id="r",
        retailer_name="R",
        product_url="https://x/p",
        name="Widget",
        price_value=9.99,
        raw_jsonld={"@type": "Product"},
    )
    data = _generic_record_to_data(pl)
    assert data["name"] == "Widget"
    assert data["price_value"] == 9.99
    assert "raw_jsonld" not in data  # internal blob is not persisted


def test_normalise_adapter_envelope_and_bare_dict():
    # adapter records may arrive as {"data": {...}} envelopes …
    assert _generic_record_to_data({"data": {"a": 1}}) == {"a": 1}
    # … or as a bare dict.
    assert _generic_record_to_data({"a": 1}) == {"a": 1}


def test_normalise_unknown_type_is_empty():
    assert _generic_record_to_data(object()) == {}


# ---------- record identity ----------

def test_record_uid_is_deterministic_and_url_scoped():
    a = listing_id_for("blog", "https://x/post-1")
    b = listing_id_for("blog", "https://x/post-1")
    c = listing_id_for("blog", "https://x/post-2")
    assert a == b            # stable across calls / runs
    assert a != c            # distinct urls -> distinct ids
    assert len(a) == 32
