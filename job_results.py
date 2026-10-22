"""A job's results — one store per job, whatever engines its sources use.

Each engine keeps its own records (vacancy findings under the project, car
listings, shop listings, generic records — each with source_id, first_seen_at,
last_seen_at). After a job runs, collect() gathers every record of the job's
sources into the job's store in the SQLite record store ("job:<id>",
recordstore.py) in one shape:

    id            "<engine letter>:<native id>"  (v vacancy, c car, p shop, g generic)
    title, url, source, engine, + the engine's own fields (company, location,
                  price, year, …)
    first_seen, last_seen      ISO times
    status        new | changed | unchanged | gone   (this run vs the last)
    fingerprint   hash of the content fields, to tell "changed"
    tags, hidden, relevance    kept from the store (people's decisions /
                               relevance.py scores) — never overwritten here

"gone": a record of a source that ran this time but wasn't seen in this run.
Then the job's `saves_to` databases get its new and changed records
(optionally only some tags / above a relevance) — see save_to_databases().
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable

import findings_db as fdb
import recordstore

# Fields people or later steps own on a job record; collect() keeps them.
KEPT = ("tags", "hidden", "relevance", "relevance_why")
# Bookkeeping, not content: left out of the change fingerprint.
NOT_CONTENT = {"id", "first_seen", "last_seen", "status", "fingerprint", *KEPT}

SOURCE_COLLECTIONS = {
    "car_sources": ("c", "car_listings"),
    "comparison_sources": ("p", "comparison_listings"),
    "generic_sources": ("g", "generic_records"),
}


def store_of(project_id: str) -> str:
    return f"job:{project_id}"


def _iso(v: Any) -> str:
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return str(v) if v else ""


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v not in (None, "", [], {})}


def fingerprint(rec: dict) -> str:
    content = {k: v for k, v in rec.items() if k not in NOT_CONTENT}
    return hashlib.sha1(json.dumps(content, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


# ---- engine records → job records -------------------------------------------------

def from_finding(slug: str, f: dict) -> dict:
    return _clean({
        "id": f"v:{slug}", "engine": "careers",
        "title": f.get("title"), "company": f.get("employer"), "location": f.get("location"),
        "country": f.get("country"), "employment_type": f.get("employment_type"),
        "url": f.get("source_url"), "source": f.get("source_name"), "source_id": f.get("source_id"),
        "first_seen": _iso(f.get("first_seen_at")), "last_seen": _iso(f.get("last_seen_at")),
    })


def from_car(uid: str, c: dict) -> dict:
    attrs = c.get("attributes") or {}
    return _clean({
        "id": f"c:{uid}", "engine": "classifieds",
        "title": c.get("title"), "price": c.get("price_value"), "currency": c.get("currency"),
        "price_text": c.get("price_raw"), "location": c.get("location"),
        "year": attrs.get("year"), "mileage": attrs.get("km") or attrs.get("mileage"),
        "make": attrs.get("make"), "model": attrs.get("model"),
        "image": (c.get("images") or [None])[0], "posted": c.get("posted_at"),
        "url": c.get("url"), "source": c.get("site"), "source_id": c.get("source_id"),
        "first_seen": _iso(c.get("first_seen_at")), "last_seen": _iso(c.get("last_seen_at")),
    })


def from_shop(lid: str, p: dict) -> dict:
    return _clean({
        "id": f"p:{lid}", "engine": "shop",
        "title": p.get("name"), "brand": p.get("brand"), "price": p.get("price_value"),
        "currency": p.get("price_currency"), "shop": p.get("retailer_name"), "gtin": p.get("gtin"),
        "in_stock": p.get("in_stock"), "image": p.get("image_url"),
        "url": p.get("product_url"), "source": p.get("retailer_name"), "source_id": p.get("source_id"),
        "first_seen": _iso(p.get("first_seen_at")), "last_seen": _iso(p.get("last_seen_at")),
    })


def from_generic(uid: str, g: dict) -> dict:
    data = {k: v for k, v in (g.get("data") or {}).items() if isinstance(v, (str, int, float, bool, list))}
    title = next((str(data[k]) for k in ("title", "name", "headline") if data.get(k)), "")
    return _clean({
        **data, "id": f"g:{uid}", "engine": "generic", "title": title or data.get("title"),
        "url": g.get("url") or data.get("url"), "source": g.get("source_key"), "source_id": g.get("source_id"),
        "first_seen": _iso(g.get("first_seen_at")), "last_seen": _iso(g.get("last_seen_at")),
    })


def gather(db, project_id: str) -> list[dict]:
    """Every engine record of the job's sources, as job records."""
    out = [from_finding(d.id, d.to_dict() or {})
           for d in db.collection("projects").document(project_id).collection("findings").stream()]
    convert = {"car_listings": from_car, "comparison_listings": from_shop, "generic_records": from_generic}
    for src_col, (_, rec_col) in SOURCE_COLLECTIONS.items():
        ids = {d.id for d in db.collection(src_col).stream() if (d.to_dict() or {}).get("project_id") == project_id}
        if not ids:
            continue
        for d in db.collection(rec_col).stream():
            data = d.to_dict() or {}
            if data.get("source_id") in ids:
                out.append(convert[rec_col](d.id, data))
    return out


