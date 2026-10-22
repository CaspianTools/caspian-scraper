"""Relevance of a job's records — how well each one matches what the job is
about, 0-100, so the Results page can hide the noise (below the job's
`relevance.cutoff`).

    keyword rules   the job's `relevance` settings: {include, exclude, cutoff,
                    use_ai}. Words and phrases match whole words in the
                    record's text (title, name, company, description, types,
                    categories, tags, any other text field), case- and
                    width-insensitive (NFKC + casefold); a simple plural
                    matches too ("school" ≈ "schools"), and a trailing * makes
                    a prefix ("train*" ≈ "training", "trainer").
                        an exclude word        0 in the title, else 10
                        include hits           1 → 70, 2 → 85, then +5 each;
                                               a hit in the title/name counts
                                               double
                        neither                40 — "borderline"
                        only exclude words set and none hit → 70
                    No words at all: records stay unscored.
    AI (optional)   with `relevance.use_ai` and the job's `use_ai` on, the
                    borderline records (30-60) go to the AI provider from
                    Settings (ai_tag.get_provider), BATCH per tool call, until
                    the estimated cost reaches the job's `ai_spend_cap` (USD
                    per run, 0 = no cap). Answers are cached per record +
                    rules (store "relevance-ai:<job>"), so a record is asked
                    about once, not every run. An AI error never fails the
                    run: the keyword score stays.

Scores are written to the job's store (job:<id>, recordstore.py) as
`relevance` + `relevance_why`; job_results.collect() keeps them across runs.
scrape.collect_job() calls score_job() after every run; rescore on demand
(after the rules change):

    python relevance.py --job <id>
    echo '{"project": "<id>"}' | python relevance.py      → {"scored": n, ...}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from typing import Any

import recordstore

BATCH = 25
BORDERLINE = (30, 60)
NEUTRAL = 40
MAX_TERMS = 100

# Fields that aren't the record's content (bookkeeping, links, our own output).
_SKIP_FIELDS = {"id", "url", "website", "careers_url", "image", "source_id", "engine", "status",
                "fingerprint", "first_seen", "last_seen", "relevance", "relevance_why", "hidden",
                "checked_at", "updated_at", "posted", "currency", "ats", "reachable", "raw"}
_TITLE_FIELDS = ("title", "name")

_WORD = re.compile(r"\w+(?:\*)?", re.UNICODE)


# ---- matching ------------------------------------------------------------------

def fold(s: str) -> str:
    """Unicode-aware lowercase: NFKC (full-width, ligatures) + casefold (ß → ss)."""
    return unicodedata.normalize("NFKC", str(s or "")).casefold()


def tokens(s: str) -> list[str]:
    return [t for t in _WORD.findall(fold(s)) if t != "*"]


def _word_forms(w: str) -> tuple[set[str], str]:
    """(exact forms, prefix) a rule word matches: itself + a simple plural, or
    a prefix when it ends with *."""
    if w.endswith("*"):
        return set(), w[:-1]
    forms = {w}
    if len(w) >= 3 and w.isalpha():
        forms |= {w + "s", w + "es"}
        if w.endswith("y"):
            forms.add(w[:-1] + "ies")
        if w.endswith("ies") and len(w) > 4:
            forms.add(w[:-3] + "y")
        elif w.endswith("s") and not w.endswith("ss") and len(w) > 3:
            forms.add(w[:-1])
    return forms, ""


def _compile(term: str):
    """A rule term → list of (forms, prefix) per word, or None if empty."""
    words = tokens(term)
    if not words:
        return None
    return [_word_forms(w) for w in words]


def _matches(compiled, toks: list[str]) -> bool:
    n = len(compiled)
    for i in range(len(toks) - n + 1):
        for (forms, prefix), t in zip(compiled, toks[i:i + n]):
            if not (t in forms or (prefix and t.startswith(prefix))):
                break
        else:
            return True
    return False


def _terms(v: Any) -> list[str]:
    if isinstance(v, str):
        v = re.split(r"[,\n;]", v)
    if not isinstance(v, (list, tuple)):
        return []
    out = [str(x).strip() for x in v if isinstance(x, (str, int, float)) and str(x).strip()]
    return list(dict.fromkeys(out))[:MAX_TERMS]


def _texts(record: dict) -> tuple[list[str], list[str]]:
    """(title/name text, every other text) of a record."""
    title, rest = [], []
    for k, v in record.items():
        if k in _SKIP_FIELDS or k.startswith("_"):
            continue
        vals = v if isinstance(v, list) else [v]
        strs = [str(x) for x in vals if isinstance(x, str) and x.strip()]
        (title if k in _TITLE_FIELDS else rest).extend(strs)
    return title, rest


def _lines(texts: list[str]) -> list[list[str]]:
    # One token list per value, so a phrase can't straddle two fields.
    return [tokens(t) for t in texts]


def _hit(compiled, lines: list[list[str]]) -> bool:
    return any(_matches(compiled, toks) for toks in lines)


def score(record: dict, rules: dict | None) -> tuple[int, str] | None:
    """(0-100, why) for one record against {include, exclude}, or None when
    there are no rules."""
    rules = rules or {}
    include = [(t, c) for t in _terms(rules.get("include")) if (c := _compile(t))]
    exclude = [(t, c) for t in _terms(rules.get("exclude")) if (c := _compile(t))]
    if not include and not exclude:
        return None
    title, rest = _texts(record)
    t_lines, r_lines = _lines(title), _lines(rest)

    ex_title = [t for t, c in exclude if _hit(c, t_lines)]
    if ex_title:
        return 0, f"excluded: {', '.join(ex_title[:3])} (in the title)"
    ex_rest = [t for t, c in exclude if _hit(c, r_lines)]
    if ex_rest:
        return 10, f"excluded: {', '.join(ex_rest[:3])}"

    in_title = [t for t, c in include if _hit(c, t_lines)]
    in_rest = [t for t, c in include if t not in in_title and _hit(c, r_lines)]
    weight = 2 * len(in_title) + len(in_rest)
    if weight:
        s = 70 if weight == 1 else min(100, 85 + 5 * (weight - 2))
        parts = []
        if in_title:
            parts.append(f"{', '.join(in_title[:4])} (in the title)")
        if in_rest:
            parts.append(", ".join(in_rest[:4]))
        return s, "matches: " + "; ".join(parts)
    if not include:
        return 70, "no exclude words"
    return NEUTRAL, "borderline: none of the include words"


# ---- AI for borderline records -----------------------------------------------------

AI_TOOL = {
    "name": "rate_relevance",
    "description": "Record how relevant each record is to the job.",
    "input_schema": {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "score": {"type": "integer", "minimum": 0, "maximum": 100,
                                  "description": "0 = clearly not what the job wants, 100 = exactly it."},
                        "reason": {"type": "string", "description": "A few words why."},
                    },
                    "required": ["id", "score"],
                },
            }
        },
        "required": ["results"],
    },
}

AI_SYSTEM = """You judge how relevant records collected by a scraping job are to what the job \
is looking for.

