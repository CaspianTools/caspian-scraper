"""CLI for the multi-site classifieds scraper.

    python -m classifieds --site all --country om --city muscat --max 30
    python -m classifieds --site opensooq,dubizzle --query "toyota land cruiser"
    python -m classifieds --site facebook --fb-cookies fb_cookies.json

Output goes to --out (default classifieds_out/): listings.jsonl (or .json)
plus images/ when --download-images is set. --state <file> dedupes across
runs: previously seen listing UIDs are skipped and appended on save.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import sites
from .ai import ai_enabled
from .models import Listing
from .output import download_images, load_seen, save_seen, write_results
from .sites.base import SearchSpec


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="classifieds",
        description="Scrape car classifieds (OpenSooq, Dubizzle Oman, Facebook Marketplace).",
    )
    p.add_argument(
        "--site",
        default="all",
        help="Comma-separated adapter keys, or 'all' for every non-login site "
        f"(available: {', '.join(sites.available())}; 'all' excludes facebook "
        "unless cookies are provided).",
    )
    p.add_argument("--category", default="cars", help="Listing category (default: cars).")
    p.add_argument("--country", default="om", help="ISO-2 country code (default: om = Oman).")
    p.add_argument("--city", default="", help="Optional city filter (e.g. muscat).")
    p.add_argument("--query", default="", help="Optional free-text search, e.g. 'land cruiser'.")
    p.add_argument("--max", type=int, default=50, dest="max_listings",
                   help="Max listings per site (default 50).")
    p.add_argument("--no-details", action="store_true",
                   help="Skip detail pages (faster; no description/phone).")
    p.add_argument("--out", default="classifieds_out", help="Output directory.")
    p.add_argument("--format", choices=("jsonl", "json"), default="jsonl")
    p.add_argument("--download-images", action="store_true",
                   help="Also download listing images under <out>/images/.")
    p.add_argument("--state", default="",
                   help="Path to a seen-IDs JSON file; when set, previously "
                        "scraped listings are skipped (incremental mode).")
    p.add_argument("--fb-cookies", default="",
                   help="Path to a Facebook cookies JSON (Playwright storage_state "
                        "or cookie-editor export). Required for the facebook adapter.")
    return p


def resolve_site_keys(arg: str, fb_cookies: str) -> list[str]:
    if arg == "all":
        keys = [k for k in sites.available() if k != "facebook"]
        if fb_cookies:
            keys.append("facebook")
        return keys
    keys = [k.strip() for k in arg.split(",") if k.strip()]
    unknown = [k for k in keys if k not in sites.available()]
    if unknown:
        raise SystemExit(
            f"Unknown site(s): {', '.join(unknown)}. Available: {', '.join(sites.available())}"
        )
    return keys


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    keys = resolve_site_keys(args.site, args.fb_cookies)
    spec = SearchSpec(
        category=args.category,
        country=args.country.lower(),
        city=args.city,
        query=args.query,
        max_listings=args.max_listings,
        with_details=not args.no_details,
    )
    out_dir = Path(args.out)
    seen: set[str] = set()
    state_path = Path(args.state) if args.state else None
    if state_path:
        seen = load_seen(state_path)
        print(f"[state] {len(seen)} previously seen listings loaded", file=sys.stderr)
    if ai_enabled():
        print("[ai] AI extraction fallback enabled (key found)", file=sys.stderr)

    all_listings: list[Listing] = []
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for key in keys:
        adapter = sites.build(key, fb_cookies=args.fb_cookies)
        print(f"[{key}] scraping (max {spec.max_listings})...", file=sys.stderr)
        count = 0
        try:
            for listing in adapter.search(spec):
                if listing.uid in seen:
                    continue
                listing.scraped_at = started
                all_listings.append(listing)
                seen.add(listing.uid)
                count += 1
                if args.download_images and listing.images:
                    download_images(listing, out_dir)
        except Exception as e:  # one broken site must not kill the others
            print(f"[{key}] ERROR: {e}", file=sys.stderr)
        print(f"[{key}] {count} new listings", file=sys.stderr)

    path = write_results(all_listings, out_dir, args.format)
    if state_path:
        save_seen(state_path, seen)
    print(f"[done] {len(all_listings)} listings -> {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
