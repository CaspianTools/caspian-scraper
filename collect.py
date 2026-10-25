"""Collect public business information from Google Maps and Google Search
with a visible browser. Simple on purpose.

    python collect.py "training centres" --where "Baku, Azerbaijan"
    python collect.py "oil and gas companies" --where Doha --max 50 --pages 2
    Collect.bat        (asks for the words and the place, then opens the file)

It opens Chrome and you watch it work. If Google asks "are you a robot",
solve it in that window — collecting carries on by itself. The browser keeps
its own profile (local-data/browser-profile), so cookies / consent stick and
Google asks less often.

Google Maps: every business in the results list is opened and its public
profile read — name, category, address, phone, website, rating, number of
reviews, opening hours, plus code, coordinates and the Maps link.
Google Search: the result pages — title, link and snippet.

Saved as it goes (closing the window keeps what's done):
    local-data/collected/<date>-<words>.csv and .json    (opens in Excel)
    the "Places" database (db/places.jsonl), and businesses with a website
    in the "Companies" database — both under Databases in the app.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote_plus, unquote

REPO_ROOT = Path(__file__).resolve().parent
OUT_DIR = REPO_ROOT / "local-data" / "collected"
PROFILE_DIR = REPO_ROOT / "local-data" / "browser-profile"
CAPTCHA_WAIT_S = 600  # how long to wait for someone to solve a captcha

COLUMNS = ["source", "name", "category", "address", "phone", "website", "rating", "reviews",
           "hours", "plus_code", "lat", "lng", "maps_url", "title", "link", "snippet", "query",
           "collected_at"]

# Read one Maps business profile (the panel that opens for a place).
PLACE_JS = r"""
() => {
  const q = (s) => document.querySelector(s);
  // Icon glyphs (private-use characters) out of every text.
  const clean = (s) => (s || "").replace(/[\ue000-\uf8ff]/g, "").replace(/\s+/g, " ").trim();
  const txt = (s) => clean(q(s)?.textContent);
  const attr = (s, a) => (q(s)?.getAttribute(a) || "").trim();
  const strip = (s, prefix) => s.replace(prefix, "").trim();
  const ratingBox = q("div.F7nice");
  let rating = ratingBox?.querySelector("span[aria-hidden='true']")?.textContent?.trim() || "";
  if (!rating) {
    const stars = q("span[role='img'][aria-label*='star']")?.getAttribute("aria-label") || "";
    rating = (stars.match(/[\d.,]+/) || [""])[0];
  }
  let reviews = ratingBox?.querySelector("span[aria-label*='review']")?.getAttribute("aria-label")
    || q("button[aria-label*=' reviews'], span[aria-label$=' reviews']")?.getAttribute("aria-label")
    || ratingBox?.textContent || "";
  reviews = ((reviews.match(/\(?([\d.,\s]+)\)?\s*review/i) || reviews.match(/\(([\d.,\s]+)\)/) || ["", ""])[1] || "").replace(/[^\d]/g, "");
  // "Monday: 9 AM–6 PM" per row of the opening-hours table.
  const hours = [...document.querySelectorAll("table tr")]
    .map((tr) => [...tr.querySelectorAll("td, th")].map((c) => clean(c.innerText)).filter(Boolean))
    .filter((cells) => cells.length >= 2 && /\d|closed|open/i.test(cells.join(" ")))
    .map((cells) => `${cells[0]}: ${cells.slice(1).join(" ")}`);
  const title = [...document.querySelectorAll("h1")].map((h) => clean(h.textContent)).find(Boolean) || "";
  return {
    name: title,
    category: txt("button[jsaction*='category']"),
    rating: rating.replace(",", "."),
    reviews,
    address: strip(attr("button[data-item-id='address']", "aria-label"), /^Address:\s*/i),
    website: attr("a[data-item-id='authority']", "href"),
    phone: strip(attr("button[data-item-id^='phone:tel:']", "aria-label"), /^Phone:\s*/i),
    plus_code: strip(attr("button[data-item-id='oloc']", "aria-label"), /^Plus code:\s*/i),
    hours: hours.join("; "),
  };
}
"""

# The organic results of a Google Search page. Google wraps each link in its
# own redirect (/goto?url=…, encrypted); the result also shows the site
# ("https://example.com › page"), kept as `site`.
SEARCH_JS = r"""
() => [...document.querySelectorAll("#search a:has(h3)")].map((a) => {
  const box = a.closest("div.MjjYud, div.g") || a.parentElement;
  const title = a.querySelector("h3")?.textContent?.trim() || "";
  const cite = (a.querySelector("cite") || box?.querySelector("cite"))?.textContent || "";
  const site = (cite.split("›")[0] || "").trim();
  let snippet = (box?.innerText || "").replace(title, "").split("\n").map((s) => s.trim()).filter(Boolean);
  snippet = snippet.filter((s) => !s.startsWith("http") && !s.includes("›") && s !== title && s !== "Web results").join(" ").slice(0, 400);
  return { title, link: a.href, site: site.startsWith("http") ? site : "", snippet };
}).filter((r) => r.title && r.link.startsWith("http"))
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def say(msg: str) -> None:
    print(msg, flush=True)


