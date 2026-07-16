"""Adapter contract every site module implements."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Protocol

from ..models import Listing


@dataclass
class SearchSpec:
    """What the user asked for. Adapters map this onto their site's URLs."""
    category: str = "cars"     # currently: cars (adapters may support more later)
    country: str = "om"        # ISO-2; adapters raise if they don't cover it
    city: str = ""             # optional narrowing, site-native slug or name
    query: str = ""            # optional free-text search
    max_listings: int = 50
    with_details: bool = True  # fetch each detail page (desc, images, phone)
    posted_within_days: int = 0  # 0 = no filter; N = only listings first
    #                              posted within the last N days (by creation)


class SiteAdapter(Protocol):
    key: str          # registry name, e.g. "opensooq"
    label: str        # human name

    def search(self, spec: SearchSpec) -> Iterator[Listing]:
        """Yield listings (detail-enriched when spec.with_details)."""
        ...
