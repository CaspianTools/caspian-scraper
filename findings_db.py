"""The findings database — everything "Find websites" has discovered, kept in
the repo so it grows with every search and travels with every pull.

    db/companies.jsonl   one company per line, sorted by id   (committed)
    db/people.jsonl      reserved for people                   (committed)

It is the "companies" database (data/databases/companies.json): the working
copy lives in the SQLite record store (recordstore.py, local-data/scraper.db)
and every write is exported to the JSON Lines file, which is what git shares —
several computers add to it, and git merges line-based text cleanly (two
searches adding different companies don't conflict; the same company edited
on both sides conflicts on that one line only). After a pull, the store
re-imports the file. Other databases use the same functions with their own
file (`name="<database-id>.jsonl"`).

A company record (missing fields are simply absent):

    id            the website's domain ("adnoc.ae") — the merge key
    name, website, description
    name_raw      what the source called it, when the name was cleaned
                  ("CLEVEREST ACADEMY | Xaricə Təhsil" → name "Cleverest Academy")
    website_raw   the address found, when it pointed below the home page
                  (website is the site's root: "https://acme.com/")
    branches      where the company is: [{country, city?, address?, website?,
                  source?}], one per country at least; a local site
                  (acme.com.eg) is that branch's website
    aliases       ids of duplicate records merged into this one; a later find
                  of an alias lands here
    careers_url   the page listing its jobs, once found
    ats           careers platform: "successfactors" | "jibe" | "unknown"
    reachable     whether careers_url opened at the last check
    checked_at    when careers_url / ats were last checked (ISO time)
    countries, industries, types        lists (union-merged)
    sources       where it was found: "wikidata" | "osm" | "web"
    wikidata_id, osm_id
    found_by      search phrases that turned it up (latest 20)
    first_seen, last_seen               ISO times
    hidden        true when someone marked it "not relevant" in the app
    tags          labels people gave it in the app ("priority", "called")

Merging only ever adds: lists are unioned, empty fields filled, and the
careers check fields replaced by a newer check. New information is
normalised on the way in (normalize.py): names cleaned, categories given one
spelling, websites cut to the site root — and an http site becomes https
when a source gives the same site as https. The one exception is
`hidden`, a person's decision, which the latest value always replaces.
Tags are people's decisions too, but they're set through retag() — add and
remove — so a plain merge only ever unions them.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import normalize
import recordstore

REPO_ROOT = Path(__file__).resolve().parent
DB_DIR = Path(os.environ.get("CASPIAN_FINDINGS_DB") or REPO_ROOT / "db")
COMPANIES_FILE = "companies.jsonl"

LIST_FIELDS = ("countries", "industries", "types", "sources", "tags")
CATEGORY_FIELDS = ("types", "industries")
# Lists that ignore case when unioned ("University" = "university").
_CASELESS_LISTS = (*CATEGORY_FIELDS, "tags")
# Branch details an item may carry: they go into its branch, not the record.
BRANCH_FIELDS = ("city", "address")
BRANCH_KEYS = ("country", "city", "address", "website", "source")
CHECK_FIELDS = ("careers_url", "ats", "reachable", "checked_at")
# Decisions people make in the app: the newest value wins, even false.
OVERRIDE_FIELDS = ("hidden",)
FOUND_BY_KEEP = 20
TAG_MAX = 40

# Careers sub-sites belong to the company's own domain: careers.adnoc.ae → adnoc.ae.
_CAREERS_LABEL = {"careers", "career", "jobs", "job", "recruitment", "talent", "apply", "join", "hr"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def company_id(url: str) -> str:
    """'https://www.careers.acme.co.uk/x' → 'acme.co.uk' (lowercase domain)."""
    host = (urlparse(url if "//" in url else "https://" + url).hostname or "").lower()
    labels = [x for x in host.split(".") if x]
    while labels and labels[0] in ("www", "www2", "m"):
        labels.pop(0)
    if len(labels) > 2 and labels[0] in _CAREERS_LABEL:
        labels.pop(0)
    return ".".join(labels)


def _path(name: str) -> Path:
    return DB_DIR / name


DATABASE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
JOB_STORE = re.compile(r"^job:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def file_of(database: str | None) -> str:
    """A database id's file name ("companies" → "companies.jsonl"), or a
    job's results store as is ("job:<id>", no file); rejects anything else."""
    db = (database or "companies").strip()
    if JOB_STORE.match(db):
        return db
    if not DATABASE_ID.match(db):
        raise ValueError(f"not a database id: {db!r}")
    return f"{db}.jsonl"


