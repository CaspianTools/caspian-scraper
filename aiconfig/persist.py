"""Build and write a /generic_sources doc from an approved AgentResult.

Mirrors web/lib/firestore/schema.ts → GenericSourceCreateSchema /
GenericSourceDocSchema. Config-strategy sources are written active:true (the
cron picks them up on the next tick); adapter-strategy sources are written
active:false (they can't run until the generated module is merged to main).
"""

from __future__ import annotations

import re
from typing import Any


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s or "source"


def parse_schema_hint(hint: str) -> list[dict]:
    """Parse 'title:string*,deadline:string,amount:number' into field specs.
    A trailing '*' on the name or type marks the field required."""
    out: list[dict] = []
    for part in (hint or "").split(","):
        part = part.strip()
        if not part:
            continue
        required = part.endswith("*")
        part = part.rstrip("*")
        name, _, typ = part.partition(":")
        name = re.sub(r"[^a-z0-9_]+", "_", name.strip().lower()).strip("_")
        if not name:
            continue
        typ = (typ.strip().lower().rstrip("*") or "string")
        if typ not in ("string", "number", "bool", "url"):
            typ = "string"
        out.append({"name": name, "type": typ, "required": required})
    return out


def _required_field_names(extraction: dict) -> set[str]:
    req: set[str] = set()
    for ex in (extraction or {}).get("extractors") or []:
        if isinstance(ex, dict) and ex.get("type") == "fields":
            rf = ex.get("required_fields")
            if isinstance(rf, list):
                req.update(str(r) for r in rf)
            elif isinstance(ex.get("fields"), dict):
                req.update(str(k) for k in ex["fields"].keys())
    return req


def build_record_schema(
    output_schema: list[str], extraction: dict, hint: str = ""
) -> list[dict]:
    """Prefer the AI's output_schema; fall back to the parsed hint. Mark fields
    required when the extraction's required_fields lists them."""
    required = _required_field_names(extraction)
    names = list(output_schema) if output_schema else [
        f["name"] for f in parse_schema_hint(hint)
    ]
    specs: list[dict] = []
    seen: set[str] = set()
    for raw in names:
        # Truncate to 60 to match GenericFieldSpecSchema.name.max(60) — otherwise
        # a long AI-derived field name makes proposed_config permanently fail the
        # approve-route validation.
        name = re.sub(r"[^a-z0-9_]+", "_", str(raw).lower()).strip("_")[:60]
        if not name or name in seen:
            continue
        seen.add(name)
        specs.append(
            {"name": name, "type": "string", "required": name in required}
        )
    if not specs:  # never write an empty record_schema (Zod requires >=1)
        specs = [{"name": "title", "type": "string", "required": True}]
    return specs[:40]


def build_generic_source_doc(
    *,
    name: str,
    owner_uid: str,
    start_urls: list[str],
    extraction: dict | None = None,
    adapter_key: str = "",
    adapter_pr_url: str = "",
    output_schema: list[str] | None = None,
    schedule_cron: str = "0 * * * *",
    schema_hint: str = "",
    source_key: str = "",
    notes: str = "",
    origin_via: str = "cli",
    config_job_id: str = "",
) -> dict:
    """Assemble a GenericSourceCreate-shaped dict (+ owner/origin). Exactly one
    of `extraction` (config strategy) or `adapter_key` (adapter strategy)."""
    if adapter_key:
        strategy: dict[str, Any] = {"mode": "adapter", "adapter_key": adapter_key}
        if adapter_pr_url:
            strategy["adapter_pr_url"] = adapter_pr_url
        active = False  # cannot run until the module is merged to main
    else:
        strategy = {"mode": "config", "extraction": extraction or {}}
        active = True

    origin: dict[str, Any] = {"via": origin_via}
    if config_job_id:
        origin["config_job_id"] = config_job_id

    return {
        "name": name[:120],
        "source_key": (source_key or slugify(name))[:80],
        "record_schema": build_record_schema(
            output_schema or [], extraction or {}, schema_hint
        ),
        "strategy": strategy,
        "start_urls": list(start_urls)[:20],
        "schedule_cron": schedule_cron,
        "active": active,
        "notes": notes[:2000],
        "origin": origin,
    }


def write_generic_source(db, doc: dict) -> str:
    """Write /generic_sources/{auto-id} with server timestamps. Returns the id."""
    from google.cloud.firestore_v1 import SERVER_TIMESTAMP

    ref = db.collection("generic_sources").document()
    ref.set({
        **doc,
        "owner_uid": doc.get("owner_uid") or doc.get("_owner_uid") or "",
        "created_at": SERVER_TIMESTAMP,
        "updated_at": SERVER_TIMESTAMP,
        "last_run_at": None,
        "last_run_summary": None,
    })
    return ref.id
