# db/ — the findings database (committed)

Everything **Find websites** discovers is saved here, so the database gets
richer with every search on every computer, and travels with `git pull`.

| File | Contents |
| --- | --- |
| `companies.jsonl` | one company per line, sorted by `id` (its website domain) |
| `people.jsonl` | reserved for people (contacts, recruiters, …) — not filled yet |

The format and merge rules are documented at the top of
[`findings_db.py`](../findings_db.py). In short: records are only ever added
to — lists are combined, empty fields filled, and a newer careers-page check
replaces an older one.

It's plain JSON Lines (not a binary database) so git can merge additions from
different computers line by line. **Commit `db/` after searching** to share
what you found. Don't hand-edit unless you need to; if a merge conflict shows
up, keep both lines' information.