def pause(a: float = 1.0, b: float = 2.2) -> None:
    time.sleep(random.uniform(a, b))


class Collector:
    """A visible Chrome window with its own lasting profile."""

    def __init__(self, headless: bool = False):
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self.headless = headless
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        args = ["--disable-blink-features=AutomationControlled", "--start-maximized"]
        self.ctx = None
        for channel in ("chrome", "msedge", None):  # a real browser is trusted most
            try:
                self.ctx = self._pw.chromium.launch_persistent_context(
                    str(PROFILE_DIR), channel=channel, headless=headless, args=args,
                    locale="en-US", no_viewport=True)
                break
            except Exception:  # noqa: BLE001 — that browser isn't installed
                continue
        if self.ctx is None:
            self._pw.stop()
            raise SystemExit("No browser found. Run: .venv\\Scripts\\python -m playwright install chromium")
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()
        # Review counts by place link, read from the results list (the
        # profile page doesn't always show them).
        self.list_reviews: dict[str, str] = {}

    def close(self) -> None:
        try:
            self.ctx.close()
        finally:
            self._pw.stop()

    def goto(self, url: str) -> None:
        self.page.goto(url, timeout=60_000, wait_until="domcontentloaded")
        self.consent()
        self.wait_if_blocked()

    def consent(self) -> None:
        """Google's cookie page (EU): accept it once; the profile remembers."""
        if "consent." not in self.page.url:
            return
        for label in ("Accept all", "Reject all", "I agree"):
            btn = self.page.query_selector(f"button:has-text('{label}')")
            if btn:
                btn.click()
                self.page.wait_for_load_state("domcontentloaded")
                return

    def blocked(self) -> bool:
        return "/sorry/" in self.page.url or bool(self.page.query_selector("form#captcha-form, #recaptcha"))

    def wait_if_blocked(self) -> None:
        if not self.blocked():
            return
        if self.headless:  # nobody can solve it without a window
            raise RuntimeError("Google asked for a captcha (no window to solve it in; run without --headless)")
        say("\n  Google wants to check you're not a robot. Solve it in the browser window —")
        say("  collecting carries on by itself once it's done.")
        end = time.monotonic() + CAPTCHA_WAIT_S
        while self.blocked() and time.monotonic() < end:
            time.sleep(2)
        if self.blocked():
            raise RuntimeError("Google kept asking for a captcha; try again later")
        self.page.wait_for_load_state("domcontentloaded")

    # ---- Google Maps -----------------------------------------------------------
    def maps_list(self, query: str, limit: int) -> list[str]:
        """Links of the businesses Maps lists for the search (scrolling for more)."""
        self.goto(f"https://www.google.com/maps/search/{quote_plus(query)}?hl=en")
        try:
            self.page.wait_for_selector("div[role='feed'], h1", timeout=20_000)
        except Exception:  # noqa: BLE001
            return []
        if not self.page.query_selector("div[role='feed']"):
            return [self.page.url] if "/maps/place/" in self.page.url else []  # a single answer
        feed = self.page.query_selector("div[role='feed']")
        links: list[str] = []
        still = 0
        while len(links) < limit and still < 4:
            found = self.page.eval_on_selector_all(
                "div[role='feed'] a.hfpxzc",
                r"""els => els.map(e => {
                  const card = e.parentElement?.innerText || "";
                  const m = card.match(/\d[.,]\d\s*\(([\d.,\s]+)\)/);
                  return [e.href, m ? m[1].replace(/[^\d]/g, "") : ""];
                })""")
            before = len(links)
            for h, reviews in found:
                if reviews:
                    self.list_reviews[h] = reviews
                if h not in links:
                    links.append(h)
            say(f"  Maps list: {len(links)} businesses…")
            if self.page.query_selector("span:has-text(\"You've reached the end of the list\")"):
                break
            still = still + 1 if len(links) == before else 0
            feed.evaluate("el => el.scrollBy(0, el.scrollHeight)")
            pause(1.2, 2.0)
        return links[:limit]

    def maps_place(self, url: str) -> dict:
        """One business's public profile."""
        self.goto(url)
        try:
            self.page.wait_for_selector("h1", timeout=20_000)
            self.page.wait_for_timeout(800)  # the details fill in just after the name
        except Exception:  # noqa: BLE001
            return {}
        info = self.page.evaluate(PLACE_JS)
        m = re.search(r"!3d(-?[\d.]+)!4d(-?[\d.]+)", self.page.url) or re.search(r"@(-?[\d.]+),(-?[\d.]+)", self.page.url)
        if m:
            info["lat"], info["lng"] = m.group(1), m.group(2)
        info["maps_url"] = self.page.url.split("?")[0]
        if not info.get("reviews"):
            info["reviews"] = self.list_reviews.get(url, "")
        return info

    # ---- Google Search ---------------------------------------------------------
    def real_link(self, link: str) -> str:
        """Where a Google redirect link (/goto, /url) leads — asked in the
        browser's own session, without following it. "" if it won't say."""
        if not re.search(r"google\.[^/]+/(goto|url)\?", link):
            return link
        try:
            r = self.ctx.request.get(link, max_redirects=0, timeout=15_000)
            loc = r.headers.get("location", "")
            if loc.startswith("http") and "google." not in loc.split("/")[2]:
                return loc
            m = re.search(r"[?&](?:url|q)=(https?[^&]+)", loc)
            return unquote(m.group(1)) if m else ""
        except Exception:  # noqa: BLE001
            return ""

    def search(self, query: str, pages: int) -> list[dict]:
        out: list[dict] = []
        for p in range(pages):
            self.goto(f"https://www.google.com/search?q={quote_plus(query)}&hl=en&num=20&start={p * 20}")
            try:
                self.page.wait_for_selector("#search", timeout=15_000)
            except Exception:  # noqa: BLE001
                break
            rows = []
            for row in self.page.evaluate(SEARCH_JS):
                row["link"] = self.real_link(row["link"]) or row.pop("site", "") or row["link"]
                row.pop("site", None)
                if "google." not in row["link"]:
                    rows.append(row)
            out += [r for r in rows if r["link"] not in {x["link"] for x in out}]
            say(f"  Google Search page {p + 1}: {len(rows)} results")
            if not rows:
                break
            pause(2, 4)
        return out