The job: {name}
What it wants: {description}
Words that make a record relevant: {include}
Words that make a record irrelevant: {exclude}

For every record, give a relevance score from 0 (clearly not what the job wants) to 100 \
(exactly what it wants), judging from its details and what you reliably know about it, \
and a few words why. Be strict: a record merely sharing a word with the job is not \
relevant if it is a different kind of thing.

Call rate_relevance once, with one entry for every record id you were given."""

# Fields the model doesn't need to judge a record.
_AI_HIDDEN = {"fingerprint", "relevance_why", "source_id", "engine", "status", "image"}


def _ai_line(rec: dict) -> dict:
    import ai_tag

    line = ai_tag._company_line(rec)
    return {k: v for k, v in line.items() if k not in _AI_HIDDEN}


def _ai_key(rec: dict, rules: dict, proj: dict) -> str:
    """Changes when the record's content, the rules or the job's description do."""
    content = rec.get("fingerprint") or json.dumps(_ai_line(rec), sort_keys=True, default=str)
    basis = json.dumps([content, _terms(rules.get("include")), _terms(rules.get("exclude")),
                        str(proj.get("description") or ""), str(proj.get("name") or "")],
                       sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


def ai_store_of(project_id: str) -> str:
    return f"relevance-ai:{project_id}"


def ai_scores(recs: list[dict], rules: dict, proj: dict, *, provider=None,
              cap: float = 0.0) -> dict:
    """Ask the AI about these records, BATCH per call, until the estimated
    cost reaches `cap` (0 = no cap). Returns {"scores": {id: (score, why)},
    "cost_usd", "errors", "stopped"}. Never raises."""
    import ai_tag

    out: dict = {"scores": {}, "cost_usd": 0.0, "errors": [], "stopped": False}
    if not recs:
        return out
    try:
        provider = provider or ai_tag.get_provider()
    except Exception as e:  # noqa: BLE001 — no key: keep the keyword scores
        out["errors"].append(f"{type(e).__name__}: {e}"[:300])
        return out
    system = AI_SYSTEM.format(
        name=str(proj.get("name") or "(unnamed)"),
        description=str(proj.get("description") or "").strip() or "(no description - go by the words)",
        include=", ".join(_terms(rules.get("include"))) or "(none)",
        exclude=", ".join(_terms(rules.get("exclude"))) or "(none)",
    )
    batches = [recs[i:i + BATCH] for i in range(0, len(recs), BATCH)]
    spent, done = 0.0, 0
    for batch in batches:
        # Stop before a batch that would (by the average so far) pass the cap.
        per_batch = spent / done if done else 0.0
        if cap > 0 and spent + per_batch > cap:
            out["stopped"] = True
            break
        user = "Records (one JSON object per line):\n" + "\n".join(
            json.dumps(_ai_line(r), ensure_ascii=False) for r in batch)
        try:
            answer, cost = ai_tag._call(provider, system, user, AI_TOOL)
        except Exception as e:  # noqa: BLE001 — one failed batch shouldn't lose the rest
            out["errors"].append(f"{type(e).__name__}: {e}"[:300])
            done += 1
            continue
        spent += float(cost or 0.0)
        done += 1
        ids = {r["id"] for r in batch}
        for item in answer.get("results") or []:
            if not isinstance(item, dict) or str(item.get("id")) not in ids:
                continue
            try:
                s = max(0, min(100, int(round(float(item.get("score"))))))
            except (TypeError, ValueError):
                continue
            reason = " ".join(str(item.get("reason") or "").split())[:200]
            out["scores"][str(item["id"])] = (s, f"AI: {reason}" if reason else "AI")
    out["cost_usd"] = round(spent, 4)
    return out


# ---- a job -----------------------------------------------------------------------

def rescore(project_id: str, proj: dict | None, *, provider=None) -> dict:
    """Score every record of the job; write the changed ones. Returns
    {"scored", "changed", "ai_checked", "cost_usd", "errors"}."""
    proj = proj or {}
    rules = proj.get("relevance") if isinstance(proj.get("relevance"), dict) else {}
    result = {"scored": 0, "changed": 0, "ai_checked": 0, "cost_usd": 0.0, "errors": []}
    if not _terms(rules.get("include")) and not _terms(rules.get("exclude")):
        return result  # no rules: leave the records alone

    store = f"job:{project_id}"  # = job_results.store_of
    recs = recordstore.load(store)
    scored: dict[str, tuple[int, str]] = {}
    for rid, rec in recs.items():
        s = score(rec, rules)
        if s is not None:
            scored[rid] = s

    if rules.get("use_ai") is True and proj.get("use_ai") is True:
        lo, hi = BORDERLINE
        border = [recs[i] for i, (s, _) in scored.items() if lo <= s <= hi]
        ai_store = ai_store_of(project_id)
        cache = recordstore.load(ai_store)
        keys = {r["id"]: _ai_key(r, rules, proj) for r in border}
        ask = []
        for r in border:
            hit = cache.get(r["id"])
            if hit and hit.get("key") == keys[r["id"]] and isinstance(hit.get("score"), int):
                scored[r["id"]] = (hit["score"], str(hit.get("why") or "AI"))
            else:
                ask.append(r)
        try:
            cap = float(proj.get("ai_spend_cap") or 0)
        except (TypeError, ValueError):
            cap = 0.0
        ai = ai_scores(ask, rules, proj, provider=provider, cap=cap)
        scored.update(ai["scores"])
        result.update(ai_checked=len(ai["scores"]), cost_usd=ai["cost_usd"], errors=ai["errors"])
        if ai["stopped"]:
            result["errors"].append(f"AI stopped at the spend cap (${cap:g}); "
                                    f"{len(ask) - len(ai['scores'])} borderline records kept their keyword score")
        if ai["scores"]:
            try:
                recordstore.write(ai_store, {i: {"id": i, "key": keys[i], "score": s, "why": w}
                                             for i, (s, w) in ai["scores"].items()})
            except Exception as e:  # noqa: BLE001 — a lost cache only costs a re-ask
                result["errors"].append(f"{type(e).__name__}: {e}"[:300])
        for err in result["errors"]:
            print(f"relevance AI ({project_id}): {err}", file=sys.stderr)

    upserts = {}
    for rid, (s, why) in scored.items():
        rec = recs[rid]
        if rec.get("relevance") != s or rec.get("relevance_why") != why:
            upserts[rid] = {**rec, "relevance": s, "relevance_why": why}
    if upserts:
        recordstore.write(store, upserts)
    result["scored"] = len(scored)
    result["changed"] = len(upserts)
    return result


def score_job(project_id: str, proj: dict | None, *, provider=None) -> int:
    """Score the job's records (scrape.collect_job calls this after a run).
    Returns how many were scored; 0 and nothing touched when the job has no
    relevance rules."""
    return rescore(project_id, proj, provider=provider)["scored"]


# ---- CLI -------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Rescore a job's records against its relevance rules.")
    ap.add_argument("--job", default="", help='the job id (else read {"project": "<id>"} on stdin)')
    args = ap.parse_args(argv)
    project_id = args.job.strip()
    if not project_id:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        try:
            req = json.loads(raw or "{}")
        except ValueError:
            req = {}
        project_id = str((req or {}).get("project") or "").strip()
    try:
        if not project_id:
            raise ValueError("which job? pass --job <id> or {\"project\": \"<id>\"}")
        from scrape import get_db, load_project

        proj = load_project(get_db(), project_id)
        if proj is None:
            raise ValueError(f"no job {project_id!r}")
        out: dict = rescore(project_id, proj)
    except ValueError as e:
        out = {"error": str(e)}
    # ASCII-only JSON: Windows pipes use the console code page, not UTF-8.
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
