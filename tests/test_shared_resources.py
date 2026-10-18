"""load_sources (scrape.py) merges a project's own /sources with the shared
/resources it lists in `resource_ids`, using a tiny fake Firestore."""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scrape import load_sources  # noqa: E402


class _Snap:
    def __init__(self, doc_id, data):
        self.id, self._data = doc_id, data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _Ref:
    def __init__(self, store, doc_id):
        self.store, self.id = store, doc_id

    def get(self):
        return _Snap(self.id, self.store.get(self.id))

    def collection(self, name):
        return _Col(self.store.setdefault(f"{self.id}/{name}", {}))


class _Col:
    def __init__(self, store):
        self.store = store
        self._active_only = False

    def document(self, doc_id):
        return _Ref(self.store, doc_id)

    def where(self, filter):  # noqa: A002 — mirrors the Firestore kwarg
        q = _Col(self.store)
        q._active_only = True
        return q

    def stream(self):
        for doc_id, data in self.store.items():
            if "/" in doc_id or not isinstance(data, dict):
                continue
            if self._active_only and data.get("active") is not True:
                continue
            yield _Snap(doc_id, data)


class _DB:
    def __init__(self):
        self.cols: dict = {}

    def collection(self, name):
        return _Col(self.cols.setdefault(name, {}))

    def get_all(self, refs):
        return [r.get() for r in refs]


def _seed():
    db = _DB()
    db.collection("projects").document("p1").collection("sources").document(
        "own1"
    ).store["own1"] = {
        "name": "Own", "careers_url": "https://a.example/jobs/", "active": True,
    }
    res = db.cols.setdefault("resources", {})
    res["r1"] = {"name": "Shared", "careers_url": "https://b.example/jobs",
                 "active": True, "owner_uid": "u1"}
    res["r2"] = {"name": "Inactive", "careers_url": "https://c.example",
                 "active": False, "owner_uid": "u1"}
    res["r3"] = {"name": "Foreign", "careers_url": "https://d.example",
                 "active": True, "owner_uid": "someone-else"}
    res["r4"] = {"name": "Dupe of own", "careers_url": "https://A.example/jobs",
                 "active": True, "owner_uid": "u1"}
    return db


def test_merges_own_sources_with_shared_resources():
    db = _seed()
    project = {"owner_uid": "u1", "resource_ids": ["r1", "r2", "r3", "r4", "gone"]}
    got = load_sources(db, "p1", active_only=True, project=project)
    names = [s["name"] for s in got]
    # r2 inactive, r3 another owner, r4 duplicates own1's URL, "gone" missing.
    assert names == ["Own", "Shared"]
    shared = got[1]
    assert shared["__id"] == "r1" and shared["__resource"] is True
    assert "__resource" not in got[0]


def test_no_resource_ids_returns_only_own_sources():
    db = _seed()
    got = load_sources(db, "p1", active_only=True, project={"owner_uid": "u1"})
    assert [s["__id"] for s in got] == ["own1"]
