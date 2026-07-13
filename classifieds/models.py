"""Data model shared by every classifieds site adapter."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Seller:
    name: str = ""
    profile_url: str = ""
    phone: str = ""          # E.164-ish digits when the site exposes it
    member_since: str = ""


@dataclass
class Listing:
    site: str                # adapter key, e.g. "opensooq"
    listing_id: str          # site-native ID
    url: str
    title: str = ""
    description: str = ""
    price_raw: str = ""      # as displayed, e.g. "3,500 OMR"
    price_value: float | None = None
    currency: str = ""
    images: list[str] = field(default_factory=list)
    seller: Seller = field(default_factory=Seller)
    location: str = ""
    posted_at: str = ""      # ISO-8601 when derivable, else raw text
    attributes: dict[str, str] = field(default_factory=dict)  # make/model/year/km/...
    scraped_at: str = ""
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def uid(self) -> str:
        """Stable cross-run identity: site + native ID (or URL hash)."""
        key = self.listing_id or hashlib.sha1(self.url.encode()).hexdigest()[:16]
        return f"{self.site}:{key}"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["uid"] = self.uid
        return d
