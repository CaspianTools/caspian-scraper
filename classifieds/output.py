"""Result sinks: JSONL / pretty JSON, seen-ID state, optional image download."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import requests

from .models import Listing


def write_results(listings: list[Listing], out_dir: Path, fmt: str = "jsonl") -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = [l.to_dict() for l in listings]
    if fmt == "json":
        path = out_dir / "listings.json"
        path.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        path = out_dir / "listings.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


def load_seen(state_path: Path) -> set[str]:
    if state_path.exists():
        try:
            return set(json.loads(state_path.read_text()))
        except ValueError:
            pass
    return set()


def save_seen(state_path: Path, seen: set[str]) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(sorted(seen), indent=0))


_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def download_images(listing: Listing, out_dir: Path, *, max_images: int = 12) -> list[str]:
    """Download listing images under out_dir/images/<uid>/. Returns local paths."""
    dest = out_dir / "images" / _SAFE.sub("_", listing.uid)
    dest.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    for i, url in enumerate(listing.images[:max_images]):
        ext = os.path.splitext(url.split("?")[0])[1] or ".jpg"
        if len(ext) > 5:
            ext = ".jpg"
        path = dest / f"{i:02d}{ext}"
        try:
            r = requests.get(url, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
            if r.ok and r.content:
                path.write_bytes(r.content)
                saved.append(str(path))
        except requests.RequestException:
            continue
    return saved