def store_of(name: str) -> str:
    """The record-store name: "companies.jsonl" → "db:companies"; a job
    store ("job:<id>") is its own name."""
    return name if name.startswith("job:") else "db:" + name.removesuffix(".jsonl")


def _file(name: str) -> Path | None:
    """The committed file of a database; job stores have none."""
    return None if name.startswith("job:") else _path(name)


def load(name: str = COMPANIES_FILE) -> dict[str, dict]:
    return recordstore.load(store_of(name), _file(name))


def save(records: dict[str, dict], name: str = COMPANIES_FILE) -> None:
    """Make the database exactly `records` (and export it)."""
    recordstore.write(store_of(name), records, file=_file(name), replace=True)


def put(records: dict[str, dict], name: str = COMPANIES_FILE, deletes: list[str] = ()) -> None:
    """Write just these records (and deletions), then export."""
    recordstore.write(store_of(name), records, deletes, file=_file(name))


def normalize_record(rec: dict, spelling: dict[str, str] | None = None) -> dict:
    """A copy of a record with its name, categories and website normalised
    (see normalize.py): the original name kept as name_raw and an address
    with a path as website_raw (each only if none is kept yet). Idempotent."""
    out = dict(rec)
    domain = str(rec.get("id") or company_id(str(rec.get("website") or "")))
    name = rec.get("name")
    if isinstance(name, str) and name:
        clean, changed = normalize.clean_name(name, domain)
        if changed and clean:
            out["name"] = clean
            out.setdefault("name_raw", name)
    for k in CATEGORY_FIELDS:
        if isinstance(rec.get(k), list):
            out[k] = normalize.clean_categories(rec[k], spelling)
    site = rec.get("website")
    if isinstance(site, str) and site.strip():
        root = normalize.site_root(site)
        if root and root != site:
            out["website"] = root
            if normalize.has_path(site):
                out.setdefault("website_raw", site.strip())
    return out


def category_spelling(records: dict[str, dict]) -> dict[str, str]:
    """The spelling most records use for each category (case-insensitive)."""
    return normalize.category_spellings(
        c for r in records.values() for k in CATEGORY_FIELDS for c in r.get(k) or [] if isinstance(c, str))


def _f(x) -> str:
    return normalize.fold(str(x or ""))


def _branch_compatible(a: dict, b: dict) -> bool:
    """Same country, and no detail that differs (a missing one is fine)."""
    if _f(a.get("country")) != _f(b.get("country")):
        return False
    for k in ("city", "address"):
        if a.get(k) and b.get(k) and _f(a[k]) != _f(b[k]):
            return False
    wa, wb = a.get("website"), b.get("website")
    return not (wa and wb and normalize.site_host(wa) != normalize.site_host(wb))


def _add_branch(branches: list[dict], b: dict) -> None:
    """Add a branch, or fill in the one it matches."""
    for e in branches:
        if _branch_compatible(e, b):
            for k in BRANCH_KEYS:
                if b.get(k) and not e.get(k):
                    e[k] = b[k]
            return
    branches.append({k: b[k] for k in BRANCH_KEYS if b.get(k)})


def _covered(branches: list[dict], country: str) -> bool:
    return any(_f(b.get("country")) == _f(country) for b in branches)


def with_branches(rec: dict) -> list[dict]:
    """A record's branches, plus one for each of its countries none covers."""
    out = [dict(b) for b in rec.get("branches") or [] if isinstance(b, dict) and b.get("country")]
    for c in rec.get("countries") or []:
        if c and not _covered(out, c):
            out.append({"country": c})
    return out


def _incoming_branches(new: dict, rec: dict) -> list[dict]:
    """The branches a new item tells of: its own, one per other country (with
    the item's city / address when it names one country), each with the
    item's website when that is another domain than the record's."""
    out = [dict(b) for b in new.get("branches") or [] if isinstance(b, dict) and b.get("country")]
    countries = [c for c in new.get("countries") or [] if c]
    one = len(countries) == 1
    source = next(iter(new.get("sources") or []), "")
    for c in countries:
        if not _covered(out, c):
            out.append({"country": c, "city": new.get("city") if one else "",
                        "address": new.get("address") if one else "", "source": source})
    site = new.get("website")
    home = rec.get("id") or company_id(str(rec.get("website") or ""))
    if site and home and company_id(site) != home:
        for b in out:
            b.setdefault("website", site)
    return out


