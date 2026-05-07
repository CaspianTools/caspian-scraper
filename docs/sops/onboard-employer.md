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
| **Workday** | URLs contain `myworkdayjobs.com`; `data-automation-id` attributes |
| **Greenhouse** | `boards.greenhouse.io/<company>`; `<div class="opening">` rows |
| **Lever** | `jobs.lever.co/<company>`; `<a class="posting-title">` |
| **iCIMS** | URLs contain `icims.com`; iframe-heavy |
| **Taleo** | URLs contain `taleo.net` |

Most large oil-and-gas / industrial employers are on SuccessFactors.

## Step 4 — Check parser support

Open `scrape.py`, find the `PARSERS` dict (around line 348):

```python
PARSERS: dict[str, type] = {
    "successfactors": SuccessFactorsParser,
}
```

- If your ATS key is present → **skip to Step 6**.
- If not → continue to Step 5.

## Step 5 — (Only if unsupported) Implement a new parser

Skip this entire step if Step 4 already matched.

1. Copy the `SuccessFactorsParser` class as a template (around `scrape.py` lines 160–346).
2. Rename it (e.g. `WorkdayParser`).
3. Replace the five selector chains with selectors discovered via DevTools on the live careers site:
   - `LIST_LINK_SELECTORS` — anchors to job detail pages on the search results.
   - `DETAIL_TITLE_SELECTORS` — the job title heading on a detail page.
   - `DETAIL_LOCATION_SELECTORS` — the location element on a detail page.
   - `DETAIL_DESCRIPTION_SELECTORS` — the job description body.
   - `NEXT_PAGE_SELECTORS` — pagination "next" link.
   List multiple selectors per chain — the parser tries them in order until one matches.
4. Register the new class in the `PARSERS` dict:
   ```python
   PARSERS: dict[str, type] = {
       "successfactors": SuccessFactorsParser,
       "workday": WorkdayParser,
   }
   ```
5. Use the new key (e.g. `"workday"`) as the `ats` value in Step 6.

## Step 6 — Add the entry to `employers.json`

Append a new object to the array:

```json
{
  "name": "Schlumberger",
  "url": "https://careers.slb.com/search/?q=hse&locationsearch=",
  "ats": "successfactors",
  "active": true
}
```

All four fields are required — the loader at `scrape.py` lines 517–525 rejects entries that are missing any of them.

Set `"active": false` to onboard but pause; flip to `true` when ready.

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
