#!/usr/bin/env python3
"""
export_dashboard.py — regenerate docs/data.json from Firestore.

The static dashboard in docs/ reads ./data.json. The live multi-tenant
scraper (scrape.py) writes results to Firestore, not to docs/data.json, so
this script rebuilds that aggregate from the Firestore project named by
PUBLIC_PROJECT_ID and writes docs/data.json in the exact shape the dashboard
consumes (see docs/dashboard.js).

It is intentionally standalone: it re-implements the ~15-line Firestore client
init from scrape.py:get_db() so it doesn't drag in the scraper's Playwright
import chain just to do read-only queries.

Env:
  GOOGLE_APPLICATION_CREDENTIALS_JSON  service-account JSON (same secret as the scraper)
  FIRESTORE_DATABASE_ID                named DB, e.g. "scraper"
  PUBLIC_PROJECT_ID                    Firestore projects/{id} doc id to publish

Run:  python export_dashboard.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1 import FieldFilter
from google.oauth2 import service_account

SCHEMA_VERSION = 1
SCRAPER_REPO = "CaspianTools/caspian-scraper"
RUNS_WINDOW = 50          # most-recent finished runs kept for the trend chart
RECENT_PUBLISHED = 50     # most-recent published roles listed

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(HERE, "docs", "data.json")


def get_db() -> Any:
    """Firestore client from GOOGLE_APPLICATION_CREDENTIALS_JSON, bound to
    FIRESTORE_DATABASE_ID when set. Mirrors scrape.py:get_db()."""
    sa_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON", "").strip()
    if not sa_json:
        raise SystemExit("GOOGLE_APPLICATION_CREDENTIALS_JSON env var is not set")
    try:
        sa_dict = json.loads(sa_json)
    except json.JSONDecodeError as e:
        raise SystemExit(
            f"GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: {e}"
        )
    creds = service_account.Credentials.from_service_account_info(sa_dict)
    kwargs: dict[str, Any] = {
        "project": sa_dict.get("project_id", ""),
        "credentials": creds,
    }
    db_id = os.environ.get("FIRESTORE_DATABASE_ID", "").strip()
    if db_id:
        kwargs["database"] = db_id
    return firestore.Client(**kwargs)


def iso(ts: Any) -> str | None:
    """Firestore timestamp/datetime -> 'YYYY-MM-DDTHH:MM:SSZ', else None."""
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return (
            ts.astimezone(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )
    return str(ts)  # unexpected type — stringify so the UI shows something


def _num(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def load_employers(proj) -> list[dict]:
    """docs/data.json employers[] from /sources. url == careers_url so it
    matches the by_employer[] join key (name|url) the dashboard builds."""
    out: list[dict] = []
    for d in proj.collection("sources").stream():
        s = d.to_dict() or {}
        out.append({
            "name": s.get("name") or d.id,
            "ats": s.get("ats") or "",
            "active": bool(s.get("active", True)),
            "url": s.get("careers_url") or "",
        })
    out.sort(key=lambda e: (not e["active"], (e["name"] or "").lower()))
    return out


def load_runs(proj) -> tuple[list[dict], str | None]:
    """Most-recent finished runs, oldest-first (the dashboard treats the last
    element as the newest run). Returns (runs, last_run_id)."""
    q = (
        proj.collection("runs")
        .order_by("started_at", direction=firestore.Query.DESCENDING)
        .limit(RUNS_WINDOW * 2)  # headroom for skipped in-progress runs
    )
    finished: list[tuple[str, dict]] = []
    for d in q.stream():
        r = d.to_dict() or {}
        if r.get("finished_at") is None:
            continue  # skip an in-progress run so the hero isn't half-empty
        t = r.get("totals") or {}
        finished.append((d.id, {
            "started_at": iso(r.get("started_at")),
            "finished_at": iso(r.get("finished_at")),
            "duration_seconds": _num(r.get("duration_seconds")),
            "status": r.get("status") or "ok",
            "found": _num(t.get("found")),
            "published": _num(t.get("published")),
            "skipped_duplicate": _num(t.get("skipped_duplicate")),
            "skipped_inactive": 0,  # not tracked per-run in Firestore
            "errors": list(r.get("errors") or []),
            "by_employer": [],      # filled for the last run only (below)
        }))
        if len(finished) >= RUNS_WINDOW:
            break
    finished.reverse()  # fetched newest-first; dashboard wants newest last
    last_id = finished[-1][0] if finished else None
    return [r for _, r in finished], last_id


def load_by_employer(proj, run_id: str) -> list[dict]:
    """Per-employer breakdown for one run, from /lessons (join on run_id).
    Only the newest run's breakdown is read by the dashboard."""
    q = proj.collection("lessons").where(
        filter=FieldFilter("run_id", "==", run_id)
    )
    out: list[dict] = []
    for d in q.stream():
        l = d.to_dict() or {}
        out.append({
            "name": l.get("source_name") or "",
            "url": l.get("careers_url") or "",
            "found": _num(l.get("found")),
            "published": _num(l.get("published")),
            "skipped_duplicate": _num(l.get("skipped_duplicate")),
            "errors": list(l.get("errors") or []),
        })
    return out


