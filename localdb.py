"""
File-backed stand-in for the Firestore client, used when the scraper runs
locally (no GOOGLE_APPLICATION_CREDENTIALS_JSON). It implements just the
subset of the google-cloud-firestore API that scrape.py and aiconfig use:

    db.collection(name).document(id?) / .where(filter=FieldFilter(..."=="...))
      .order_by(field, direction=) / .limit(n) / .select([...]) / .stream()
      / .get() / .count().get()
    doc.get() / .set(data, merge=) / .update(data) / .create(data) / .delete()
      / .collection(name)
    db.get_all(refs)
    SERVER_TIMESTAMP, Increment, ArrayUnion, ArrayRemove, DELETE_FIELD

The web app reads and writes the SAME files through web/lib/localdb.ts —
the two must keep agreeing on this layout:

    data/<col>/<id>.json                committed config (see CONFIG_COLLECTIONS)
    data/<col>/<id>/<sub>/<subid>.json
    local-data/...                      everything else: runs, findings,
                                        lessons, listings… (gitignored)
    local-data/_overlay/<path>.json     VOLATILE_FIELDS of config docs, so a
                                        run never dirties the committed files

One JSON object per document. Timestamps are stored as {"__ts": "<ISO>"} and
read back as aware datetimes (Firestore returns datetimes too). Doc ids are
percent-encoded outside [A-Za-z0-9._-].
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import string
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import unquote

from google.cloud.firestore_v1.transforms import (
    DELETE_FIELD,
    SERVER_TIMESTAMP,
    ArrayRemove,
    ArrayUnion,
    Increment,
)

REPO_ROOT = Path(__file__).resolve().parent
CONFIG_ROOT = Path(os.environ.get("CASPIAN_CONFIG_DIR") or REPO_ROOT / "data")
LOCAL_ROOT = Path(os.environ.get("CASPIAN_LOCAL_DIR") or REPO_ROOT / "local-data")

# Collection paths (collection names only; doc ids are wildcards) whose docs
# are committed to the repo. Keep in sync with web/lib/localdb.ts.
CONFIG_COLLECTIONS = {
    ("projects",),
    ("projects", "sources"),
    ("resources",),
    ("comparison_sources",),
    ("car_sources",),
    ("generic_sources",),
    ("databases",),
}
# Run-derived fields the scraper writes onto config docs.
VOLATILE_FIELDS = {"last_run_at", "last_run_summary"}

_SAFE_ID = re.compile(r"[A-Za-z0-9._-]")
_AUTO_ID_CHARS = string.ascii_letters + string.digits


class NotFound(Exception):
    pass


class AlreadyExists(Exception):
    pass


def _now_iso() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _encode_id(doc_id: str) -> str:
    return "".join(
        ch if _SAFE_ID.fullmatch(ch) else "".join(f"%{b:02X}" for b in ch.encode())
        for ch in doc_id
    )


def _decode_id(name: str) -> str:
    return unquote(name)


def _is_config(col_names: tuple[str, ...]) -> bool:
    return col_names in CONFIG_COLLECTIONS


# ---- value encoding ------------------------------------------------------

def _to_disk(v: Any) -> Any:
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        iso = v.astimezone(timezone.utc).isoformat(timespec="milliseconds")
        return {"__ts": iso.replace("+00:00", "Z")}
    if isinstance(v, dict):
        return {k: _to_disk(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_to_disk(x) for x in v]
    return v


def _from_disk(v: Any) -> Any:
    if isinstance(v, dict):
        if set(v) == {"__ts"}:
            return datetime.fromisoformat(v["__ts"].replace("Z", "+00:00"))
        return {k: _from_disk(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_from_disk(x) for x in v]
    return v


def _deep_merge(current: Any, new: Any) -> Any:
    """set(merge=True): maps merge recursively, everything else replaces."""
    if isinstance(current, dict) and isinstance(new, dict):
        out = dict(current)
        for k, v in new.items():
            out[k] = _deep_merge(current.get(k), v)
        return out
    return new


def _apply(current: Any, new: Any) -> Any:
    """Resolve Firestore sentinels/transforms in `new` against `current`."""
    if new is SERVER_TIMESTAMP:
        return {"__ts": _now_iso()}
    if isinstance(new, Increment):
        base = current if isinstance(current, (int, float)) else 0
        return base + new.value
    if isinstance(new, ArrayUnion):
        out = list(current) if isinstance(current, list) else []
        for x in new.values:
            if _to_disk(x) not in out:
                out.append(_to_disk(x))
        return out
    if isinstance(new, ArrayRemove):
        drop = [_to_disk(x) for x in new.values]
        return [x for x in (current if isinstance(current, list) else []) if x not in drop]
    if isinstance(new, dict):
        cur = current if isinstance(current, dict) else {}
        return {k: _apply(cur.get(k), x) for k, x in new.items() if x is not DELETE_FIELD}
    if isinstance(new, (list, tuple)):
        return [_apply(None, x) for x in new]
    return _to_disk(new)


# ---- disk I/O ------------------------------------------------------------

def _read_json(path: Path) -> dict | None:
    for attempt in range(5):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (PermissionError, json.JSONDecodeError):
            # Another process is mid-replace on Windows; retry briefly.
            if attempt == 4:
                raise
            time.sleep(0.05)
    return None


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    tmp.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    for attempt in range(10):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.05)


def _unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


# ---- references ----------------------------------------------------------

class DocumentSnapshot:
    def __init__(self, ref: "DocumentReference", data: dict | None):
        self.reference = ref
        self.id = ref.id
        self._data = data

    @property
    def exists(self) -> bool:
        return self._data is not None

    def to_dict(self) -> dict | None:
        return _from_disk(self._data) if self._data is not None else None

    def get(self, field: str) -> Any:
        return (self.to_dict() or {}).get(field)


class DocumentReference:
    def __init__(self, segments: tuple[str, ...]):
        self._segments = segments  # alternating collection, id, collection, id…

    @property
    def id(self) -> str:
        return self._segments[-1]

    @property
    def path(self) -> str:
        return "/".join(self._segments)

    def _col_names(self) -> tuple[str, ...]:
        return self._segments[0::2]

    def _rel(self) -> Path:
        parts = [
            s if i % 2 == 0 else _encode_id(s) for i, s in enumerate(self._segments)
        ]
        return Path(*parts[:-1]) / f"{parts[-1]}.json"

    def _base_path(self) -> Path:
        root = CONFIG_ROOT if _is_config(self._col_names()) else LOCAL_ROOT
        return root / self._rel()

    def _overlay_path(self) -> Path | None:
        if not _is_config(self._col_names()):
            return None
        return LOCAL_ROOT / "_overlay" / self._rel()

    def _read(self) -> dict | None:
        base = _read_json(self._base_path())
        if base is None:
            return None
        ov = self._overlay_path()
        if ov is not None:
            base.update(_read_json(ov) or {})
        return base

    def _write(self, data: dict) -> None:
        ov = self._overlay_path()
        if ov is None:
            _write_json(self._base_path(), data)
            return
        stable = {k: v for k, v in data.items() if k not in VOLATILE_FIELDS}
        volatile = {k: v for k, v in data.items() if k in VOLATILE_FIELDS}
        if _read_json(self._base_path()) != stable:
            _write_json(self._base_path(), stable)
        if volatile:
            if _read_json(ov) != volatile:
                _write_json(ov, volatile)
        else:
            _unlink(ov)

    def collection(self, name: str) -> "CollectionReference":
        return CollectionReference(self._segments + (name,))

    def get(self, *_args, **_kwargs) -> DocumentSnapshot:
        return DocumentSnapshot(self, self._read())

    def set(self, data: dict, merge: bool = False) -> None:
        if not merge:
            self._write(_apply({}, data))
            return
        current = self._read() or {}
        merged = _deep_merge(current, _apply(current, data))
        for k, v in data.items():
            if v is DELETE_FIELD:
                merged.pop(k, None)
        self._write(merged)

    def update(self, data: dict) -> None:
        current = self._read()
        if current is None:
            raise NotFound(f"No document to update: {self.path}")
        for k, v in data.items():
            if v is DELETE_FIELD:
                current.pop(k, None)
            else:
                current[k] = _apply(current.get(k), v)
        self._write(current)

    def create(self, data: dict) -> None:
        if self._read() is not None:
            raise AlreadyExists(f"Document already exists: {self.path}")
        self._write(_apply({}, data))

    def delete(self) -> None:
        _unlink(self._base_path())
        ov = self._overlay_path()
        if ov is not None:
            _unlink(ov)


class _Count:
    def __init__(self, value: int):
        self.value = value


class Query:
    def __init__(self, col: "CollectionReference", filters=(), orders=(), limit=None, fields=None):
        self._col = col
        self._filters = list(filters)
        self._orders = list(orders)
        self._limit = limit
        self._fields = fields

    def _clone(self, **kw) -> "Query":
        q = Query(self._col, self._filters, self._orders, self._limit, self._fields)
        for k, v in kw.items():
            setattr(q, k, v)
        return q

    def where(self, field_path=None, op_string=None, value=None, *, filter=None):  # noqa: A002
        if filter is not None:
            field_path, op_string, value = filter.field_path, filter.op_string, filter.value
        if op_string != "==":
            raise NotImplementedError(f"localdb only supports '==' (got {op_string!r})")
        return self._clone(_filters=self._filters + [(field_path, _to_disk(value))])

    def order_by(self, field_path: str, direction: str = "ASCENDING"):
        return self._clone(_orders=self._orders + [(field_path, str(direction).upper() == "DESCENDING")])

    def limit(self, count: int):
        return self._clone(_limit=count)

    def select(self, field_paths: Iterable[str]):
        return self._clone(_fields=list(field_paths))

    def count(self):
        q = self

        class _Agg:
            def get(self_inner, *_a, **_k):
                return [[_Count(sum(1 for _ in q.stream()))]]

        return _Agg()

    def stream(self, *_args, **_kwargs) -> Iterator[DocumentSnapshot]:
        snaps = [
            s for s in self._col._all()
            if all(s._data.get(f) == v for f, v in self._filters)
        ]
        for field, desc in reversed(self._orders):
            snaps = [s for s in snaps if field in s._data]
            snaps.sort(key=lambda s: _sort_key(s._data[field]), reverse=desc)
        if self._limit is not None:
            snaps = snaps[: self._limit]
        for s in snaps:
            if self._fields is not None:
                s = DocumentSnapshot(
                    s.reference, {k: v for k, v in s._data.items() if k in self._fields}
                )
            yield s

    def get(self, *_args, **_kwargs) -> list[DocumentSnapshot]:
        return list(self.stream())


def _sort_key(v: Any):
    # Firestore type order: null < bool < number < timestamp < string < array < map
    if v is None:
        return (0, 0)
    if isinstance(v, bool):
        return (1, v)
    if isinstance(v, (int, float)):
        return (2, v)
    if isinstance(v, dict) and set(v) == {"__ts"}:
        return (3, v["__ts"])
    if isinstance(v, str):
        return (4, v)
    if isinstance(v, list):
        return (5, json.dumps(v, sort_keys=True))
    return (6, json.dumps(v, sort_keys=True))


class CollectionReference(Query):
    def __init__(self, segments: tuple[str, ...]):
        self._segments = segments
        super().__init__(self)

    @property
    def id(self) -> str:
        return self._segments[-1]

    def document(self, doc_id: str | None = None) -> DocumentReference:
        if doc_id is None:
            doc_id = "".join(secrets.choice(_AUTO_ID_CHARS) for _ in range(20))
        return DocumentReference(self._segments + (doc_id,))

    def add(self, data: dict):
        ref = self.document()
        ref.create(data)
        return _now_iso(), ref

    def _all(self) -> list[DocumentSnapshot]:
        probe = self.document("x")
        directory = probe._base_path().parent
        if not directory.is_dir():
            return []
        out = []
        for f in directory.glob("*.json"):
            if f.name.startswith("."):
                continue
            ref = DocumentReference(self._segments + (_decode_id(f.stem),))
            data = ref._read()
            if data is not None:
                out.append(DocumentSnapshot(ref, data))
        return out


class LocalDB:
    """Drop-in for google.cloud.firestore.Client in local mode."""

    def collection(self, name: str) -> CollectionReference:
        return CollectionReference((name,))

    def get_all(self, refs: Iterable[DocumentReference]) -> Iterator[DocumentSnapshot]:
        for ref in refs:
            yield ref.get()

    def recursive_delete(self, ref: DocumentReference) -> None:
        ref.delete()
        rel_dir = ref._rel().with_suffix("")
        for root in (CONFIG_ROOT, LOCAL_ROOT, LOCAL_ROOT / "_overlay"):
            shutil.rmtree(root / rel_dir, ignore_errors=True)
