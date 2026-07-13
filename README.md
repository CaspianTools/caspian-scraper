# HSE scraper

Daily scraper that finds Health, Safety, Environment (HSE) job postings on a
configurable list of employer career sites and publishes each new one to the
`entirelysafe.com` REST API. The API is the single source of truth — there
is no database, spreadsheet, or local cache; dedup is performed by listing
existing vacancies before posting.

```
┌──────────────┐  scrapes  ┌────────────────┐  POSTs new   ┌──────────────────┐
│ Career sites │──────────▶│ scraper        │─────────────▶│ entirelysafe.com │
│ (Aramco,     │           │ (Python +      │              │ /api/v1          │
│  Halliburton,│           │  Playwright,   │              │ /vacancies       │
│  …)          │           │  GitHub        │              └──────────────────┘
└──────────────┘           │  Actions cron) │
                           └────────────────┘
                                  ▲
                                  │ reads employers list
                                  │
                            employers.json
                            (in this repo)
```

GitHub Actions runs the scraper daily at **04:30 UTC**. It can also be
triggered on demand from the **Actions** tab via *Run workflow*.

---

## Setup

### 1. Configure the GitHub secret

In the repo: **Settings → Secrets and variables → Actions → New repository
secret.**

| Name | Value |
|------|-------|
| `ENTIRELYSAFE_API_KEY` | Your entirelysafe.com API key (the scraper sends it as `X-API-Key`). |

That is the only secret required.

### 2. Run the workflow

The workflow runs on cron, but for the first run you can trigger it manually:
**Actions → HSE scrape → Run workflow.** The `Run scraper` step's logs end
with a JSON summary of the run.

---

## Adding an employer

`employers.json` is the master list of ME oil-and-gas employers and
recruitment agencies. Most are staged as `"active": false` /
`"ats": "unknown"` until classified. To start scraping a new one, either
flip an existing entry or append a fresh object:

```json
{
  "name": "Schlumberger",
  "kind": "employer",
  "type": "Oilfield Services",
  "countries": ["UAE", "Saudi Arabia"],
  "headquarters": "Abu Dhabi",
  "segment": "Drilling, Well Services, Digital",
  "website": "https://www.slb.com",
  "careers_url": "https://careers.slb.com/search/?q=hse&locationsearch=",
  "linkedin": "https://www.linkedin.com/company/slb/",
  "ats": "successfactors",
  "active": true,
  "notes": ""
}
```

Required for the scraper: `name`, `careers_url`, `ats`, `active`. Other
fields are metadata (used by the dashboard / tracking, ignored at scrape
time). Set `"active": false` to keep an entry staged without scraping it.

If the employer's careers site uses an ATS the scraper already supports
(see `PARSERS` in `scrape.py`), no code change is needed. Most large
employers use SAP SuccessFactors, which is supported out of the box.

---

## Adding a new ATS

Each parser is a class registered in the `PARSERS` dict in `scrape.py`. To
add support for a new ATS:

1. Copy `SuccessFactorsParser` as a template.
2. Replace the selector chains (`LIST_LINK_SELECTORS`,
   `DETAIL_TITLE_SELECTORS`, `DETAIL_LOCATION_SELECTORS`,
   `DETAIL_DESCRIPTION_SELECTORS`, `NEXT_PAGE_SELECTORS`) with selectors
   that match the new ATS.
3. Register the class:

   ```python
   PARSERS = {
       "successfactors": SuccessFactorsParser,
       "workday": WorkdayParser,
   }
   ```

4. Use the new key as the `ats` value in `employers.json`.

The parser interface is just `parse(employer_name, search_url) -> list[Role]`.
Per-employer differences should be expressed in the registry — never via
branching on employer name in `main()`.

If the careers site exposes an RSS feed for searches (SuccessFactors typically
does at `/search/rss/?q=...`), prefer parsing the feed over headless
browsing — it is faster and more stable across UI revamps.

---

## Running locally

```bash
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m playwright install chromium

export ENTIRELYSAFE_API_KEY="es_live_..."
python scrape.py
```

Expected output is a single JSON object on stdout — the run summary:

```json
{
  "checked": 2,
  "skipped_inactive": 0,
  "found": 14,
  "published": 9,
  "skipped_duplicate": 5,
  "errors": [],
  "published_roles": [
    {
      "employer": "Aramco",
      "title": "HSE Engineer",
      "location": "Dhahran, Saudi Arabia",
      "slug": "hse-engineer-aramco",
      "id": "vac_01HABCDE...",
      "url": "https://careers.aramco.com/job/..."
    }
  ]
}
```

A re-run of the script immediately after a successful run should report
`"published": 0` — every role is already on the API and will be filtered out
by the slug + (title, company) dedup check.

---

## Classifieds scraper (cars — Oman)

A separate, self-contained module (`classifieds/`) scrapes **used-car
classified ads** from several Oman sites into a single JSON/JSONL file. It is
independent of the HSE job scraper above — its own CLI, its own GitHub Actions
workflow (`.github/workflows/classifieds.yml`), and it publishes nothing to any
API; results are written to disk (and uploaded as a workflow artifact).

Each listing captures: **title, description, images, price, seller name, seller
profile, phone number (where the site exposes it), location, posting date, and
car attributes** (make / model / year / kilometers / …).

### Supported sites

