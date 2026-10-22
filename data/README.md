# data/ — scraper configuration (committed)

The scraper and its admin app run locally with no database server and no
sign-in. Everything they store is plain JSON files, one per record:

| Folder | What | In git? |
| --- | --- | --- |
| `data/projects/<id>.json` | jobs | yes |
| `data/projects/<id>/sources/<id>.json` | a job's own sources | yes |
| `data/resources/<id>.json` | the shared resource library | yes |
| `data/{comparison,car,generic}_sources/` | a job's classifieds, shop and website sources (`project_id` = the job) | yes |
| `data/databases/<id>.json` | databases (name, record name, key) | yes |
| `db/<id>.jsonl` | a database's records, one per line (exported from the SQLite store) | yes |
| `local-data/scraper.db` | SQLite record store: databases' working copy + each job's results | no — this computer only |
| `local-data/` | runs, engine records, lessons, logs, and each config record's `last_run_*` fields | no — this computer only |

So **jobs, sources and databases travel with the repo**: create or edit them
in the admin app, commit `data/` and `db/`, and every computer that pulls
gets the same setup and the same databases. A job's own results stay on the
computer that ran it — save them into a database to share them.

You don't edit these files by hand — use the admin app (`open-admin.bat`), or
`Start.bat` to run a scrape and review it. Both read and write the files
through the same small layer: `localdb.py` (scraper) and `web/lib/localdb.ts`
(admin app), which must agree on this layout.

If two people change the same record on different computers, git shows a
normal merge conflict in that one file; resolve it like any other JSON edit.
