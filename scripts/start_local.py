"""Interactive local scraper run, launched by Start.bat in the repo root.

Asks which job (project) to run, runs scrape.main() for each chosen job
against the local data files (localdb.py — no Firestore, nothing is
published), then writes the admin-app page to review to the file named by
argv[1], for Start.bat to open: the job's Findings, or the New-job wizard
when there are no jobs yet.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

# Local mode only: never let a stray credential switch the run to Firestore.
os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS_JSON", None)
os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)

import scrape  # noqa: E402


def ask(prompt: str, default: str) -> str:
    try:
        answer = input(prompt).strip()
    except EOFError:
        answer = ""
    return answer or default


def write_review(review_file: Path | None, page: str) -> None:
    if review_file:
        review_file.write_text(page, encoding="utf-8")


# Templates a job was made from (web/lib/jobTemplates.ts), for the list.
TEMPLATE_LABEL = {"vacancies": "Vacancies", "cars": "Car listings", "prices": "Product prices", "blank": "Blank"}


def review_page(job: dict) -> str:
    """A job opens on its Results."""
    return f"projects/{job['__id']}"


def main() -> int:
    review_file = Path(sys.argv[1]) if len(sys.argv) > 1 else None

    db = scrape.get_db()
    jobs = sorted(
        (scrape._doc_with_id(d) for d in db.collection("projects").stream()),
        key=lambda j: str(j.get("name") or j["__id"]).lower(),
    )
    if not jobs:
        print("No jobs yet - opening the admin app so you can create one.")
        write_review(review_file, "projects/new")
        return 0

    print("\nJobs:")
    for i, j in enumerate(jobs, 1):
        state = "" if j.get("enabled", True) else "  (paused)"
        tpl = TEMPLATE_LABEL.get(scrape.job_template(j), "")
        print(f"  {i}. {j.get('name') or j['__id']}  [{tpl}]{state}")
    pick = ask("\nWhich job? Number, or Enter for all enabled jobs: ", "")
    if pick:
        try:
            chosen = [jobs[int(pick) - 1]]
        except (ValueError, IndexError):
            print(f"'{pick}' is not one of the numbers above.")
            return 1
    else:
        chosen = [j for j in jobs if j.get("enabled", True)]
        if not chosen:
            print("All jobs are paused - pick one by number instead.")
            return 1

    os.environ["DRY_RUN"] = "false"
    os.environ.pop("REQUEST_ID", None)
    worst = 0
    for j in chosen:
        print(f"\n--- Scraping: {j.get('name') or j['__id']} ---")
        os.environ["ONLY_PROJECT_ID"] = j["__id"]
        worst = max(worst, scrape.main())

    write_review(review_file, review_page(chosen[0]) if len(chosen) == 1 else "")
    return worst


if __name__ == "__main__":
    sys.exit(main())