| `--site` key | Site | Method | Phone number |
|---|---|---|---|
| `opensooq`   | OpenSooq Oman (`om.opensooq.com`)        | Playwright + `__NEXT_DATA__` JSON | masked only (site hides it; reveal key captured) |
| `dubizzle`   | Dubizzle Oman (`dubizzle.com.om`)        | Playwright + `__NEXT_DATA__`, Cloudflare-gated | **yes** — via the `contactInfo` reveal endpoint |
| `yallamotor` | YallaMotor Oman (`oman.yallamotor.com`)  | plain HTTP + JSON-LD (no browser) | when present in the page |
| `facebook`   | Facebook Marketplace                      | Playwright, **requires your login cookies** | never (Facebook redacts phones) |

`--site all` runs every site except `facebook` (which needs cookies — it is
included automatically once `--fb-cookies` is given).

### Running locally

```bash
# same venv as the HSE scraper (Playwright + requests already installed)
python -m classifieds --site all --country om --city muscat --max 30
python -m classifieds --site opensooq,dubizzle --query "land cruiser" --max 20
python -m classifieds --site yallamotor --download-images --out cars_out
```

Output goes to `--out` (default `classifieds_out/`): `listings.jsonl` (one JSON
object per line; use `--format json` for a single pretty array) plus an
`images/` folder when `--download-images` is set. Pass `--state seen.json` to
run **incrementally** — listing IDs seen on previous runs are skipped and the
file is updated at the end.

### Facebook Marketplace (optional, needs your session)

Marketplace is login-walled, so the `facebook` adapter needs **your own**
Facebook session cookies. Export them (a Playwright `storage_state.json`, or a
Cookie-Editor JSON export for `.facebook.com` that includes `c_user` and `xs`)
and pass the file:

```bash
python -m classifieds --site facebook --city muscat --fb-cookies fb_cookies.json
```

Notes: this is a **best-effort auxiliary source** — Facebook rotates its markup
frequently, phone numbers are never available (contact is via Messenger), and
scraping while logged in is against Facebook's ToS, so use a disposable account
and a low rate. Without cookies the adapter is simply skipped.

### Bring your own AI key (optional)

If an environment variable `CLASSIFIEDS_AI_KEY` (or `ANTHROPIC_API_KEY`) is set,
the adapters use Claude as a **fallback extractor** only when their structured
parsing comes back with missing fields (e.g. after a site redesign) — it fills
the blanks from the raw page HTML. Adapter-extracted values always take
precedence; AI never overrides them. **With no key everything still works** —
the fallback is skipped and normal structured extraction is used. Set
`CLASSIFIEDS_AI_MODEL` to override the model (default: a small, cheap Claude).

### In GitHub Actions

Run **Actions → Classifieds scrape → Run workflow** and choose the site(s),
country, city, query, and max. Results download as the `classifieds-results`
artifact. Two optional repo secrets enable extra capabilities:

- `CLASSIFIEDS_AI_KEY` — Anthropic API key for the AI fallback.
- `FB_COOKIES_JSON` — your Facebook cookies JSON (enables the `facebook` site).

> **Note on this environment:** live scraping needs open outbound network, which
> the GitHub Actions runner has. Local test/CI runs here use hermetic fixtures
> (`tests/test_classifieds.py`) rather than hitting the live sites, matching how
> the HSE parser tests work.

---

## Troubleshooting

**`401 Unauthorized` — `MISSING_API_KEY` / `INVALID_API_KEY` /
`EXPIRED_API_KEY`.** The `ENTIRELYSAFE_API_KEY` secret is missing,
mistyped, or has been rotated. Update the secret in **Settings → Secrets and
variables → Actions** and re-run the workflow. The scraper halts immediately
with exit code 1 on auth errors — by design — so the run summary will be
short.

**`429 Too Many Requests` — `RATE_LIMITED`.** The API allows 100 requests
per minute per key. The scraper already sleeps when
`X-RateLimit-Remaining < 10` and retries once after a 429, so this should
be rare. If you keep seeing it, lower the per-employer `max_pages` in
`SuccessFactorsParser.collect_links` or split the run across two scheduled
times.

**`"checked": 2, "found": 0`.** Two possibilities:

1. *The careers site rendered, but no list-link selector matched.* SF skins
   drift between tenants. Open the search page in your browser's DevTools,
   find the `<a>` element wrapping a job title, and add its selector to
   the front of `SuccessFactorsParser.LIST_LINK_SELECTORS`. The same
   approach applies for `DETAIL_TITLE_SELECTORS` /
   `DETAIL_LOCATION_SELECTORS` / `DETAIL_DESCRIPTION_SELECTORS` — the
   existing lists are fallback chains, so adding one more candidate is
   usually enough. The scraper logs `no list-link selector matched on
   <url>` to stderr when this happens, which appears in the workflow logs
   above the JSON summary.

2. *Detail pages were fetched, but no role's **title** matched an HSE
   keyword.* Matching is title-only by design — descriptions are too
   noisy with HR boilerplate to be a reliable HSE signal. Either widen
   `HSE_KEYWORDS` in `scrape.py` (e.g. add an industry-specific
   synonym), or check that the search URL is actually pre-filtered for
   HSE on the employer's site.

**`VALIDATION_ERROR` from a POST.** The role is skipped, the run continues,
and the offending payload's `details[]` is included in the `errors` entry
for that role. Common causes: the slug collided with an existing one (very
rare given the dedup check), or the description contained characters the
API rejects.

**Workflow times out.** The default `timeout-minutes: 30` should be enough
for a few employers; bump it in `.github/workflows/scrape.yml` if you have
many. You can also reduce work per employer by lowering `max_pages` in
`SuccessFactorsParser.collect_links`.
