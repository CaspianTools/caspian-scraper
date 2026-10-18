"""Regression tests for _upsert_generic_record (scrape.py) using a tiny fake
Firestore: url-less records must not collide, and write failures must surface as
"error" rather than being miscounted as duplicates.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scrape import _upsert_generic_record  # noqa: E402


class _Snap:
    def __init__(self, exists):
        self.exists = exists


class _Doc:
    def __init__(self, store, uid, *, boom=False):
        self.store, self.uid, self.boom = store, uid, boom

    def get(self):
        if self.boom:
            raise RuntimeError("firestore down")
        return _Snap(self.uid in self.store)

    def set(self, data):
        self.store[self.uid] = dict(data)

    def update(self, data):
        self.store[self.uid].update(data)


class _Col:
    def __init__(self, store, boom):
        self.store, self.boom = store, boom

    def document(self, uid):
        return _Doc(self.store, uid, boom=self.boom)


class _DB:
    def __init__(self, *, boom=False):
        self.cols: dict = {}
        self.boom = boom

    def collection(self, name):
        return _Col(self.cols.setdefault(name, {}), self.boom)


def test_urlless_records_do_not_collide():
    db = _DB()
    uid1, r1 = _upsert_generic_record(db, "u", "sid", "src", "", {"title": "A"})
    uid2, r2 = _upsert_generic_record(db, "u", "sid", "src", "", {"title": "B"})
    assert r1 == "new" and r2 == "new"
    assert uid1 != uid2                       # distinct data -> distinct docs
    assert len(db.cols["generic_records"]) == 2


def test_same_url_upserts_same_doc():
    db = _DB()
    _uid1, r1 = _upsert_generic_record(db, "u", "sid", "src", "https://x/1", {"n": 1})
    _uid2, r2 = _upsert_generic_record(db, "u", "sid", "src", "https://x/1", {"n": 2})
    assert r1 == "new" and r2 == "seen"
    assert len(db.cols["generic_records"]) == 1


def test_write_failure_returns_error():
    db = _DB(boom=True)
    _uid, result = _upsert_generic_record(db, "u", "sid", "src", "https://x", {"a": 1})
    assert result == "error"                  # never silently "seen"