def load_recent_published(proj) -> list[dict]:
    """recent_published[] from /findings. Ordering by published_at naturally
    excludes never-published findings (they have no published_at). Emitted
    oldest-first because the dashboard reverses the list before display."""
    q = (
        proj.collection("findings")
        .order_by("published_at", direction=firestore.Query.DESCENDING)
        .limit(RECENT_PUBLISHED)
    )
    items: list[dict] = []
    for d in q.stream():
        f = d.to_dict() or {}
        if (f.get("status") or "") != "published":
            continue
        items.append({
            "ts": iso(f.get("published_at")),
            "title": f.get("title") or "",
            "employer": f.get("employer") or "",
            "location": f.get("location") or "",
            "country": f.get("country") or "",
            "employment_type": f.get("employment_type") or "",
            # destination_slug is the id the destination actually stored;
            # fall back to the finding doc id (our generated slug).
            "slug": f.get("destination_slug") or d.id,
            "url": f.get("source_url") or "",
        })
    items.reverse()
    return items


def load_totals(proj) -> dict:
    """All-time rollup over every /runs doc. Uses server-side aggregation
    (cheap as the collection grows); falls back to streaming if the client
    or backend doesn't support aggregation queries."""
    runs_col = proj.collection("runs")
    try:
        aq = runs_col.count(alias="runs")
        aq.sum("totals.found", alias="found")
        aq.sum("totals.published", alias="published")
        aq.sum("totals.errors_count", alias="errors")
        rows = aq.get()
        m = {r.alias: r.value for r in (rows[0] if rows else [])}
        return {
            "runs": _num(m.get("runs")),
            "found_alltime": _num(m.get("found")),
            "published_alltime": _num(m.get("published")),
            "errors_alltime": _num(m.get("errors")),
        }
    except Exception as e:  # pragma: no cover - env/version dependent
        print(
            f"aggregation unavailable ({type(e).__name__}: {e}); "
            "streaming /runs instead",
            file=sys.stderr,
        )
        runs = found = pub = err = 0
        for d in runs_col.select(["totals"]).stream():
            t = (d.to_dict() or {}).get("totals") or {}
            runs += 1
            found += _num(t.get("found"))
            pub += _num(t.get("published"))
            err += _num(t.get("errors_count"))
        return {
            "runs": runs,
            "found_alltime": found,
            "published_alltime": pub,
            "errors_alltime": err,
        }


def build(proj) -> dict:
    employers = load_employers(proj)
    runs, last_run_id = load_runs(proj)
    if last_run_id and runs:
        runs[-1]["by_employer"] = load_by_employer(proj, last_run_id)
    return {
        "schema_version": SCHEMA_VERSION,
        "scraper_repo": SCRAPER_REPO,
        "last_updated": iso(datetime.now(timezone.utc)),
        "employers": employers,
        "totals": load_totals(proj),
        "runs": runs,
        "recent_published": load_recent_published(proj),
    }


def main() -> int:
    project_id = (os.environ.get("PUBLIC_PROJECT_ID") or "").strip()
    if not project_id:
        raise SystemExit(
            "PUBLIC_PROJECT_ID env var is not set — point it at the Firestore "
            "projects/{id} doc whose data should feed the public dashboard."
        )

    db = get_db()
    proj = db.collection("projects").document(project_id)
    if not proj.get().exists:
        raise SystemExit(f"projects/{project_id} does not exist in Firestore")

    data = build(proj)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(json.dumps({
        "wrote": os.path.relpath(OUT_PATH, HERE),
        "project_id": project_id,
        "employers": len(data["employers"]),
        "runs": len(data["runs"]),
        "recent_published": len(data["recent_published"]),
        "totals": data["totals"],
        "last_updated": data["last_updated"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
