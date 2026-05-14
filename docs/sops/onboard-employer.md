# SOP: Onboard a new employer and its website

A repeatable procedure for adding a new employer to the HSE scraper so its job listings flow into entirelysafe.com.

**Audience:** anyone (or any agent) onboarding a new employer to caspian-scraper.
**Outcome:** a new entry in `employers.json` whose roles are scraped daily and published to the entirelysafe.com vacancies API.

---

## Step 1 — Gather inputs

Collect three things for the new employer:

- **Name** — display name shown in entirelysafe.com listings (e.g. `Schlumberger`).
- **Search URL** — a careers-site URL pre-filtered for HSE / safety roles (the `q=hse` query plus any location filter).
- **ATS system** — which Applicant Tracking System the careers site runs on.

If any of the three is missing, do not proceed.

## Step 2 — Verify the search URL in a browser

Open the URL in a normal browser. Confirm:

- The page returns a list of jobs.
- The visible titles include HSE / safety / EHS / health-and-safety roles. The scraper applies a title-keyword filter (`HSE_KEYWORDS` in `scrape.py`); if no titles match, you'll get `found: 0`.
- No interstitial — cookie banner, geo gate, login wall — blocks the listing. Playwright runs headless and won't dismiss anything custom.

If the URL doesn't return relevant titles, refine the query before continuing.

## Step 3 — Identify the ATS

Use DevTools (Elements panel) and the URL itself to figure out the vendor:

| Vendor | Tells |
|---|---|
| **SAP SuccessFactors** | `data-careersite-propertyid="..."` attributes; `careers.<company>.com`; `*.successfactors.com` |
| **Jibe / iCIMS** | URLs contain `cms.jibecdn.com` or `icims.com`; job detail paths look like `/jobs/<numeric-id>?lang=en-us` |
| **Workday** | URLs contain `myworkdayjobs.com`; `data-automation-id` attributes |
| **Greenhouse** | `boards.greenhouse.io/<company>`; `<div class="opening">` rows |
| **Lever** | `jobs.lever.co/<company>`; `<a class="posting-title">` |
| **Taleo** | URLs contain `taleo.net` |

Most large oil-and-gas / industrial employers are on SuccessFactors. GCC
national oil companies often use Jibe.

**Before writing a parser, check for an RSS or JSON endpoint.** Many ATSs
expose one (e.g. SF often has `/search/rss/?q=...`; Jibe often has
`/api/job-search/...`). When available, that path is faster and far less
fragile than headless browsing — worth a few minutes of DevTools-Network
inspection on the live site.

## Step 4 — Check parser support

Open `scrape.py`, find the `PARSERS` dict:

```python
PARSERS: dict[str, type] = {
    "successfactors": SuccessFactorsParser,
    "jibe": JibeParser,
}
```

- If your ATS key is present → **skip to Step 6**.
- If not → continue to Step 5.

## Step 5 — (Only if unsupported) Implement a new parser

Skip this entire step if Step 4 already matched.

A new parser is a subclass of `BaseHtmlParser` that declares five
selector chains and (only if the site doesn't paginate by clicking
"Next") overrides `collect_links`. The base class handles Playwright
boot, page navigation, link gathering, detail-page extraction, the
HSE title gate, country/employment-type inference, and per-role error
isolation.

1. Pick a class name (e.g. `WorkdayParser`).
2. Subclass `BaseHtmlParser` and declare the selector chains:
   ```python
   class WorkdayParser(BaseHtmlParser):
       LIST_LINK_SELECTORS = ["a[data-automation-id='jobTitle']"]
       DETAIL_TITLE_SELECTORS = ["h2[data-automation-id='jobPostingHeader']"]
       DETAIL_LOCATION_SELECTORS = ["[data-automation-id='locations']"]
       DETAIL_DESCRIPTION_SELECTORS = ["[data-automation-id='jobPostingDescription']"]
       NEXT_PAGE_SELECTORS = ["button[data-uxi-element-id='next']"]
   ```
   List multiple candidates per chain — the base parser tries them in
   order until one matches. Add a `DETAIL_HREF_RE` (compiled regex) if
   the list page contains noisy `/jobs/categories/...` style links you
   want filtered out (see `JibeParser` for an example).
