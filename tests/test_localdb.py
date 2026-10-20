"""localdb.py — the file-backed Firestore stand-in used for local runs."""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import localdb  # noqa: E402
from google.cloud.firestore_v1 import (  # noqa: E402
    SERVER_TIMESTAMP,
    ArrayRemove,
    ArrayUnion,
    FieldFilter,
    Increment,
    Query,
)


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(localdb, "CONFIG_ROOT", tmp_path / "data")
    monkeypatch.setattr(localdb, "LOCAL_ROOT", tmp_path / "local-data")
    return localdb.LocalDB()


def test_config_and_run_data_land_in_separate_roots(db, tmp_path):
    proj = db.collection("projects").document("hse")
    proj.set({"name": "HSE", "enabled": True})
    proj.collection("sources").document("s1").set({"name": "A"})
    proj.collection("runs").document("r1").set({"status": "ok"})

    assert (tmp_path / "data/projects/hse.json").exists()
    assert (tmp_path / "data/projects/hse/sources/s1.json").exists()
    assert (tmp_path / "local-data/projects/hse/runs/r1.json").exists()
    assert not (tmp_path / "data/projects/hse/runs").exists()


def test_volatile_fields_go_to_overlay_and_leave_config_untouched(db, tmp_path):
    proj = db.collection("projects").document("hse")
    proj.set({"name": "HSE"})
    committed = (tmp_path / "data/projects/hse.json").read_text()

    proj.update({"last_run_at": SERVER_TIMESTAMP})

    assert (tmp_path / "data/projects/hse.json").read_text() == committed
    overlay = json.loads((tmp_path / "local-data/_overlay/projects/hse.json").read_text())
    assert "__ts" in overlay["last_run_at"]
    got = proj.get().to_dict()
    assert got["name"] == "HSE" and isinstance(got["last_run_at"], datetime)


def test_transforms(db):
    ref = db.collection("findings").document("f")
    ref.set({"attempts": Increment(1), "tags": ArrayUnion(["a"]),
             "summary": {"ts": SERVER_TIMESTAMP, "n": 1}})
    ref.update({"attempts": Increment(2), "tags": ArrayUnion(["a", "b"])})
    ref.update({"tags": ArrayRemove(["a"])})
    d = ref.get().to_dict()
    assert d["attempts"] == 3 and d["tags"] == ["b"]
    assert isinstance(d["summary"]["ts"], datetime) and d["summary"]["n"] == 1


def test_set_merge_deep_merges_maps(db):
    ref = db.collection("x").document("d")
    ref.set({"a": {"b": 1, "c": 2}, "keep": True})
    ref.set({"a": {"c": 3}}, merge=True)
    assert ref.get().to_dict() == {"a": {"b": 1, "c": 3}, "keep": True}
    ref.set({"only": 1})
    assert ref.get().to_dict() == {"only": 1}


def test_update_and_create_errors(db):
    ref = db.collection("x").document("missing")
    with pytest.raises(localdb.NotFound):
        ref.update({"a": 1})
    ref.create({"a": 1})
    with pytest.raises(localdb.AlreadyExists):
        ref.create({"a": 2})


def test_queries(db):
    col = db.collection("runs")
    for i, (status, ts) in enumerate([("ok", "b"), ("error", "c"), ("ok", "a")]):
        col.document(f"r{i}").set({"status": status, "started_at": ts, "n": i})
    col.document("nofield").set({"status": "ok"})

    ok = [s.id for s in col.where(filter=FieldFilter("status", "==", "ok")).stream()]
    assert sorted(ok) == ["nofield", "r0", "r2"]

    # order_by drops docs lacking the field, like Firestore.
    newest = col.order_by("started_at", direction=Query.DESCENDING).limit(2).get()
    assert [s.id for s in newest] == ["r1", "r0"]

    sel = col.order_by("n").select(["n"]).get()
    assert [s.to_dict() for s in sel] == [{"n": 0}, {"n": 1}, {"n": 2}]
    assert col.count().get()[0][0].value == 4

    with pytest.raises(NotImplementedError):
        col.where("n", ">", 1)


def test_odd_ids_round_trip_and_get_all(db):
    col = db.collection("listings")
    col.document("a/b:c?").set({"v": 1})
    auto = col.document()
    auto.set({"v": 2})
    assert len(auto.id) == 20
    assert sorted(s.id for s in col.stream()) == sorted(["a/b:c?", auto.id])
    snaps = list(db.get_all([col.document("a/b:c?"), col.document("nope")]))
    assert snaps[0].exists and not snaps[1].exists


def test_recursive_delete_cleans_both_roots(db, tmp_path):
    proj = db.collection("projects").document("p")
    proj.set({"name": "P", "last_run_at": SERVER_TIMESTAMP})
    proj.collection("sources").document("s").set({"name": "S"})
    proj.collection("runs").document("r").set({"status": "ok"})
    db.recursive_delete(proj)
    assert not proj.get().exists
    assert not (tmp_path / "data/projects/p").exists()
    assert not (tmp_path / "local-data/projects/p").exists()
    assert not (tmp_path / "local-data/_overlay/projects/p.json").exists()
