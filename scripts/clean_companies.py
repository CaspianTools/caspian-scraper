#!/usr/bin/env python3
"""Tidy the Companies database (db/companies.jsonl): the "Data quality" step.

  1. Normalise every record (normalize.py via findings_db.normalize_record):
     names cut from page titles / ALL CAPS fixed (the original kept as
     name_raw), categories given one spelling, websites cut to the site root
     (an address with a path kept as website_raw), and a branch for every
     country.
  2. Merge duplicate companies (findings_db.merge_duplicates): one record per
     company, the other domains become branches and `aliases`, so a later
     search that finds them again lands on the kept record.

Idempotent: a second run changes nothing. Writes go through findings_db
(SQLite working copy + the JSONL export), never to the file directly.

Usage:
  python scripts/clean_companies.py --dry-run     # print what would change
  python scripts/clean_companies.py

To try it on a copy, point both stores elsewhere first:
  CASPIAN_FINDINGS_DB=<dir with a copy of companies.jsonl> CASPIAN_LOCAL_DIR=<tmp dir> \\
      python scripts/clean_companies.py --dry-run
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import findings_db as fdb  # noqa: E402
import normalize  # noqa: E402


def normalised(records: dict[str, dict]) -> tuple[dict[str, dict], dict]:
    """Every record normalised; returns (changed records by id, counts)."""
    spelling = fdb.category_spelling(records)
    labels_before = {c for r in records.values() for k in fdb.CATEGORY_FIELDS for c in r.get(k) or []}
    changed: dict[str, dict] = {}
    stats = {"names": [], "categories": 0, "websites_path": 0, "websites_format": 0, "branches": 0}
    for rid in sorted(records):
        old = records[rid]
        new = fdb.normalize_record(old, spelling)
        branches = fdb.with_branches(new)
        if branches:
            new["branches"] = branches
        if new == old:
            continue
        changed[rid] = new
        if new.get("name") != old.get("name"):
            stats["names"].append((rid, old.get("name"), new.get("name")))
        if any(new.get(k) != old.get(k) for k in fdb.CATEGORY_FIELDS):
            stats["categories"] += 1
        if new.get("website") != old.get("website"):
            stats["websites_path" if normalize.has_path(old.get("website") or "") else "websites_format"] += 1
        if new.get("branches") != old.get("branches"):
            stats["branches"] += 1
    after = {**records, **changed}
    labels_after = {c for r in after.values() for k in fdb.CATEGORY_FIELDS for c in r.get(k) or []}
    stats["labels"] = (len(labels_before), len(labels_after))
    return changed, stats


def possible_duplicates(records: dict[str, dict]) -> list[tuple[str, str, str]]:
    """Same name, but domains that don't match: left for a person to decide."""
    by_name: dict[str, list[str]] = {}
    for rid, r in records.items():
        core = normalize.core_name(r.get("name") or "")
        if len(core.replace(" ", "")) >= 4:
            by_name.setdefault(core, []).append(rid)
    out = []
    for ids in by_name.values():
        ids.sort()
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if not normalize.same_company(records[a], records[b]):
                    out.append((a, b, records[a].get("name", "")))
    return sorted(out)


WIKIDATA_ONLY_TAG = "Wikidata only"


def wikidata_only(records: dict[str, dict]) -> dict[str, dict]:
    """Companies only Wikidata knew of (Find websites no longer adds those —
    Wikidata only adds details now): hidden and tagged, not deleted, so
    "Show hidden" + the tag brings them back."""
    out = {}
    for rid, rec in records.items():
        if set(rec.get("sources") or []) == {"wikidata"} and not rec.get("hidden"):
            tags = list(dict.fromkeys([*(rec.get("tags") or []), WIKIDATA_ONLY_TAG]))
            out[rid] = {**rec, "hidden": True, "tags": sorted(tags, key=str.casefold)}
    return out


def run(dry_run: bool = False, name: str = fdb.COMPANIES_FILE, hide_wikidata_only: bool = False) -> dict:
    """Clean the database (or, dry_run, only work out what would change)."""
    records = fdb.load(name)
    changed, stats = normalised(records)
    hidden = wikidata_only({**records, **changed}) if hide_wikidata_only else {}
    stats["wikidata_hidden"] = len(hidden)
    changed = {**changed, **hidden}
    if changed and not dry_run:
        fdb.put(changed, name)
    after = {**records, **changed}
    if dry_run:
        pairs, upserts, deletes = fdb.plan_duplicates(after)
        after = {k: v for k, v in {**after, **upserts}.items() if k not in set(deletes)}
    else:
        pairs = fdb.merge_duplicates(name)
        after = fdb.load(name)
    return {**stats, "records": len(records), "changed": len(changed), "pairs": pairs,
            "after": len(after), "possible": possible_duplicates(after)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Normalise the Companies database and merge duplicates.")
    ap.add_argument("--dry-run", action="store_true", help="print what would change, write nothing")
    ap.add_argument("--verbose", "-v", action="store_true", help="list every name change")
    ap.add_argument("--hide-wikidata-only", action="store_true",
                    help=f'hide companies only Wikidata knew of, tagged "{WIKIDATA_ONLY_TAG}"')
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    s = run(dry_run=args.dry_run, hide_wikidata_only=args.hide_wikidata_only)
    head = "DRY RUN — nothing written" if args.dry_run else "Done"
    print(f"{head}: {fdb.DB_DIR / fdb.COMPANIES_FILE}")
    print(f"  records:               {s['records']} → {s['after']}  ({s['changed']} normalised)")
    print(f"  names cleaned:         {len(s['names'])}")
    for rid, old, new in s["names"] if args.verbose else s["names"][:15]:
        print(f"      {old!r} → {new!r}   [{rid}]")
    if not args.verbose and len(s["names"]) > 15:
        print(f"      … {len(s['names']) - 15} more (--verbose lists them all)")
    print(f"  categories unified:    {s['categories']} records "
          f"({s['labels'][0]} → {s['labels'][1]} distinct labels)")
    print(f"  websites rooted:       {s['websites_path']} had a path (kept as website_raw), "
          f"{s['websites_format']} only case / slash / port")
    print(f"  branches added:        {s['branches']} records")
    if args.hide_wikidata_only:
        print(f"  Wikidata-only hidden:  {s['wikidata_hidden']} (tagged \"{WIKIDATA_ONLY_TAG}\")")
    print(f"  duplicates merged:     {len(s['pairs'])}")
    for kept, merged in s["pairs"]:
        print(f"      {merged} → {kept}")
    if s["possible"]:
        print(f"  same name, other domain (not merged — check by hand): {len(s['possible'])}")
        for a, b, n in s["possible"]:
            print(f"      {a} / {b}   {n!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
