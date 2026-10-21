"""The findings database — everything "Find websites" has discovered, kept in
the repo so it grows with every search and travels with every pull.

    db/companies.jsonl   one company per line, sorted by id   (committed)
    db/people.jsonl      reserved for people                   (committed)

Plain JSON Lines, not a binary database, on purpose: several computers add to
it, and git merges line-based text cleanly (two searches adding different
companies don't conflict; the same company edited on both sides conflicts on
that one line only).

A company record (missing fields are simply absent):

    id            the website's domain ("adnoc.ae") — the merge key
    name, website, description
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
careers check fields replaced by a newer check. The one exception is
`hidden`, a person's decision, which the latest value always replaces.
Tags are people's decisions too, but they're set through retag() — add and
remove — so a plain merge only ever unions them.
"""

from __future__ import annotations

import json
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parent
DB_DIR = Path(os.environ.get("CASPIAN_FINDINGS_DB") or REPO_ROOT / "db")
COMPANIES_FILE = "companies.jsonl"

LIST_FIELDS = ("countries", "industries", "types", "sources", "tags")
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


def load(name: str = COMPANIES_FILE) -> dict[str, dict]:
    out: dict[str, dict] = {}
    p = _path(name)
    if not p.exists():
        return out
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue  # a half-merged line shouldn't sink the whole file
        if rec.get("id"):
            out[rec["id"]] = rec
    return out


def save(records: dict[str, dict], name: str = COMPANIES_FILE) -> None:
    p = _path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.{secrets.token_hex(4)}.tmp")
    lines = [json.dumps(records[k], ensure_ascii=False, sort_keys=True) for k in sorted(records)]
    # newline="\n": LF on every OS, matching .gitattributes (no CRLF churn).
    tmp.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8", newline="\n")
    os.replace(tmp, p)


def merge(old: dict | None, new: dict) -> dict:
    """Combine two records for the same company; only ever adds information."""
    if not old:
        rec = {k: v for k, v in new.items() if v not in (None, "", [])}
        rec.setdefault("first_seen", now_iso())
        rec["last_seen"] = rec.get("last_seen") or now_iso()
        return rec
    rec = dict(old)
    for k, v in new.items():
        if v in (None, "", []):
            continue
        if k in OVERRIDE_FIELDS:
            rec[k] = v
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
        elif not rec.get(k):
            rec[k] = v
    return rec


def upsert(items: list[dict], name: str = COMPANIES_FILE) -> dict[str, dict]:
    """Merge `items` (each with an "id") into the file; returns the merged
    records for those ids."""
    records = load(name)
    touched = {}
    for item in items:
        cid = item.get("id")
        if not cid:
            continue
        records[cid] = merge(records.get(cid), item)
        touched[cid] = records[cid]
    if touched:
        save(records, name)
    return touched


def clean_tag(tag: str) -> str:
    """'  Call   back ' → 'Call back' (trimmed, single spaces, at most TAG_MAX)."""
    return " ".join(str(tag).split())[:TAG_MAX].strip()


def retag(ids: list[str], add: list[str] = (), remove: list[str] = (),
          name: str = COMPANIES_FILE) -> dict[str, list[str]]:
    """Add and remove tags on the given companies (ids not in the file are
    skipped). Tags match case-insensitively, and a new tag takes the spelling
    already used elsewhere in the file, so "priority" and "Priority" stay one
    tag. Returns each updated company's tags, sorted."""
    records = load(name)
    spelling: dict[str, str] = {}
    for rec in records.values():
        for t in rec.get("tags") or []:
            spelling.setdefault(t.casefold(), t)
    adds = []
    for t in map(clean_tag, add):
        if t:
            adds.append(spelling.setdefault(t.casefold(), t))
    drop = {clean_tag(t).casefold() for t in remove}
    out: dict[str, list[str]] = {}
    for cid in dict.fromkeys(ids):
        rec = records.get(cid)
        if rec is None:
            continue
        tags = {t.casefold(): t for t in rec.get("tags") or [] if t.casefold() not in drop}
        for t in adds:
            tags.setdefault(t.casefold(), t)
        new = sorted(tags.values(), key=str.casefold)
        if new:
            rec["tags"] = new
        else:
            rec.pop("tags", None)
        out[cid] = new
    if out:
        save(records, name)
    return out
