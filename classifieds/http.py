"""Shared HTTP plumbing for site adapters.

Every adapter goes through `polite_session()` / `get()` so rate limiting,
retries, and browser-like headers live in one place.
"""

from __future__ import annotations

import random
import time

import requests

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

BROWSER_HEADERS = {
    "User-Agent": DEFAULT_UA,
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
}

# Seconds between requests to the same site. Classifieds sites are
# consumer-facing; stay well under anything that looks like abuse.
MIN_DELAY_S = 1.5
MAX_DELAY_S = 3.5

_last_request_at: dict[str, float] = {}


def polite_session(extra_headers: dict | None = None) -> requests.Session:
    s = requests.Session()
    s.headers.update(BROWSER_HEADERS)
    if extra_headers:
        s.headers.update(extra_headers)
    return s


def throttle(site: str) -> None:
    """Sleep so consecutive requests to `site` are MIN..MAX seconds apart."""
    now = time.monotonic()
    last = _last_request_at.get(site)
    if last is not None:
        wait = random.uniform(MIN_DELAY_S, MAX_DELAY_S) - (now - last)
        if wait > 0:
            time.sleep(wait)
    _last_request_at[site] = time.monotonic()


def get(
    session: requests.Session,
    url: str,
    *,
    site: str,
    timeout: int = 30,
    retries: int = 3,
    **kwargs,
) -> requests.Response:
    """GET with per-site throttling and exponential-backoff retries."""
    last_exc: Exception | None = None
    for attempt in range(retries):
        throttle(site)
        try:
            r = session.get(url, timeout=timeout, **kwargs)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code} for {url}", response=r)
            return r
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as e:
            last_exc = e
            if attempt < retries - 1:
                time.sleep(2 ** (attempt + 1))
    raise last_exc  # type: ignore[misc]
