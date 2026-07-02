# CLAUDE.md — caspian-scraper

A daily Python + Playwright scraper (`scrape.py`) that finds HSE job postings on the employer career sites listed in `employers.json` and POSTs each new one to the entirelysafe.com REST API. It runs as a GitHub Actions cron (`.github/workflows/scrape.yml`, 04:30 UTC + manual dispatch); tests run on every push/PR (`.github/workflows/tests.yml`, `pytest`).

## Ship mechanism

There is **no production deploy on push to `main`**. Push/PR only triggers `tests.yml` (`pytest -q`) — a check, not a release. The scraper "goes live" on its own schedule: the `scrape.yml` cron job (and manual *Run workflow*) runs `python scrape.py`, which publishes vacancies to the entirelysafe.com API and commits `docs/data.json` back to `main`. So a normal code change ships by **merging to `main` and letting the next scheduled run (or a manual dispatch) pick it up** — pushing to `main` itself deploys nothing and only runs the test suite.

## Worktrees & the ship rule

Claude Code can run parallel sessions in isolated **git worktrees** (`claude --worktree <name>`, or ask it to "work in a worktree" → the `EnterWorktree` tool). A worktree lives under `.claude/worktrees/<name>/` on branch `worktree-<name>`, branched **fresh from `origin/main`** by default (set `worktree.baseRef: "head"` in `.claude/settings.json` to carry local HEAD instead). `.claude/worktrees/` is gitignored and **`.worktreeinclude`** copies any local secrets (a `.env` holding `ENTIRELYSAFE_API_KEY`) into new worktrees — see those two files. `.venv` is *not* copied: recreate it per worktree (`python -m venv .venv && pip install -r requirements.txt && python -m playwright install chromium`).

A worktree sits on `worktree-<name>`, so a plain "commit + push" inside it pushes a feature branch, not `main`. When landing work from a worktree, follow this order:

1. **Commit, pause before landing.** Auto-commit finished work on the `worktree-<name>` branch, then **stop and report**. Never merge to / push `main` without the owner's explicit go-ahead. *(On `main` — the normal solo flow — the rule is unchanged: commit and push.)*
2. **Serialize landings — one at a time.** Never land two worktrees to `main` in parallel. If another worktree/session is still in flight, wait for it to land first. "Wait" means: at land time `git fetch` and rebase onto whatever `origin/main` now is; if the owner says another is mid-flight, hold until told it's done.
3. **Resolve conflicts in the worktree, never on `main`.** At land time: `git fetch origin` → **rebase `worktree-<name>` onto the latest `origin/main`** → resolve every conflict *there*, so `main` only ever receives an already-merged, clean tree.
4. **Finalize any release bump last.** This repo has no version files or SW cache — the collision-prone shared surfaces are `employers.json`, `docs/data.json` (rewritten by the cron, so avoid hand-editing it in a worktree), and any parser registry change in `scrape.py`. Reconcile those *after* the rebase, against current `main`.
5. **Re-verify + rebuild after resolving.** Run the test suite — **`pytest -q`** (the same check `tests.yml` runs) — after the rebase. If you touched scraping/parsing, do a local dry run of `python scrape.py` (a `.env` with `ENTIRELYSAFE_API_KEY` is required; a re-run right after a successful run should report `"published": 0`). A conflict resolution that isn't re-verified is a bug waiting to ship.
6. **Only then land.** Fast-forward `main` to the clean, verified branch → `git push origin main`. This runs `tests.yml` (no deploy). The change goes live on the next scheduled `scrape.yml` cron run, or immediately via **Actions → HSE scrape → Run workflow**. **Never push a conflicted or failing tree to `main`.**

For solo, single-stream work, **skip worktrees and work on `main` directly** — the rule needs no adaptation. Reserve worktrees for genuine parallelism (two tasks at once) or experiments you may not ship.
