"""Selector/JSON-drift tests for the classifieds site adapters.

Like test_parsers.py, these run against small synthetic fixtures shaped
like each site's real payload (see the research notes baked into each
adapter's docstring) — fast, hermetic, and catch breakage on a PR rather
than silently in the scheduled run. No network is touched: only the pure
parse_* functions are exercised.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from classifieds import ai, extract  # noqa: E402
from classifieds.cli import resolve_site_keys  # noqa: E402
from classifieds.models import Listing, Seller  # noqa: E402
from classifieds.output import load_seen, save_seen, write_results  # noqa: E402
from classifieds.sites import available, build  # noqa: E402
from classifieds.sites import dubizzle, facebook, opensooq, yallamotor  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "classifieds"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text()


# --------------------------------------------------------------- OpenSooq

def test_opensooq_search_parses_stubs():
    stubs = opensooq.parse_search_html(_read("opensooq_search.html"))
    assert len(stubs) == 2
    first = stubs[0]
    assert first["listing_id"] == "265930847"
    assert first["url"].startswith("https://om.opensooq.com/en/cars/cars-for-sale/")
    assert first["title"] == "Toyota Land Cruiser 2021 GXR"
    assert first["images"] and first["images"][0].endswith(".jpg.webp")


def test_opensooq_search_listings_full_fields():
    # The live adapter builds full Listings straight from the search serp
    # items (plain HTTP, no detail fetch). This fixture mirrors the real
    # serp field names.
    lst = opensooq.parse_search_listings(_read("opensooq_serp.html"))
    assert len(lst) == 2
    a = lst[0]
    assert a.title == "2021 Mazda 6 Luxe"
    assert a.price_value == 5400
    assert a.currency == "OMR"
    assert a.attributes["year"] == "2021"
    assert a.attributes["make"] == "Mazda"
    assert a.attributes["model"] == "6 Luxe"
    assert a.attributes["kilometers"] == "71000"
    assert a.location == "Muscat, Bosher"
    assert a.seller.name == "TAJ MOTORS"
    assert a.seller.phone == "713003XX"  # masked by OpenSooq, key preserved
    assert a.extras["reveal_phone_key"] == "reveal-xyz"
    assert a.url == "https://om.opensooq.com/en/search/282165972"
    assert a.images and a.images[0].endswith(".jpg.webp")
    assert a.uid == "opensooq:282165972"
    # second item: no seller phone -> empty, still parses
    assert lst[1].attributes["make"] == "Chevrolet"
    assert lst[1].price_value == 6900


def test_opensooq_detail_approuter_full_spec():
    # OpenSooq listing pages are App Router now: the full spec + gallery live
    # in the self.__next_f RSC stream, description in og tags.
    hash_a = "a" * 40
    hash_sq = "c" * 40
    payload = (
        '{"label":"Car Make","value":"Toyota","type":"select","fieldName":"car_make"},'
        '{"label":"Year","value":"2022","type":"select","fieldName":"Car_Year"},'
        '{"label":"Kilometers","value":"30,000","type":"n","fieldName":"Kilometers_Cars"},'
        '{"label":"Transmission","value":"Automatic","type":"s","fieldName":"Tramsmission_Cars"},'
        '{"label":"Exterior Color","value":"White","type":"s","fieldName":"Car_Color"},'
        '{"label":"VIN Number","value":"Request VIN Number","type":"v","fieldName":"vin_number"} '
        f"https://opensooq-images.os-cdn.com/previews/1024x0/aa/bb/{hash_a}.jpg.webp "
        f"https://opensooq-images.os-cdn.com/previews/400x0/aa/bb/{hash_a}.jpg.webp "
        f"https://opensooq-images.os-cdn.com/previews/300x300/cc/dd/{hash_sq}.png.jpg"
    )
    html = (
        '<html><head>'
        '<meta property="og:description" content="Clean Toyota, one owner">'
        '<meta property="og:image" content="https://x/og.jpg">'
        "</head><body>"
        "self.__next_f.push([1," + __import__("json").dumps(payload) + "])"
        "</body></html>"
    )
    d = opensooq.parse_detail_approuter(html)
    assert d["attributes"]["make"] == "Toyota"
    assert d["attributes"]["year"] == "2022"
    assert d["attributes"]["kilometers"] == "30,000"
    assert d["attributes"]["transmission"] == "Automatic"
    assert d["attributes"]["exterior_color"] == "White"
    # VIN value is a CTA ("Request VIN Number") -> skipped
    assert "vin" not in d["attributes"]
    # gallery: same photo deduped across sizes -> largest kept; square logo dropped
    assert len(d["images"]) == 1
    assert d["images"][0].startswith("https://opensooq-images.os-cdn.com/previews/1024x0/")
    assert d["description"] == "Clean Toyota, one owner"


def test_opensooq_inserted_date_parsing():
    from datetime import date
    assert opensooq._inserted_date({"inserted_date": "2026-07-16"}) == date(2026, 7, 16)
    assert opensooq._inserted_date({"inserted_date": "2026-07-16T09:00"}) == date(2026, 7, 16)
    assert opensooq._inserted_date({"inserted_date": ""}) is None
    assert opensooq._inserted_date({}) is None


def test_opensooq_detail_full_fields():
    l = opensooq.parse_detail_html(_read("opensooq_detail.html"),
                                   "https://om.opensooq.com/en/cars/cars-for-sale/x-265930847")
    assert l is not None
    assert l.title == "Toyota Land Cruiser 2021 GXR"
    assert l.price_value == 18500
    assert l.currency == "OMR"
    assert len(l.images) == 3
    assert l.location == "Muscat, Al Khuwair"
    assert l.attributes["car_make"] == "Toyota"
    assert l.attributes["year"] == "2021"
    assert l.seller.name == "Ahmed Al Balushi"
    assert l.seller.profile_url.endswith("/771234")
    # Phone is masked by design; the reveal key is preserved for a caller
    # that can complete it.
    assert l.seller.phone == "07956790XX"
    assert l.extras["reveal_phone_key"] == "reveal-abc123"
    assert l.uid == "opensooq:265930847"


# --------------------------------------------------------------- Dubizzle

def test_dubizzle_search_dedups_by_id():
    stubs = dubizzle.parse_search_html(_read("dubizzle_search.html"))
    ids = sorted(s["listing_id"] for s in stubs)
    assert ids == ["130365018", "130400777"]  # duplicate collapsed, pager link ignored
    assert all(s["url"].startswith("https://www.dubizzle.com.om/en/ad/") for s in stubs)


def test_dubizzle_detail_localized_fields():
    url = "https://www.dubizzle.com.om/en/ad/toyota-corolla-2020-ID130365018.html"
    l = dubizzle.parse_detail_html(_read("dubizzle_detail.html"), url)
    assert l is not None
    assert l.title == "Toyota Corolla 2020 XLI"        # picks .en
    assert "agency maintained" in l.description         # html stripped
    assert l.price_value == 5200
    assert l.attributes["make"] == "Toyota"
    assert l.attributes["year"] == "2020"
    assert len(l.images) == 2
    assert l.seller.name == "Salim Motors"
    assert l.listing_id == "130365018"


def test_dubizzle_listing_id_from_url():
    assert dubizzle.listing_id_from_url("/en/ad/x-ID987654.html") == "987654"
    assert dubizzle.listing_id_from_url("/en/ad/no-id-here.html") == ""


def test_dubizzle_contact_info_parsing():
    info = dubizzle.parse_contact_info('{"mobile": "96812345678", "whatsapp": "96887654321"}')
    assert info == {"mobile": "96812345678", "whatsapp": "96887654321"}
    nested = dubizzle.parse_contact_info({"data": {"mobile": "99900011"}})
    assert nested["mobile"] == "99900011"


def test_dubizzle_listing_from_window_state():
    # Live path: results come from window.state Algolia hits, and the ad URL /
    # contactInfo id is the hit's externalID (NOT the Algolia objectID).
    import json
    from datetime import date
    hit = {
        "id": 29634902, "objectID": 29634902, "externalID": 131289980,
        "slug": "cadillac-escalade-2022", "title": "Cadillac Escalade 2022",
        "description": "Luxury SUV", "createdAt": 1783438542.3,
        "extraFields": {"price": 30800},
        "formattedExtraFields": [
            {"attribute": "make", "name_l1": "Brand", "formattedValue_l1": "Cadillac"},
            {"attribute": "model", "name_l1": "Model", "formattedValue_l1": "Escalade"},
            {"attribute": "year", "name_l1": "Year", "formattedValue_l1": "2022"},
            {"attribute": "mileage", "name_l1": "Kilometers", "formattedValue_l1": "81000"},
            {"attribute": "transmission", "name_l1": "Transmission", "formattedValue_l1": "Automatic"},
            {"attribute": "price", "name_l1": "Price", "formattedValue_l1": "30,800"},
        ],
        "photos": [{"id": 27598213}, {"id": 27598214}],
        "location": [
            {"name": "Oman", "level": 0},
            {"name": "Muscat", "level": 1},
            {"name": "Al Ghubrah", "level": 2},
        ],
        "contactInfo": {"name": "Al Fajr Motors"},
    }
    state = {"algolia": {"results": [{"hits": [hit]}]}}
    html = "<html><body>window.state = " + json.dumps(state) + ";</body></html>"

    hits = dubizzle._hits(html)
    assert len(hits) == 1
    l = dubizzle.listing_from_hit(hits[0])
    assert l is not None
    assert l.listing_id == "131289980"          # externalID, not objectID
    assert l.url.endswith("-ID131289980.html")
    assert l.title == "Cadillac Escalade 2022"
    assert l.price_value == 30800
    assert l.attributes["make"] == "Cadillac"
    assert l.attributes["kilometers"] == "81000"
    assert l.attributes["transmission"] == "Automatic"
    assert "price" not in l.attributes         # price handled separately
    assert l.location == "Al Ghubrah, Muscat"  # level>=1, most-specific first
    assert len(l.images) == 2
    assert l.images[0].endswith("-800x600.jpeg") and "27598213" in l.images[0]
    assert l.seller.name == "Al Fajr Motors"
    assert isinstance(dubizzle._dz_created_date(hit), date)


# ------------------------------------------------------------- YallaMotor

def test_yallamotor_search_filters_used_only():
    stubs = yallamotor.parse_search_html(_read("yallamotor_search.html"))
    ids = sorted(s["listing_id"] for s in stubs)
    assert ids == ["88123", "88456"]  # new-cars link and dup excluded


def test_yallamotor_detail_json_ld():
    url = "https://oman.yallamotor.com/used-cars/toyota/camry-2019-88123"
    l = yallamotor.parse_detail_html(_read("yallamotor_detail.html"), url)
    assert l is not None
    assert l.title == "Toyota Camry 2019"
    assert l.price_value == 3900
    assert l.attributes["brand"] == "Toyota"
    assert l.attributes["fuelType"] == "Petrol"
    assert len(l.images) == 2
    assert l.seller.phone == "+96891234567"  # normalized Oman number
    assert l.listing_id == "88123"


# -------------------------------------------------------------- Facebook

def test_facebook_search_extracts_item_ids():
    html = _read("facebook_item.html")
    stubs = facebook.parse_search_html(html)
    assert stubs and stubs[0]["listing_id"] == "1234567890"


def test_facebook_item_json_no_phone():
    url = "https://www.facebook.com/marketplace/item/1234567890/"
    l = facebook.parse_item_json(_read("facebook_item.html"), url)
    assert l is not None
    assert l.title == "Toyota Hilux 2017 Double Cab"
    assert l.price_value == 6500
    assert l.location == "Muscat, Oman"
    assert len(l.images) == 2
    assert l.seller.name == "Khalid A."
    assert l.seller.phone == ""                     # never available on FB
    assert l.extras["phone_available"] is False


def test_facebook_requires_cookies():
    adapter = build("facebook")  # no cookies
    from classifieds.sites.base import SearchSpec
    with pytest.raises(ValueError, match="requires a session"):
        list(adapter.search(SearchSpec()))


# ----------------------------------------------------------- shared bits

def test_extract_price_and_phone_helpers():
    assert extract.parse_omr_price("Price: 3,500 OMR") == 3500
    assert extract.parse_omr_price("OMR 12000") == 12000
    assert extract.find_oman_phone("call 91234567 anytime") == "+96891234567"
    assert extract.find_oman_phone("+968 7123 4567") == "+96871234567"
    assert extract.find_oman_phone("no number here") == ""


def test_extract_walk_finds_nested_dicts():
    blob = {"a": {"b": [{"items": [1]}, {"x": 1}]}}
    hits = list(extract.walk(blob, {"items"}))
    assert len(hits) == 1 and hits[0]["items"] == [1]


def test_listing_uid_stable_and_dict_roundtrip():
    l = Listing(site="opensooq", listing_id="42", url="https://x/y",
                seller=Seller(name="A"))
    assert l.uid == "opensooq:42"
    d = l.to_dict()
    assert d["uid"] == "opensooq:42" and d["seller"]["name"] == "A"
    # URL-hash fallback when no native id
    l2 = Listing(site="dubizzle", listing_id="", url="https://x/z")
    assert l2.uid.startswith("dubizzle:") and len(l2.uid) > len("dubizzle:")


def test_registry_and_cli_site_resolution():
    assert set(available()) == {"opensooq", "dubizzle", "yallamotor", "facebook"}
    assert resolve_site_keys("all", "") == ["opensooq", "dubizzle", "yallamotor"]
    assert "facebook" in resolve_site_keys("all", "cookies.json")
    with pytest.raises(SystemExit):
        resolve_site_keys("nosuchsite", "")


def test_output_write_and_seen_state(tmp_path):
    listings = [Listing(site="opensooq", listing_id="1", url="u1", title="A"),
                Listing(site="dubizzle", listing_id="2", url="u2", title="B")]
    path = write_results(listings, tmp_path, "jsonl")
    assert path.exists()
    assert len(path.read_text().strip().splitlines()) == 2

    state = tmp_path / "seen.json"
    save_seen(state, {"opensooq:1", "dubizzle:2"})
    assert load_seen(state) == {"opensooq:1", "dubizzle:2"}


def test_ai_merge_fills_only_blanks():
    d = Listing(site="opensooq", listing_id="1", url="u", title="Kept").to_dict()
    ai.merge_ai_fields(d, {"title": "Ignored", "description": "From AI",
                           "price_value": 999, "seller_phone": "91234567",
                           "images": ["http://img/1.jpg"]})
    assert d["title"] == "Kept"                 # adapter value wins
    assert d["description"] == "From AI"        # blank filled
    assert d["price_value"] == 999.0
    assert d["seller"]["phone"] == "91234567"
    assert d["images"] == ["http://img/1.jpg"]


def test_ai_disabled_without_key(monkeypatch):
    monkeypatch.delenv("CLASSIFIEDS_AI_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert ai.ai_enabled() is False
    assert ai.ai_extract_listing("<html></html>", "http://x") is None
