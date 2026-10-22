"""AI tagging for the findings database — tag companies from criteria given in
plain words. Uses the AI provider + key saved in the admin app's Settings
(local-data/aiconfig_keys/local.json), or the AICONFIG_* environment.

Two steps, so a long run tags consistently and the person sees the tags first:

    plan    criteria in plain words → a few rules, each {tag, criteria}
            ("Priority": "training centres in the GCC that run HSE courses")
    apply   rules + company ids → the AI picks, per company, which rules it
            meets (only those tags — never new ones); saved with
            findings_db.retag_each. With "replace", a rule tag a company no
            longer meets is taken off; otherwise tags are only added.

    echo '{"criteria": "..."}' | python ai_tag.py --plan
    echo '{"rules": [...], "ids": [...], "replace": false}' | python ai_tag.py --apply

Companies go to the model in batches of BATCH, PARALLEL at a time. Each
batch answers through a tool call whose schema lists the allowed tags.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import findings_db as fdb
from aiconfig.providers import ProviderError, build_provider, default_provider_from_env

REPO_ROOT = Path(__file__).resolve().parent
BATCH = 25
PARALLEL = 4
MAX_RULES = 12
MAX_TOKENS = 8000

PLAN_TOOL = {
    "name": "save_rules",
    "description": "Save the tag rules that the person's criteria describe.",
    "input_schema": {
        "type": "object",
        "properties": {
            "rules": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "tag": {"type": "string", "description": "Short tag name, 1-3 words."},
                        "criteria": {
                            "type": "string",
                            "description": "When a company gets this tag, precise and self-contained.",
                        },
                    },
                    "required": ["tag", "criteria"],
                },
            },
            "note": {
                "type": "string",
                "description": "Optional: anything ambiguous in the criteria and how you read it.",
            },
        },
        "required": ["rules"],
    },
}

PLAN_SYSTEM = """You turn a person's tagging criteria, written in plain words, into tag rules \
for a database of companies. Each company has a name, website, description, countries and \
categories (e.g. "Training center", "oil company").

Write one rule per tag: a short tag name (1-3 words) and a precise criterion that someone \
could check for a single company. Use the tag names the person gave, spelled as they wrote \
them. If they gave none, choose short clear names; when an existing tag means the same \
thing, use it exactly. At most {max_rules} rules. Do not add rules the person didn't ask for.

Existing tags in the database: {existing}

Call save_rules once."""

APPLY_SYSTEM = """You tag companies by rules. The rules:

{rules}

For every company you are given, list each tag whose rule it clearly meets, judging from \
its details and what you reliably know about the company. When unsure, leave the tag off. \
A company may get several tags or none. Use only the tag names above, exactly.

Call assign_tags once, with one entry for every company id you were given."""


# ---- provider -------------------------------------------------------------------

def _saved_settings() -> dict:
    """The admin app's saved provider settings (Settings → AI provider & key)."""
    try:
        import localdb
        snap = localdb.LocalDB().collection("aiconfig_keys").document("local").get()
        return (snap.to_dict() or {}) if snap.exists else {}
    except Exception:  # noqa: BLE001 — no saved settings is a normal state
        return {}


def get_provider():
    """The provider from Settings, else from the environment. Raises
    ProviderError with a message the app can show when there is none."""
    kd = _saved_settings()
    key = str(kd.get("value") or "").strip()
    if key:
        return build_provider(str(kd.get("provider") or "anthropic"), api_key=key,
                              model=str(kd.get("model") or ""),
                              base_url=str(kd.get("base_url") or ""))
    try:
        return default_provider_from_env()
    except ProviderError:
        raise ProviderError("No AI provider key is set. Add one in Settings → AI provider & key.")


def _call(provider, system: str, user: str, tool: dict) -> tuple[dict, float]:
    """One forced tool call; returns (tool input, estimated cost). Falls back to
    JSON in the text for models that answer without calling the tool."""
    resp = provider.complete(system=system, tools=[tool], history=[{"role": "user", "text": user}],
                             max_tokens=MAX_TOKENS)
    for tc in resp.tool_calls:
        if tc.name == tool["name"]:
            return tc.input, resp.cost_usd
    m = re.search(r"\{.*\}", resp.text or "", re.S)
    if m:
        try:
            return json.loads(m.group(0)), resp.cost_usd
        except ValueError:
            pass
    raise ProviderError("the model didn't return an answer in the expected form")


# ---- plan ------------------------------------------------------------------------

def plan(criteria: str, provider=None) -> dict:
    """Criteria in plain words → {"rules": [{tag, criteria}], "note", "cost_usd"}."""
    criteria = criteria.strip()
    if not criteria:
        raise ValueError("describe how to tag first")
    provider = provider or get_provider()
    existing = sorted({t for r in fdb.load().values() for t in r.get("tags") or []}, key=str.casefold)
    system = PLAN_SYSTEM.format(max_rules=MAX_RULES, existing=", ".join(existing[:200]) or "(none)")
    out, cost = _call(provider, system, criteria, PLAN_TOOL)
    rules, seen = [], set()
    for r in out.get("rules") or []:
        if not isinstance(r, dict):
            continue
        tag, crit = fdb.clean_tag(r.get("tag") or ""), str(r.get("criteria") or "").strip()
        if tag and crit and tag.casefold() not in seen:
            seen.add(tag.casefold())
            rules.append({"tag": tag, "criteria": crit[:500]})
    if not rules:
        raise ProviderError("the model found no tags in those criteria — try naming the tags you want")
    return {"rules": rules[:MAX_RULES], "note": str(out.get("note") or "").strip(), "cost_usd": cost}