def merge(old: dict | None, new: dict, spelling: dict[str, str] | None = None) -> dict:
    """Combine two records for the same company; only ever adds information.
    `new` is normalised first (normalize_record); `spelling` is the category
    spelling to follow (category_spelling() of the database). An item's
    countries (and city / address) become branches."""
    new = normalize_record(new, spelling)
    rec = dict(old or {})
    branches = with_branches(rec)
    for k, v in new.items():
        if v in (None, "", []) or k in ("branches", "name_raw", "website_raw", *BRANCH_FIELDS):
            continue
        if k in OVERRIDE_FIELDS:
            rec[k] = v
        elif k in _CASELESS_LISTS:
            have = {str(x).casefold() for x in rec.get(k) or []}
            rec[k] = [*(rec.get(k) or [])]
            for x in v:
                if str(x).casefold() not in have:
                    have.add(str(x).casefold())
                    rec[k].append(x)
        elif k in LIST_FIELDS:
            rec[k] = list(dict.fromkeys([*(rec.get(k) or []), *v]))
        elif k == "found_by":
            rec[k] = list(dict.fromkeys([*v, *(rec.get(k) or [])]))[:FOUND_BY_KEEP]
        elif k in CHECK_FIELDS:
            # A newer careers check replaces the older one as a whole.
            if new.get("checked_at") and new["checked_at"] >= rec.get("checked_at", ""):
                rec[k] = v
            elif k not in rec:
                rec[k] = v
        elif k in ("first_seen",):
            rec[k] = min(rec.get(k) or v, v)
        elif k == "last_seen":
            rec[k] = max(rec.get(k) or v, v)
        elif k == "name":
            if not rec.get("name"):
                rec["name"] = v
                if new.get("name_raw") and not rec.get("name_raw"):
                    rec["name_raw"] = new["name_raw"]
        elif k == "website":
            have = rec.get("website")
            if not have:
                rec["website"] = v
                if new.get("website_raw") and not rec.get("website_raw"):
                    rec["website_raw"] = new["website_raw"]
            elif (str(have).startswith("http://") and str(v).startswith("https://")
                  and normalize.site_host(have) == normalize.site_host(v)):
                # The same site, found as https: take the safer address.
                if normalize.has_path(have):
                    rec.setdefault("website_raw", have)
                rec["website"] = "https://" + normalize.site_root(have).split("://", 1)[1]
        elif not rec.get(k):
            rec[k] = v
    for b in _incoming_branches(new, rec):
        _add_branch(branches, b)
    branches = with_branches({"branches": branches, "countries": rec.get("countries")})
    if branches:
        rec["branches"] = branches
    if not old:
        rec.setdefault("first_seen", now_iso())
        rec["last_seen"] = rec.get("last_seen") or now_iso()
    return rec


def alias_map(records: dict[str, dict]) -> dict[str, str]:
    """Merged-away id → the id of the record it was merged into."""
    return {str(a): rid for rid, r in records.items() for a in r.get("aliases") or [] if a != rid}


def upsert(items: list[dict], name: str = COMPANIES_FILE) -> dict[str, dict]:
    """Merge `items` (each with an "id") into the file; returns the merged
    records for those ids. An item whose id was merged into another record
    (an alias, see merge_duplicates) lands on that record and is returned
    under both ids."""
    records = load(name)
    aliases = alias_map(records)
    spelling = category_spelling(records)
    touched: dict[str, dict] = {}
    out: dict[str, dict] = {}
    for item in items:
        cid = item.get("id")
        if not cid:
            continue
        target = cid if cid in records else aliases.get(cid, cid)
        records[target] = merge(records.get(target), {**item, "id": target}, spelling)
        touched[target] = records[target]
        out[cid] = out[target] = records[target]
    if touched:
        put(touched, name)
    return out


# ---- duplicates ---------------------------------------------------------------------

def _keep_order(rid: str) -> tuple:
    """Which of several duplicates to keep: the shorter, more generic domain
    (globalknowledge.com over globalknowledge.com.eg)."""
    return (len(rid.split(".")), len(rid), rid)


def merge_into(kept: dict, other: dict, spelling: dict[str, str] | None = None) -> dict:
    """`other` (a duplicate) merged into `kept`: its countries become branches
    with its website, lists are unioned, empty fields filled; kept's careers
    check stays if it has one; hidden only if both were hidden; other's id
    (and its aliases) recorded as aliases."""
    item = {k: v for k, v in other.items() if k not in ("id", "hidden", "aliases", "name_raw", "website_raw")}
    item["branches"] = with_branches(other)
    if kept.get("checked_at"):
        item = {k: v for k, v in item.items() if k not in CHECK_FIELDS}
    rec = merge(kept, item, spelling)
    rec["id"] = kept["id"]
    if "hidden" in kept or "hidden" in other:
        rec["hidden"] = kept.get("hidden") is True and other.get("hidden") is True
    al = [*(kept.get("aliases") or []), other["id"], *(other.get("aliases") or [])]
    rec["aliases"] = [a for a in dict.fromkeys(al) if a != kept["id"]]
    return rec