3. **Only if** the site uses scroll-to-load or non-standard pagination,
   override `collect_links` (compare `JibeParser.collect_links` to the
   base default).
4. Register the new class in `PARSERS`:
   ```python
   PARSERS: dict[str, type] = {
       "successfactors": SuccessFactorsParser,
       "jibe": JibeParser,
       "workday": WorkdayParser,
   }
   ```
5. Add a fixture under `tests/fixtures/` and a parser test in
   `tests/test_parsers.py` so future selector drift gets caught on PR.
6. Use the new key (e.g. `"workday"`) as the `ats` value in Step 6.

## Step 6 — Add or update the entry in `employers.json`

`employers.json` carries every known ME oil-and-gas employer plus recruitment agencies — most are staged as `"active": false` with `"ats": "unknown"` until they're classified. To onboard a new scrape target, either flip an existing entry's `active`/`ats`/`careers_url` or append a fresh object.

Full schema:

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

Required for the scraper: `name`, `careers_url`, `ats`, `active`. The other fields are metadata. The loader rejects entries missing any of the four required keys.

Set `"active": false` to keep staged; flip to `true` when ready. The `careers_url` should be the HSE-filtered search URL, not the careers landing page.

## Step 7 — Test locally

Windows PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m playwright install chromium
$env:ENTIRELYSAFE_API_KEY = "es_live_..."
python scrape.py
```

macOS / Linux: same commands with `source .venv/bin/activate` and `export ENTIRELYSAFE_API_KEY=...`.

Inspect the JSON summary printed to stdout. Healthy output:

- `found > 0` for the new employer (in `by_employer`).
- `errors: []`.
- `published_roles` includes one or more entries from the new employer.

If `found: 0`, your selectors don't match — return to Step 5 and tweak.
If `errors` are populated, read the message and fix the underlying issue before pushing.

## Step 8 — Spot-check a published vacancy

Pick one entry from `published_roles` in the test output. Open the corresponding page on https://entirelysafe.com/vacancies/<slug>. Confirm:

- Title matches the source posting.
- Location is correct (or at least sensible).
- "Apply" / source link goes back to the original employer's job page.
- Description renders without obvious truncation or HTML breakage.

## Step 9 — Commit and push

Stage and commit only:

- `employers.json`
- `scrape.py` (only if Step 5 ran)

**Do not commit local `docs/data.json`** — the scheduled workflow regenerates it. If your local run modified it, revert before committing.

```powershell
git add employers.json scrape.py
git commit -m "Add <employer name> to scraper"
git push
```

## Step 10 — Verify the next workflow run

The workflow at `.github/workflows/scrape.yml` runs daily at **04:30 UTC** (cron `30 4 * * *`). To verify sooner:

1. GitHub → Actions → **Daily HSE scrape** → **Run workflow**.
2. Wait for it to finish (≤ 30 min by default).
3. Confirm the run is green.
4. Open `docs/data.json` on the main branch and confirm the new employer appears in the latest entry's `by_employer` array, with `found > 0`.
5. Open the dashboard (GitHub Pages) and confirm the new employer shows up in the Employers table.

## Step 11 — Troubleshoot known failures

| Symptom | Cause | Fix |
|---|---|---|
| `401 MISSING_API_KEY` | `ENTIRELYSAFE_API_KEY` secret missing or wrong | Reset the secret in repo Settings → Secrets and variables → Actions |
| `429 RATE_LIMITED` (persistent) | API rate limits or scraping too many pages | The scraper auto-retries once; if persistent, lower `max_pages` in the parser's `collect_links()` |
| `found: 0` | Selectors don't match the site's DOM | Reopen DevTools, refine selector chains in the parser |
| Workflow times out | Slow careers site or too many employers | Bump `timeout-minutes` in `scrape.yml` |
| `no parser registered for ATS '<x>'` | `ats` value in `employers.json` doesn't match a key in `PARSERS` | Either fix the typo or implement the parser (Step 5) |
| Auth errors halt entire run | 401/403 from entirelysafe API | Halts intentionally — fix API key before any roles publish |

---

**When this SOP is complete:** a new employer's HSE roles are flowing daily into entirelysafe.com, the dashboard reflects them, and the only ongoing maintenance is watching for selector drift if the careers site is redesigned.
