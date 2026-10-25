"""collect.py — the parts that don't need a browser."""

from __future__ import annotations

import csv
import json

import collect


def test_place_id_is_googles_id_from_the_link_else_name_and_address():
    url = "https://www.google.com/maps/place/X/data=!4m7!3m6!1s0x4030:0x37ff!8m2!3d40.4!4d49.8"
    assert collect.place_id({"maps_url": url}) == "0x4030:0x37ff"
    assert collect.place_id({"name": "Acme Training", "address": "1 Main St, Baku"}) == "acme-training-1-main-st-baku"


def test_files_open_in_excel_and_keep_every_row(tmp_path):
    rows = [{"source": "google_maps", "name": "Səlyan Academy", "phone": "+994 12 000", "extra": "dropped"},
            {"source": "google_search", "title": "A page", "link": "https://a.example/x"}]
    collect.write_files(rows, tmp_path / "out")
    raw = (tmp_path / "out.csv").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")  # BOM so Excel reads UTF-8
    got = list(csv.DictReader((tmp_path / "out.csv").open(encoding="utf-8-sig")))
    assert [g["name"] for g in got] == ["Səlyan Academy", ""] and got[1]["link"] == "https://a.example/x"
    assert json.loads((tmp_path / "out.json").read_text(encoding="utf-8")) == rows
