# CLAUDE.md — caspian-scraper

A Python + Playwright scraper (`scrape.py`) plus a Next.js admin app (`web/`) that run **locally, with no sign-in and no Firestore**. Jobs and the shared resource library (the career sites to scrape) are JSON files in `data/` (committed); run results — runs, findings, lessons, logs — go to gitignored `local-data/`. Both sides read/write those files through matching layers, `localdb.py` and `web/lib/localdb.ts` (see `data/README.md`); keep them in sync. Jobs have no destinations: a run records every vacancy as a `found` finding for review and publishes nothing. **Find websites** (`find_websites.py`: Google Maps, Google/DuckDuckGo via an off-screen Playwright Chrome, Wikidata, OpenStreetMap — no keys, no AI) saves every company it finds to the committed findings database `db/companies.jsonl` (`findings_db.py`; add-only merges, one JSON line per company so git merges cleanly) — commit `db/` to share it. Tests run on every push/PR (`.github/workflows/tests.yml`, `pytest`).

## Ship mechanism

There is **no deploy**. `Start.bat` (repo root) runs a scrape and opens the admin app on its findings; `open-admin.bat` just starts the admin app (`next dev`, http://localhost:4444), whose *Run now* buttons start `scrape.py` on the same computer (`web/lib/localRunner.ts`). A change "ships" by merging to `main` and pulling it on the computer that runs it. The old Firestore cron (`.github/workflows/scrape-due.yml`) has its schedule disabled; `scrape.py` only uses Firestore if `GOOGLE_APPLICATION_CREDENTIALS[_JSON]` is set.

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
