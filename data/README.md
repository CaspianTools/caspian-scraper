# data/ — scraper configuration (committed)

The scraper and its admin app run locally with no database server and no
sign-in. Everything they store is plain JSON files, one per record:

| Folder | What | In git? |
| --- | --- | --- |
| `data/projects/<id>.json` | jobs | yes |
| `data/projects/<id>/sources/<id>.json` | a job's own sources | yes |
| `data/resources/<id>.json` | the shared resource library | yes |
| `data/{comparison,car,generic}_sources/` | other scraper sources | yes |
| `local-data/` | runs, findings, lessons, listings, logs, and each config record's `last_run_*` fields | no — this computer only |

So **jobs and resources travel with the repo**: create or edit them in the
admin app, commit `data/`, and every computer that pulls gets the same setup.
What a run *finds* stays on the computer that ran it.

You don't edit these files by hand — use the admin app (`open-admin.bat`), or
`Start.bat` to run a scrape and review it. Both read and write the files
through the same small layer: `localdb.py` (scraper) and `web/lib/localdb.ts`
(admin app), which must agree on this layout.

If two people change the same record on different computers, git shows a
normal merge conflict in that one file; resolve it like any other JSON edit.
