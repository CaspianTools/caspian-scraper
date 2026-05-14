# `state/` — bot-owned files

Files in this directory are written by `scrape.py` at the end of each run
and committed by the scheduled workflow. They are **not** meant to be edited
by hand — manual edits will race with the bot and get overwritten.

## `lessons.jsonl`

Append-only JSON Lines log, one record per *active* employer per run.
Designed for downstream LLM analysis: each line is self-contained context
about a single (employer, run) pair.

### Schema

```json
{
  "run_started": "2026-05-14T01:58:56Z",
  "run_finished": "2026-05-14T02:03:01Z",
  "run_status": "ok | error | auth_halt",
  "employer": "Saudi Aramco",
  "ats": "successfactors",
  "careers_url": "https://careers.aramco.com/search/?q=hse...",
  "verdict": "ok | errors | zero_found | no_new",
  "found": 6,
  "published": 0,
  "skipped_duplicate": 6,
  "errors": ["..."]
}
```

### Verdict semantics

- `ok` — published one or more new roles.
- `errors` — at least one error during scrape or POST. Inspect `errors[]`.
- `zero_found` — page loaded, but no HSE roles matched. Usually means
  selectors drifted or `HSE_KEYWORDS` is too narrow for this employer.
  **Most actionable verdict.**
- `no_new` — found roles, but all were duplicates of existing
  entirelysafe.com vacancies. Informational.

### Suggested LLM workflows

- "For every employer with 3+ consecutive `zero_found` verdicts, propose a
  selector or keyword change."
- "Cluster `errors[]` strings to find systemic issues (Cloudflare gates,
  Playwright timeouts, sanitiser rejections)."
- "Summarise which employers are most productive (highest `published`
  count over the last 30 runs)."