# ---- saving ----------------------------------------------------------------------

def place_id(row: dict) -> str:
    """A stable id for a Maps business: its Google id in the link, else name + address."""
    m = re.search(r"!1s(0x[0-9a-f]+:0x[0-9a-f]+)", unquote(row.get("maps_url", "")))
    if m:
        return m.group(1)
    key = f"{row.get('name', '')}|{row.get('address', '')}".lower()
    return re.sub(r"[^a-z0-9]+", "-", key).strip("-")[:120] or "place"


def write_files(rows: list[dict], base: Path) -> None:
    base.parent.mkdir(parents=True, exist_ok=True)
    with open(base.with_suffix(".csv"), "w", newline="", encoding="utf-8-sig") as f:  # BOM: Excel reads UTF-8
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    base.with_suffix(".json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")


def save_to_databases(places: list[dict], where: str) -> None:
    """Into the "Places" database (all businesses) and "Companies" (those with a
    website), so they show up under Databases in the app."""
    import findings_db as fdb
    import localdb

    db = localdb.LocalDB()
    ref = db.collection("databases").document("places")
    if not ref.get().exists:
        ref.set({"name": "Places", "key": "id", "owner_uid": "local",
                 "description": "Businesses collected from Google Maps (collect.py): name, category, address, "
                                "phone, website, rating, hours.",
                 "record_label": {"singular": "place", "plural": "places"},
                 "created_at": localdb.SERVER_TIMESTAMP, "updated_at": localdb.SERVER_TIMESTAMP})
    country = where.split(",")[-1].strip() if where else ""
    items = []
    for r in places:
        item = {k: r[k] for k in ("name", "category", "address", "phone", "website", "rating", "reviews",
                                  "hours", "plus_code", "lat", "lng", "maps_url") if r.get(k)}
        item.update({"id": place_id(r), "sources": ["google_maps"], "found_by": [r["query"]]})
        if country:
            item["countries"] = [country]
        items.append(item)
    if items:
        # Places are saved as read (address and all), not merged like companies;
        # an earlier copy keeps its first sighting, searches, tags and hidden.
        old = fdb.load("places.jsonl")
        stamp = now_iso()
        merged = {}
        for it in items:
            prev = old.get(it["id"]) or {}
            merged[it["id"]] = {
                **prev, **it,
                "first_seen": prev.get("first_seen", stamp), "last_seen": stamp,
                "found_by": list(dict.fromkeys([*it["found_by"], *(prev.get("found_by") or [])]))[:20],
                **({"tags": prev["tags"]} if prev.get("tags") else {}),
                **({"hidden": prev["hidden"]} if "hidden" in prev else {}),
            }
        fdb.put(merged, "places.jsonl")
    companies = [{"id": fdb.company_id(r["website"]), "name": r["name"], "website": r["website"],
                  "types": [r["category"]] if r.get("category") else [], "sources": ["google_maps"],
                  "found_by": [r["query"]], **({"countries": [country]} if country else {}),
                  **({"address": r["address"]} if r.get("address") else {})}
                 for r in places if r.get("website") and fdb.company_id(r["website"])]
    if companies:
        fdb.upsert(companies)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Collect public business info from Google Maps + Google Search.")
    ap.add_argument("words", help='what to look for, e.g. "training centres"')
    ap.add_argument("--where", default="", help='place, e.g. "Baku, Azerbaijan"')
    ap.add_argument("--max", type=int, default=60, help="businesses to open on Maps (default 60)")
    ap.add_argument("--pages", type=int, default=1, help="Google Search result pages (0 = skip)")
    ap.add_argument("--no-maps", action="store_true", help="skip Google Maps")
    ap.add_argument("--headless", action="store_true", help="no window (Google blocks this more)")
    ap.add_argument("--no-db", action="store_true", help="only write the CSV/JSON files")
    args = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    query = f"{args.words} in {args.where}" if args.where else args.words
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")[:60]
    base = OUT_DIR / f"{stamp}-{slug}"
    rows: list[dict] = []
    say(f"Collecting: {query}")
    say(f"Saving to:  {base.with_suffix('.csv')}\n")

    c = Collector(headless=args.headless)
    try:
        if not args.no_maps:
            links = c.maps_list(query, args.max)
            say(f"\nOpening {len(links)} business profiles on Maps:")
            for i, link in enumerate(links, 1):
                try:
                    info = c.maps_place(link)
                except Exception as e:  # noqa: BLE001 — one bad profile shouldn't stop the rest
                    say(f"  {i}/{len(links)}  (couldn't read: {type(e).__name__})")
                    continue
                if not info.get("name"):
                    continue
                rows.append({"source": "google_maps", **info, "query": query, "collected_at": now_iso()})
                say(f"  {i}/{len(links)}  {info['name'][:50]:50}  {info.get('phone', '')[:18]:18}  "
                    f"{(info.get('website') or '')[:40]}")
                write_files(rows, base)  # after each one: stopping never loses work
                pause(0.8, 1.8)
        if args.pages > 0:
            say("\nGoogle Search:")
            for r in c.search(query, args.pages):
                rows.append({"source": "google_search", **r, "query": query, "collected_at": now_iso()})
    except KeyboardInterrupt:
        say("\nStopped — keeping what was collected.")
    except Exception as e:  # noqa: BLE001 — e.g. the window was closed: keep what's done
        say(f"\nStopped early: {type(e).__name__}: {str(e)[:200]}")
    finally:
        write_files(rows, base)
        try:
            c.close()
        except Exception:  # noqa: BLE001
            pass

    places = [r for r in rows if r["source"] == "google_maps"]
    if places and not args.no_db:
        save_to_databases(places, args.where)
    say(f"\nDone: {len(places)} businesses from Maps, {len(rows) - len(places)} Google Search results.")
    say(f"File: {base.with_suffix('.csv')}")
    if places and not args.no_db:
        say("Also saved in the app under Databases → Places (and Companies for those with a website).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
