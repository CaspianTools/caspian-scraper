#!/usr/bin/env python3
"""One-shot backfill: re-sanitize description on every existing vacancy.

When the chrome-scrubber in ``scrape.py`` was added, vacancies already in
Firestore kept their polluted descriptions until they happened to be
re-scraped. This script reads each vacancy via the entirelysafe API,
runs the current ``sanitize_description`` + ``_strip_leading_title_dupe``
pipeline over its description, and PUTs the cleaned version back.

Idempotent: a second run is a no-op once everything's clean.

Usage:
  python scripts/backfill_sanitize_descriptions.py --dry-run
  python scripts/backfill_sanitize_descriptions.py --employer QatarEnergy --limit 10
  python scripts/backfill_sanitize_descriptions.py
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import requests  # noqa: E402

from scrape import (  # noqa: E402
    API_BASE,
    BaseHtmlParser,
    EntirelySafeClient,
    sanitize_description,
)


def _normalize_for_compare(html: str) -> str:
    """Whitespace-normalize so cosmetic re-emit differences from BS4 don't flag
    as 'changed'. We only want substantive changes to trigger a write."""
    return " ".join((html or "").split())


def clean_description(record: dict) -> str:
    title = (record.get("title") or "").strip()
    application_url = (record.get("applicationUrl") or "").strip()
    description = record.get("description") or ""
    deduped = BaseHtmlParser._strip_leading_title_dupe(description, title)
    return sanitize_description(deduped, application_url=application_url)


def build_put_payload(record: dict, cleaned_description: str) -> dict:
    """Echo all required validator fields back; only ``description`` changes."""
    payload: dict = {
        "title": record.get("title"),
        "slug": record.get("slug"),
        "company": record.get("company"),
        "description": cleaned_description,
        "employmentType": record.get("employmentType") or "full-time",
    }
    for opt_key in ("applicationUrl", "status", "postedBy", "closingDate", "location"):
        if record.get(opt_key) is not None:
            payload[opt_key] = record.get(opt_key)
    return payload


def put_vacancy(
    session: requests.Session, base_url: str, vacancy_id: str, payload: dict
) -> tuple[int, str]:
    r = session.put(
        f"{base_url}/vacancies/{vacancy_id}",
        json=payload,
        timeout=30,
    )
    if r.status_code in (200, 201):
        return (r.status_code, "")
    try:
        body = r.json() or {}
        err = body.get("error") or {}
        msg = f"{err.get('code', 'UNKNOWN')}: {err.get('message', '')}"
    except ValueError:
        msg = (r.text or "")[:200]
    return (r.status_code, msg)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Compute diffs but don't write")
    parser.add_argument("--employer", default="",
                        help="Only process vacancies whose company matches (substring, case-insensitive)")
    parser.add_argument("--limit", type=int, default=0,
                        help="Stop after N records (0 = all)")
    args = parser.parse_args()

    api_key = os.environ.get("ENTIRELYSAFE_API_KEY", "").strip()
    if not api_key:
        print("ENTIRELYSAFE_API_KEY env var is required", file=sys.stderr)
        return 2

    client = EntirelySafeClient(api_key)
    vacancies = client.list_vacancies()
    print(f"loaded {len(vacancies)} vacancies from API", file=sys.stderr)

    employer_filter = args.employer.strip().lower()
    examined = changed = errors = 0

    for v in vacancies:
        company = (v.get("company") or "").lower()
        if employer_filter and employer_filter not in company:
            continue
        examined += 1

        cleaned = clean_description(v)
        before = _normalize_for_compare(v.get("description") or "")
        after = _normalize_for_compare(cleaned)
        if before == after:
            continue

        changed += 1
        slug = v.get("slug") or v.get("id") or "?"
        before_len = len(v.get("description") or "")
        after_len = len(cleaned)
        delta = after_len - before_len
        action = "DRY-RUN" if args.dry_run else "PATCH"
        print(
            f"{action} {slug} ({v.get('company')}): "
            f"{before_len} → {after_len} chars ({delta:+d})",
            file=sys.stderr,
        )

        if not args.dry_run:
            payload = build_put_payload(v, cleaned)
            status, msg = put_vacancy(client.session, client.base_url, v["id"], payload)
            if status not in (200, 201):
                errors += 1
                print(f"  PUT failed {status}: {msg}", file=sys.stderr)
            time.sleep(0.1)

        if args.limit and changed >= args.limit:
            break

    print(
        f"summary: examined={examined} changed={changed} errors={errors} "
        f"dry_run={args.dry_run}",
        file=sys.stderr,
    )
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
