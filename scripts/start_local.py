"""Interactive local scraper run, launched by Start.bat in the repo root.

Asks which job (project) to run and whether to publish, runs scrape.main()
for each chosen job, then writes the admin-app path to review (the job's
Runs tab) to the file named by argv[1], for Start.bat to open.

Credentials: service-account.json in the repo root (gitignored), unless
GOOGLE_APPLICATION_CREDENTIALS[_JSON] is already set.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

KEY_FILE = REPO_ROOT / "service-account.json"


def ask(prompt: str, default: str) -> str:
    try:
        answer = input(prompt).strip()
    except EOFError:
        answer = ""
    return answer or default


def main() -> int:
    review_file = Path(sys.argv[1]) if len(sys.argv) > 1 else None

    if not (
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
        or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    ):
        if not KEY_FILE.exists():
            print(
                f"Missing {KEY_FILE.name} in the repo root.\n"
                "Copy your Firebase service-account key file (Firebase console ->\n"
                "Project settings -> Service accounts -> Generate new private key)\n"
                f"to:\n  {KEY_FILE}"
            )
            return 1
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(KEY_FILE)
    os.environ.setdefault("FIRESTORE_DATABASE_ID", "scraper")

    import scrape  # noqa: E402 — needs the env above

    try:
        db = scrape.get_db()
        jobs = sorted(
            (scrape._doc_with_id(d) for d in db.collection("projects").stream()),
            key=lambda j: str(j.get("name") or j["__id"]).lower(),
        )
    except Exception as e:
        print(f"Could not reach Firestore: {type(e).__name__}: {e}")
        return 1

    if not jobs:
        print("No jobs yet - create one in the admin app first.")
        return 1

    print("\nJobs:")
    for i, j in enumerate(jobs, 1):
        state = "" if j.get("enabled", True) else "  (paused)"
        print(f"  {i}. {j.get('name') or j['__id']}{state}")
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

    print(
        "\n  1. Dry run  - scrape and record a run you can review; publish nothing\n"
        "  2. Real run - scrape and publish new vacancies to the destinations"
    )
    mode = ask("Choose 1 or 2 [1]: ", "1")
    if mode not in ("1", "2"):
        print(f"'{mode}' is not 1 or 2.")
        return 1
    dry_run = mode == "1"
    if not dry_run:
        names = ", ".join(str(j.get("name") or j["__id"]) for j in chosen)
        if ask(f"Publish for: {names}? Type YES to confirm: ", "") != "YES":
            print("Cancelled - nothing was run.")
            return 1

    os.environ["DRY_RUN"] = "true" if dry_run else "false"
    os.environ.pop("REQUEST_ID", None)
    worst = 0
    for j in chosen:
        print(f"\n--- {j.get('name') or j['__id']} ({'dry run' if dry_run else 'publishing'}) ---")
        os.environ["ONLY_PROJECT_ID"] = j["__id"]
        worst = max(worst, scrape.main())

    if review_file:
        path = f"projects/{chosen[0]['__id']}/runs" if len(chosen) == 1 else ""
        review_file.write_text(path, encoding="utf-8")
    return worst


if __name__ == "__main__":
    sys.exit(main())
