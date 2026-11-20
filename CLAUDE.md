# CLAUDE.md — caspian-scraper

Caspian Scraper: a Python + Playwright scraper (`scrape.py`) plus a Next.js admin app (`web/`) that run **locally, with no sign-in and no Firestore**. The menu is **Jobs · Databases · Settings**.

- **Jobs are generic** (`web/lib/jobTemplates.ts`): each job is its own scraping project — description, record name (`record_label`, used in every label), `fields` (the Results columns), sources of any engine, `saves_to` / `reads_from` databases, `modules` (discovery, follow_up, compare), `relevance` rules, `use_ai` + `ai_spend_cap`. Templates (vacancies, cars, prices, blank) only pre-fill a new job. Sources: careers pages (the job's own `projects/<id>/sources`, shared library `resource_ids`, and the careers pages of the databases in `reads_from`) run in `run_project`; car / comparison / generic sources carry the job's id in `project_id` and run in their engines. Running a job (`ONLY_PROJECT_ID`, Run now, Start.bat) runs all of it (`scrape.job_work`), then `scrape.collect_job` gathers every engine's records into the job's results store (`job_results.py`: new / changed / unchanged / gone), scores relevance (`relevance.py`) and saves into its databases. Job pages: Results · Sources · Runs · [Discover] · [Compare] · Settings.
- **Storage**: job/source/resource/database config are JSON files in `data/` (committed, via `localdb.py` ⇄ `web/lib/localdb.ts` — keep them in sync, see `data/README.md`); run data (runs, engine records, lessons, logs) go to gitignored `local-data/`. Records live in the **SQLite record store** `local-data/scraper.db` (`recordstore.py` ⇄ `web/lib/recordstore.ts`): stores `db:<id>` (databases, mirrored to committed `db/<id>.jsonl` — every write exports, a changed file is re-imported after a pull; only Python writes exports) and `job:<id>` (a job's results, local only). The Companies database (`db/companies.jsonl`, `findings_db.py`) is what **Find websites** (`find_websites.py`: Google Maps, Google/DuckDuckGo via an off-screen Chrome, OpenStreetMap; Wikidata only adds details — free, no keys) grows. Record actions (tag, hide, delete, careers pages, AI tag `ai_tag.py`) take a `database` (`<id>` or `job:<id>`).
- **Collect** (`collect.py`, `Collect.bat`): the simple path — a visible Chrome (own profile in `local-data/browser-profile`) searches Google Maps + Google Search, opens each business and writes its public details to `local-data/collected/<date>-<words>.csv/.json` as it goes, then into the Places database (`db/places.jsonl`, keyed by Google's place id, saved as read) and Companies (those with a website). A captcha waits for a person to solve it in the window.
- Jobs have no destinations: nothing is published. Tests run on every push/PR (`.github/workflows/tests.yml`, `pytest`). The web app needs Node 22.13+ (`node:sqlite`).

## Ship mechanism

There is **no deploy**. `Start.bat` (repo root) runs a scrape and opens the admin app on its findings; `open-admin.bat` just starts the admin app (`next dev`, http://localhost:4444), whose *Run now* buttons start `scrape.py` on the same computer (`web/lib/localRunner.ts`). A change "ships" by merging to `main` and pulling it on the computer that runs it. The old Firestore cron (`.github/workflows/scrape-due.yml`) has its schedule disabled; `scrape.py` only uses Firestore if `GOOGLE_APPLICATION_CREDENTIALS[_JSON]` is set.

## Owner actions live in GitHub issues, linked to the session that asked

**Rule (owner, 20 Nov 2026).** Anything the owner has to do, decide or check
is a GitHub issue **in this repository** (`CaspianTools/caspian-scraper`), opened in the same turn it comes
up — never only in the chat. The chat disappears when the session ends; the
issue does not. Link the issue in the reply. Search the open issues first and
add to an existing one rather than opening a duplicate.

### Mark who it is for, twice

| For | Label | Title starts with |
| --- | --- | --- |
| The owner — something to do or check | `for: owner` | `[YOU]` |
| The owner — a choice to make | `for: owner` + `decision` | `[YOU · DECIDE]` |
| Claude — development work to pick up | `for: claude` | `[CLAUDE]` |

Create the labels if the repository does not have them yet. When an issue
changes hands, change both markers.

### The shape of a `[YOU]` issue: steps first, reasons last

```
## Do this

1. One action, naming the site, repository or console it happens in.
   A command, or a Claude for Chrome script for anything done in a
   browser, goes in its own block under the step.

2. Next action.

## Why

Two sentences at most: what is wrong and what doing the steps changes.

**Urgency:** one word, with a half-sentence if it needs one.

## Sessions

**Changed by:** https://claude.ai/code/session_… (pull request owner/repo#N)

**Asked by:** https://claude.ai/code/session_… (go back here with the result)

<details>
<summary>Background</summary>

- Everything else: how it was found, what Claude could not do and why,
  the exact names of projects, services and settings involved.

</details>
```

- **Steps are the issue**: one imperative action each, a blank line between
  every block, under about 120 words above `<details>`. Explanation goes
  inside `<details>`, collapsed. One issue, one thing to do.
- **The owner is not a developer.** Write in plain words what happens to
  the business, the site or the customer; literal text only in a command.
- `[YOU · DECIDE]` uses the same frame with `## Decide` (the options as a
  numbered list, the recommendation marked) in place of `## Do this`.
- **Anything in a browser is a Claude for Chrome script** inside the step,
  never a list of clicks: numbered steps, one action each, the address in
  every step that navigates, the exact on-screen words to expect, stop at
  the first step that misbehaves, nothing it must not touch, and a check of
  the deploy first when the step depends on one. It ends: "Give me step,
  pass or fail, and the exact wording of anything that failed. If every
  step passed, comment the results on <issue link> and close it; otherwise
  comment the failing step and leave it open. End the comment with: Report
  this back to <Asked by session link>."
- **A changed script is a new comment**, never an edit: headed
  `Updated script (<date>) — use this one`, holding the whole script. A
  "run it again" is a new comment too.
- **Commands for the owner** run on Windows in PowerShell and Command
  Prompt alike: full paths, no shell variables, no `&&`, no pipes.

### Link the session that asked

An issue alone does not say which conversation wants the answer, so every
one carries the session's link, and the owner can go back to that session
and report what was done.

- **Where the link comes from:** the `Claude-Session:` line of the commit
  attribution (`https://claude.ai/code/session_…`); if it is missing,
  `get_session` with no id gives the session id.
- **Every `[YOU]` and `[YOU · DECIDE]` issue has the `## Sessions` section**:
  **Changed by** (the session that made the change being checked, with its
  pull request) and **Asked by** (the session waiting for the result). When
  they are the same, one line: `**Session:** <link> (made the change and is
  waiting for the result)`.
- **Every comment that asks the owner to run a script** starts with
  `**Asked by:** <link>`; the newest comment's session is the one to go back
  to. A `[CLAUDE]` issue names the session that opened it the same way.
- A session that finds a result on an issue acts on it there, even when
  another session asked: the link is for the owner, not a lock.

### Close what is finished

Close an issue once the evidence is in (the owner's report, a script's
comment, output they pasted), with a one-line comment saying what proves
it; `not planned` when nothing was done. Never close on an assumption.
End every issue and comment with the Claude Code attribution footer.

## Worktrees & the ship rule

Claude Code can run parallel sessions in isolated **git worktrees** (`claude --worktree <name>`, or ask it to "work in a worktree" → the `EnterWorktree` tool). A worktree lives under `.claude/worktrees/<name>/` on branch `worktree-<name>`, branched **fresh from `origin/main`** by default (set `worktree.baseRef: "head"` in `.claude/settings.json` to carry local HEAD instead). `.claude/worktrees/` is gitignored; **`.worktreeinclude`** lists local files to copy into new worktrees — see those two files. `.venv` is *not* copied: recreate it per worktree (`python -m venv .venv && pip install -r requirements.txt && python -m playwright install chromium`).

A worktree sits on `worktree-<name>`, so a plain "commit + push" inside it pushes a feature branch, not `main`. When landing work from a worktree, follow this order:

1. **Commit, pause before landing.** Auto-commit finished work on the `worktree-<name>` branch, then **stop and report**. Never merge to / push `main` without the owner's explicit go-ahead. *(On `main` — the normal solo flow — the rule is unchanged: commit and push.)*
2. **Serialize landings — one at a time.** Never land two worktrees to `main` in parallel. If another worktree/session is still in flight, wait for it to land first. "Wait" means: at land time `git fetch` and rebase onto whatever `origin/main` now is; if the owner says another is mid-flight, hold until told it's done.
3. **Resolve conflicts in the worktree, never on `main`.** At land time: `git fetch origin` → **rebase `worktree-<name>` onto the latest `origin/main`** → resolve every conflict *there*, so `main` only ever receives an already-merged, clean tree.
4. **Finalize any release bump last.** This repo has no version files or SW cache — the collision-prone shared surfaces are `data/` (job/resource config), and any parser registry change in `scrape.py`. Reconcile those *after* the rebase, against current `main`.
5. **Re-verify + rebuild after resolving.** Run the test suite — **`pytest -q`** (the same check `tests.yml` runs) — after the rebase. If you touched scraping/parsing, run a job locally (`Start.bat`, or `ONLY_PROJECT_ID=<id> python scrape.py`) and check its findings. A conflict resolution that isn't re-verified is a bug waiting to ship.
6. **Only then land.** Fast-forward `main` to the clean, verified branch → `git push origin main`. This runs `tests.yml` (no deploy); the change takes effect wherever `main` is pulled and run. **Never push a conflicted or failing tree to `main`.**

For solo, single-stream work, **skip worktrees and work on `main` directly** — the rule needs no adaptation. Reserve worktrees for genuine parallelism (two tasks at once) or experiments you may not ship.