def plan_duplicates(records: dict[str, dict]) -> tuple[list[tuple[str, str]], dict[str, dict], list[str]]:
    """Find duplicate companies (normalize.same_company, or a record whose id
    another lists as an alias) and merge each group into one record.
    Returns ([(kept_id, merged_id)], records to write, ids to delete); writes
    nothing."""
    parent = {rid: rid for rid in records}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    aliases = alias_map(records)
    for alias, owner in aliases.items():
        if alias in records and owner in records:
            union(alias, owner)
    # Only records sharing a name key or a host can match: compare within those.
    buckets: dict[tuple, list[str]] = {}
    for rid, r in records.items():
        core = normalize.core_name(normalize.clean_name(str(r.get("name") or ""), rid)[0])
        if core:
            buckets.setdefault(("name", core), []).append(rid)
        host = normalize.site_host(str(r.get("website") or ""))
        if host:
            buckets.setdefault(("host", host), []).append(rid)
    for ids in buckets.values():
        ids.sort()
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if find(a) != find(b) and normalize.same_company(records[a], records[b]):
                    union(a, b)

    groups: dict[str, list[str]] = {}
    for rid in sorted(records):
        groups.setdefault(find(rid), []).append(rid)
    owners = set(aliases.values())
    spelling = category_spelling(records)
    pairs: list[tuple[str, str]] = []
    upserts: dict[str, dict] = {}
    deletes: list[str] = []
    for ids in groups.values():
        if len(ids) < 2:
            continue
        # A record others were already merged into stays the one kept.
        kept = min(ids, key=lambda i: (i not in owners, *_keep_order(i)))
        rec = records[kept]
        for other in sorted(i for i in ids if i != kept):
            rec = merge_into(rec, records[other], spelling)
            pairs.append((kept, other))
            deletes.append(other)
        upserts[kept] = rec
    pairs.sort()
    return pairs, upserts, deletes


def merge_duplicates(name: str = COMPANIES_FILE) -> list[tuple[str, str]]:
    """Merge duplicate companies in the database into one record each (see
    plan_duplicates); returns the (kept_id, merged_id) pairs."""
    pairs, upserts, deletes = plan_duplicates(load(name))
    if pairs:
        put(upserts, name, deletes=deletes)
    return pairs


def clean_tag(tag: str) -> str:
    """'  Call   back ' → 'Call back' (trimmed, single spaces, at most TAG_MAX)."""
    return " ".join(str(tag).split())[:TAG_MAX].strip()


def retag(ids: list[str], add: list[str] = (), remove: list[str] = (),
          name: str = COMPANIES_FILE) -> dict[str, list[str]]:
    """Add and remove tags on the given companies (ids not in the file are
    skipped). Tags match case-insensitively, and a new tag takes the spelling
    already used elsewhere in the file, so "priority" and "Priority" stay one
    tag. Returns each updated company's tags, sorted."""
    return retag_each({cid: (add, remove) for cid in ids}, name)


def retag_each(changes: dict[str, tuple[list[str], list[str]]],
               name: str = COMPANIES_FILE) -> dict[str, list[str]]:
    """retag() with different tags per company — {id: (add, remove)} — in one
    load and save (AI tagging gives every company its own)."""
    records = load(name)
    spelling: dict[str, str] = {}
    for rec in records.values():
        for t in rec.get("tags") or []:
            spelling.setdefault(t.casefold(), t)
    out: dict[str, list[str]] = {}
    for cid, (add, remove) in changes.items():
        rec = records.get(cid)
        if rec is None:
            continue
        drop = {clean_tag(t).casefold() for t in remove}
        tags = {t.casefold(): t for t in rec.get("tags") or [] if t.casefold() not in drop}
        for t in map(clean_tag, add):
            if t:
                tags.setdefault(t.casefold(), spelling.setdefault(t.casefold(), t))
        new = sorted(tags.values(), key=str.casefold)
        if new:
            rec["tags"] = new
        else:
            rec.pop("tags", None)
        out[cid] = new
    if out:
        put({cid: records[cid] for cid in out}, name)
    return out