def collect(db, project_id: str, *, ran_sources: Iterable[str] = (), run_started: str = "") -> dict:
    """Refresh the job's store from its engines' records. `ran_sources`: ids
    of the sources that ran this time (their unseen records become "gone");
    `run_started`: ISO time the run began. Returns counts per status."""
    store = store_of(project_id)
    old = recordstore.load(store)
    ran = set(ran_sources)
    upserts: dict[str, dict] = {}
    counts = {"new": 0, "changed": 0, "unchanged": 0, "gone": 0}
    for rec in gather(db, project_id):
        prev = old.get(rec["id"])
        rec["fingerprint"] = fingerprint(rec)
        for k in KEPT:
            if prev and k in prev:
                rec[k] = prev[k]
        ran_now = rec.get("source_id") in ran
        seen_now = not run_started or rec.get("last_seen", "") >= run_started
        if ran_now and not seen_now:
            status = "gone"
        elif prev is None or prev.get("status") == "gone":
            status = "new"  # first sighting, or back after being gone
        elif prev.get("fingerprint") != rec["fingerprint"]:
            status = "changed"
        elif ran_now:
            status = "unchanged"
        else:
            # Its source didn't run (or this is a refresh, not a run): keep.
            status = prev.get("status", "unchanged")
        rec["status"] = status
        counts[status] += 1
        if prev != rec:
            upserts[rec["id"]] = rec
    if upserts:
        recordstore.write(store, upserts)
    return counts


# ---- saving into databases --------------------------------------------------------

def database_id_for(rec: dict, key: str) -> str:
    """A job record's id in a database keyed by `key` (domain / url / id)."""
    url = str(rec.get("url") or "")
    if key == "domain" and url:
        return fdb.company_id(url) or rec["id"]
    if key == "url" and url:
        return url.split("#")[0].rstrip("/")
    return rec["id"]


def save_to_databases(project: dict, project_id: str, database_keys: dict[str, str]) -> dict[str, int]:
    """Copy the job's new and changed records into each of its `saves_to`
    databases ({database, only_tags?, min_relevance?}). `database_keys`:
    database id → its key. Returns records saved per database."""
    recs = [r for r in recordstore.load(store_of(project_id)).values()
            if r.get("status") in ("new", "changed") and not r.get("hidden")]
    out: dict[str, int] = {}
    for target in project.get("saves_to") or []:
        db_id = str((target or {}).get("database") or "")
        if db_id not in database_keys:
            continue
        only = {t.casefold() for t in target.get("only_tags") or []}
        floor = target.get("min_relevance")
        items = []
        for r in recs:
            if only and not only & {t.casefold() for t in r.get("tags") or []}:
                continue
            if isinstance(floor, (int, float)) and (r.get("relevance") or 0) < floor:
                continue
            item = {k: v for k, v in r.items() if k not in ("status", "fingerprint", "hidden", "source_id")}
            item["id"] = database_id_for(r, database_keys[db_id])
            item["jobs"] = [project_id]
            items.append(item)
        if items:
            name = fdb.file_of(db_id)
            existing = fdb.load(name)
            fdb.put({it["id"]: _merge_saved(existing.get(it["id"]), it) for it in items}, name)
        out[db_id] = len(items)
    return out


def _merge_saved(prev: dict | None, new: dict) -> dict:
    """A job's newer copy wins on content; tags and the jobs that saved it
    are unioned, and people's decisions (hidden) and first_seen are kept."""
    if not prev:
        return new
    rec = {**prev, **new}
    for k in ("tags", "jobs"):
        rec[k] = list(dict.fromkeys([*(prev.get(k) or []), *(new.get(k) or [])]))
        if not rec[k]:
            rec.pop(k)
    if "hidden" in prev:
        rec["hidden"] = prev["hidden"]
    if prev.get("first_seen"):
        rec["first_seen"] = min(prev["first_seen"], new.get("first_seen") or prev["first_seen"])
    return rec


def database_keys(db) -> dict[str, str]:
    """Every database id → its key (from data/databases/<id>.json)."""
    return {d.id: str((d.to_dict() or {}).get("key") or "id") for d in db.collection("databases").stream()}


def save_records(project_id: str, database: str, ids: list[str], key: str) -> int:
    """Save chosen job records into a database now (the Results page's "Save
    to database"); same merge as the automatic saving."""
    recs = recordstore.load(store_of(project_id))
    items = []
    for i in dict.fromkeys(ids):
        r = recs.get(i)
        if not r:
            continue
        item = {k: v for k, v in r.items() if k not in ("status", "fingerprint", "hidden", "source_id")}
        item["id"] = database_id_for(r, key)
        item["jobs"] = [project_id]
        items.append(item)
    if items:
        name = fdb.file_of(database)
        existing = fdb.load(name)
        fdb.put({it["id"]: _merge_saved(existing.get(it["id"]), it) for it in items}, name)
    return len(items)


def main(argv: list[str] | None = None) -> int:
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="A job's results store.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--collect", action="store_true",
                   help='refresh from the engines\' records: read {"project": "<id>"} on stdin')
    g.add_argument("--save", action="store_true",
                   help='save records into a database: read {"project", "database", "ids"} on stdin')
    args = ap.parse_args(argv)
    req = json.loads(sys.stdin.read() or "{}")
    project_id = str(req.get("project") or "")
    try:
        from scrape import collect_job, get_db

        db = get_db()
        if args.collect:
            out: dict = collect_job(db, project_id)
        else:
            database = str(req.get("database") or "")
            keys = database_keys(db)
            if database not in keys:
                raise ValueError(f"no database {database!r}")
            out = {"saved": save_records(project_id, database, [str(i) for i in req.get("ids") or []],
                                         keys[database])}
    except ValueError as e:
        out = {"error": str(e)}
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