# ---- apply -----------------------------------------------------------------------

def _company_line(rec: dict) -> dict:
    """What the model sees about one company — compact."""
    out = {"id": rec["id"], "name": rec.get("name") or rec["id"]}
    for k in ("website", "description"):
        if rec.get(k):
            out[k] = str(rec[k])[:300]
    for k in ("countries", "types", "industries"):
        if rec.get(k):
            out[k] = rec[k][:6]
    return out


def _assign_tool(tags: list[str]) -> dict:
    return {
        "name": "assign_tags",
        "description": "Record which tags each company gets.",
        "input_schema": {
            "type": "object",
            "properties": {
                "results": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string", "enum": tags}},
                        },
                        "required": ["id", "tags"],
                    },
                }
            },
            "required": ["results"],
        },
    }


def _tag_batch(provider, system: str, tool: dict, recs: list[dict],
               allowed: dict[str, str]) -> tuple[dict[str, list[str]], float]:
    """{id: [tags]} for one batch (canonical spellings, allowed tags only).
    Retries once for any ids the model skipped."""
    got: dict[str, list[str]] = {}
    cost = 0.0
    todo = recs
    for _ in range(2):
        user = "Companies (one JSON object per line):\n" + "\n".join(
            json.dumps(_company_line(r), ensure_ascii=False) for r in todo)
        out, c = _call(provider, system, user, tool)
        cost += c
        ids = {r["id"] for r in todo}
        for item in out.get("results") or []:
            if not isinstance(item, dict) or str(item.get("id")) not in ids:
                continue
            tags = [allowed[t.casefold()] for t in item.get("tags") or []
                    if isinstance(t, str) and t.casefold() in allowed]
            got[str(item["id"])] = list(dict.fromkeys(tags))
        todo = [r for r in todo if r["id"] not in got]
        if not todo:
            break
    return got, cost


def apply(rules: list[dict], ids: list[str], *, replace: bool = False, provider=None) -> dict:
    """Tag the given companies by the rules and save. Returns {"tags": {id:
    [all its tags]}, "counts": {tag: n}, "tagged", "skipped", "errors",
    "cost_usd"}."""
    rules = [{"tag": fdb.clean_tag(r.get("tag") or ""), "criteria": str(r.get("criteria") or "").strip()}
             for r in rules if isinstance(r, dict)]
    rules = [r for r in rules if r["tag"] and r["criteria"]][:MAX_RULES]
    if not rules:
        raise ValueError("no tag rules to apply")
    provider = provider or get_provider()
    records = fdb.load()
    recs = [records[i] for i in dict.fromkeys(ids) if i in records]
    allowed = {r["tag"].casefold(): r["tag"] for r in rules}
    system = APPLY_SYSTEM.format(rules="\n".join(f"- {r['tag']}: {r['criteria']}" for r in rules))
    tool = _assign_tool([r["tag"] for r in rules])

    batches = [recs[i:i + BATCH] for i in range(0, len(recs), BATCH)]
    results: dict[str, list[str]] = {}
    errors: list[str] = []
    cost = 0.0

    def run(batch):
        try:
            return _tag_batch(provider, system, tool, batch, allowed), None
        except Exception as e:  # noqa: BLE001 — one failed batch shouldn't lose the others
            return ({}, 0.0), f"{type(e).__name__}: {e}"[:300]

    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        for (got, c), err in pool.map(run, batches):
            results.update(got)
            cost += c
            if err:
                errors.append(err)

    rule_tags = [r["tag"] for r in rules]
    changes = {cid: (tags, [t for t in rule_tags if t not in tags] if replace else [])
               for cid, tags in results.items()}
    saved = fdb.retag_each(changes) if changes else {}
    counts = {t: sum(t in tags for tags in results.values()) for t in rule_tags}
    return {
        "tags": saved,
        "counts": counts,
        "tagged": sum(bool(t) for t in results.values()),
        "checked": len(results),
        "skipped": len(recs) - len(results),
        "errors": errors,
        "cost_usd": round(cost, 4),
    }


# ---- CLI -------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true", help='read {"criteria": "..."} on stdin')
    g.add_argument("--apply", action="store_true",
                   help='read {"rules": [...], "ids": [...], "replace": false} on stdin')
    args = ap.parse_args(argv)
    req = json.loads(sys.stdin.read() or "{}")
    try:
        if args.plan:
            out = plan(str(req.get("criteria") or ""))
        else:
            out = apply(req.get("rules") or [], [str(i) for i in req.get("ids") or []],
                        replace=bool(req.get("replace")))
    except (ProviderError, ValueError) as e:
        # A clear message for the app (exit 0 so it isn't shown as a crash).
        out = {"error": str(e)}
    # ASCII-only JSON: Windows pipes use the console code page, not UTF-8.
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
