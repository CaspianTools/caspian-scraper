"""`python -m aiconfig` — the CLI for AI-driven scraper configuration.

Two modes:
  aiconfig new --url ... --intent ...        interactive: propose -> approve -> write
  aiconfig --job <id>                         non-interactive: drive a config_jobs
                                              doc for the web wizard (Phase 3)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from . import persist
from .agent import run_agent
from .inspector import inspect_url
from .providers import build_provider, default_provider_from_env, key_env_for
from .providers.base import ProviderError

REPO_ROOT = str(__import__("pathlib").Path(__file__).resolve().parents[1])


def _provider_from_args(args: argparse.Namespace):
    """Build an LLM provider from CLI flags, falling back to env vars. Raises
    ProviderError (missing key / bad provider) with an actionable message."""
    provider = (
        getattr(args, "provider", "")
        or os.environ.get("AICONFIG_PROVIDER")
        or "anthropic"
    )
    model = getattr(args, "model", "") or os.environ.get("AICONFIG_MODEL", "")
    base_url = getattr(args, "base_url", "") or os.environ.get("AICONFIG_BASE_URL", "")
    api_key = getattr(args, "api_key", "") or key_env_for(provider)
    return build_provider(provider, api_key=api_key, model=model, base_url=base_url)


# --------------------------------------------------------------------------
# `new` — interactive CLI
# --------------------------------------------------------------------------

def _print_result(result: Any, *, listing_url: str) -> None:
    print("\n" + "=" * 70)
    print(f"PATH: {result.path}    cost≈${result.cost_usd:.2f}    "
          f"turns={result.turns_used}"
          + ("    [INCOMPLETE]" if result.incomplete else ""))
    if result.error:
        print(f"ERROR: {result.error}")
    if result.path == "adapter":
        print("\nThe agent decided this site needs a generated Python adapter:")
        print(f"  reason: {result.escalation_reason}")
        print("Run adapter generation (Phase 2) to build + validate one; "
              "config cannot be written for this site.")
        return
    print(f"\nSUMMARY: {result.summary}")
    print("\nPROPOSED extraction config:")
    print(json.dumps(result.extraction, indent=2))
    print(f"\nOUTPUT FIELDS: {result.output_schema}")
    print(f"\nSAMPLE RECORDS ({len(result.sample_records)} shown):")
    for i, rec in enumerate(result.sample_records[:5], 1):
        print(f"  {i}. {json.dumps(rec, ensure_ascii=False)[:300]}")
    print(f"\nDIAGNOSTICS: {json.dumps(result.diagnostics)}")


def _cmd_new(args: argparse.Namespace) -> int:
    try:
        provider = _provider_from_args(args)
    except ProviderError as e:
        print(
            f"{e}. Set the provider's key (OPENAI_API_KEY / GEMINI_API_KEY / "
            "ANTHROPIC_API_KEY) or pass --api-key.",
            file=sys.stderr,
        )
        return 2

    print(f"Inspecting {args.url} ...", file=sys.stderr)
    listing_ev = inspect_url(args.url, kind="listing")
    detail_ev = None
    if args.detail_url:
        print(f"Inspecting detail {args.detail_url} ...", file=sys.stderr)
        detail_ev = inspect_url(args.detail_url, kind="detail")
        # fold detail notes/candidates into the seed by attaching to listing
        listing_ev.notes.extend(f"detail: {n}" for n in detail_ev.notes)

    result = run_agent(
        args.intent,
        args.url,
        detail_url=args.detail_url or "",
        record_schema_hint=args.schema or "",
        evidence=listing_ev,
        provider=provider,
    )

    _print_result(result, listing_url=args.url)

    if args.json:
        artifact = {
            "intent": args.intent,
            "url": args.url,
            "path": result.path,
            "extraction": result.extraction,
            "output_schema": result.output_schema,
            "sample_records": result.sample_records,
            "diagnostics": result.diagnostics,
            "escalation_reason": result.escalation_reason,
            "cost_usd": result.cost_usd,
        }
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(artifact, fh, indent=2, ensure_ascii=False)
        print(f"\nWrote session artifact to {args.json}", file=sys.stderr)

    if not args.write:
        print("\n(dry run — pass --write to save this as a generic source)")
        return 0

    if result.path != "config" or not result.extraction:
        print("\nNothing to write (no config produced).", file=sys.stderr)
        return 1

    owner = args.owner
    if not owner:
        print("\n--write needs an owner uid (--owner or AICONFIG_OWNER_UID).",
              file=sys.stderr)
        return 2

    name = args.name or args.intent[:60]
    confirm = input(
        f"\nWrite generic source '{name}' to Firestore? Type the name to confirm: "
    ).strip()
    if confirm != name:
        print("Not confirmed — nothing written.")
        return 0

    doc = persist.build_generic_source_doc(
        name=name,
        owner_uid=owner,
        start_urls=[args.url],
        extraction=result.extraction,
        output_schema=result.output_schema,
        schedule_cron=args.cron,
        schema_hint=args.schema or "",
        origin_via="cli",
    )
    doc["owner_uid"] = owner
    from scrape import get_db

    db = get_db()
    sid = persist.write_generic_source(db, doc)
    print(f"\nWrote /generic_sources/{sid} (active) — the cron will scrape it on "
          f"schedule ({args.cron}).")
    return 0


# --------------------------------------------------------------------------
# `adapter` — generate + validate a Python adapter for a hard site (Phase 2)
# --------------------------------------------------------------------------

def _capture_html(url: str, wait_selector: str = "") -> str:
    from classifieds.browser import browser_context, fetch_html

    try:
        with browser_context() as ctx:
            return fetch_html(ctx, url, wait_selector=wait_selector)
    except Exception as e:  # noqa: BLE001
        print(f"capture failed for {url}: {e}", file=sys.stderr)
        return ""


def _cmd_adapter(args: argparse.Namespace) -> int:
    try:
        provider = _provider_from_args(args)
    except ProviderError as e:
        print(
            f"{e}. Set the provider's key (OPENAI_API_KEY / GEMINI_API_KEY / "
            "ANTHROPIC_API_KEY) or pass --api-key.",
            file=sys.stderr,
        )
        return 2
    from .generate import generate_adapter
    from .worktree import build_adapter_in_worktree

    detail_url = args.detail_url
    if not detail_url:
        print("Finding a sample detail page ...", file=sys.stderr)
        ev = inspect_url(args.url, kind="listing")
        for block in ev.repeated_blocks:
            if block.sample_hrefs:
                detail_url = block.sample_hrefs[0]
                break
    if not detail_url:
        print("Could not find a detail page; pass --detail-url.", file=sys.stderr)
        return 1

    print(f"Capturing HTML: search={args.url} detail={detail_url}", file=sys.stderr)
    search_html = _capture_html(args.url)
    detail_html = _capture_html(detail_url)
    if not search_html or not detail_html:
        print("Failed to capture page HTML.", file=sys.stderr)
        return 1

    record_schema = persist.parse_schema_hint(args.schema)
    if not record_schema:
        record_schema = [{"name": "title", "type": "string", "required": True}]

    print(f"Generating adapter '{args.key}' with the model ...", file=sys.stderr)
    try:
        artifacts = generate_adapter(
            intent=args.intent, url=args.url, key=args.key,
            record_schema=record_schema,
            search_html=search_html, detail_html=detail_html,
            provider=provider,
        )
    except Exception as e:  # noqa: BLE001
        print(f"generation failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    spec_json = json.dumps({
        "start_urls": [args.url],
        "record_schema": record_schema,
        "max_records": 5,
    })

    print("Validating in an isolated worktree (AST gate → compile → tests"
          + (" → live smoke" if not args.no_live else "") + ") ...",
          file=sys.stderr)
    report = build_adapter_in_worktree(
        key=args.key, artifacts=artifacts, spec_json=spec_json,
        repo_root=REPO_ROOT, run_live=not args.no_live, open_pr=args.open_pr,
    )

    print("\n" + "=" * 70)
    print(report["report"])
    print(f"\nbranch: {report['branch']}   worktree: {report['worktree']}")
    if report["passed"]:
        if report["pr_url"]:
            print(f"\nPR opened: {report['pr_url']}")
            print("Review the diff, merge to main, then activate the source.")
        elif args.open_pr:
            print("\nValidation passed but PR was not created (see report).")
        else:
            print("\nValidation passed. Re-run with --open-pr to open a PR.")
        return 0
    print("\nValidation FAILED — nothing pushed. Inspect the worktree above.")
    return 1


# --------------------------------------------------------------------------
# `--job` — drive a config_jobs doc (web wizard backend)
# --------------------------------------------------------------------------

def _run_job_mode(job_id: str) -> int:
    if not job_id:
        print("--job requires a job id", file=sys.stderr)
        return 2
    from google.cloud.firestore_v1 import SERVER_TIMESTAMP

    from scrape import get_db, utc_now_iso

    db = get_db()
    ref = db.collection("config_jobs").document(job_id)
    snap = ref.get()
    if not snap.exists:
        print(f"config_jobs/{job_id} not found", file=sys.stderr)
        return 1
    job = snap.to_dict() or {}
    owner_uid = str(job.get("owner_uid") or "")
    intent = str(job.get("intent") or "")
    url = str(job.get("url") or "")
    sample_urls = job.get("sample_urls") or []
    hint = str(job.get("record_schema_hint") or "")
    detail_url = str(sample_urls[0]) if isinstance(sample_urls, list) and sample_urls else ""

    # Build the LLM provider from the job OWNER's saved settings (provider,
    # model, key, base_url in /aiconfig_keys/{uid}) so their job runs on the
    # provider + model THEY chose. Fall back to the environment (a shared org
    # key) only when the owner hasn't configured one. Fail clearly if neither
    # yields a usable provider.
    provider = None
    provider_err = ""
    if owner_uid:
        try:
            key_snap = db.collection("aiconfig_keys").document(owner_uid).get()
            kd = (key_snap.to_dict() or {}) if key_snap.exists else {}
        except Exception as e:  # noqa: BLE001
            print(f"failed to read owner key: {e}", file=sys.stderr)
            kd = {}
        stored_key = str(kd.get("value") or "").strip()
        if stored_key:
            # The owner HAS configured a key/provider: use it, and if it can't be
            # built (e.g. openai_compatible without a base_url), FAIL — do not
            # silently fall back to the shared org key and bill the wrong account.
            try:
                provider = build_provider(
                    str(kd.get("provider") or "anthropic"),
                    api_key=stored_key,
                    model=str(kd.get("model") or ""),
                    base_url=str(kd.get("base_url") or ""),
                )
            except ProviderError as e:
                provider_err = f"your saved AI provider config is invalid: {e}"
    if provider is None and not provider_err:
        # Owner hasn't configured a key — fall back to the shared org env key.
        try:
            provider = default_provider_from_env()
        except ProviderError:
            provider = None
    if provider is None:
        ref.update({
            "status": "failed",
            "error": provider_err or (
                "no AI provider configured — add a provider + API key in "
                "AI Setup → API key"
            ),
            "finished_at": SERVER_TIMESTAMP,
            "updated_at": SERVER_TIMESTAMP,
        })
        return 2

    def set_status(status: str) -> None:
        ref.update({"status": status, "updated_at": SERVER_TIMESTAMP})

    def append_turn(role: str, text: str) -> None:
        from google.cloud.firestore_v1 import ArrayUnion

        ref.update({
            "turns": ArrayUnion([{"role": role, "text": text, "ts": utc_now_iso()}]),
            "updated_at": SERVER_TIMESTAMP,
        })

    def on_event(status: str, text: str) -> None:
        # Do NOT commit the terminal "proposed" status here: the agent emits it
        # when it calls finish, but proposed_config isn't written until run_agent
        # returns and the final ref.update below runs. Committing "proposed"
        # early opens a window where status=="proposed" && proposed_config==null,
        # which the approve route would reject (422). The final update sets both.
        if status != "proposed":
            set_status(status)
        if text:
            append_turn("agent", text)

    try:
        set_status("inspecting")
        listing_ev = inspect_url(url, kind="listing")
        result = run_agent(
            intent, url,
            detail_url=detail_url,
            record_schema_hint=hint,
            evidence=listing_ev,
            provider=provider,
            on_event=on_event,
        )
    except Exception as e:  # noqa: BLE001
        ref.update({
            "status": "failed",
            "error": f"{type(e).__name__}: {e}",
            "finished_at": SERVER_TIMESTAMP,
            "updated_at": SERVER_TIMESTAMP,
        })
        return 1

    updates: dict[str, Any] = {
        "path": result.path,
        "sample_records": result.sample_records[:5],
        "diagnostics": result.diagnostics,
        "finished_at": SERVER_TIMESTAMP,
        "updated_at": SERVER_TIMESTAMP,
    }
    if result.path == "adapter":
        # Phase 2 fills adapter{key,pr_url,...}; here we just record the ask.
        updates["status"] = "escalating_adapter"
        updates["error"] = ""
        updates["adapter"] = {
            "key": "", "pr_url": "", "branch": "",
            "ast_gate": {"passed": False, "findings": []},
            "validation_report": result.escalation_reason,
        }
        append_turn("system", f"needs adapter: {result.escalation_reason}")
    elif result.extraction and not result.incomplete:
        updates["status"] = "proposed"
        updates["proposed_config"] = persist.build_generic_source_doc(
            name=intent[:60] or url,
            owner_uid=str(job.get("owner_uid") or ""),
            start_urls=[url],
            extraction=result.extraction,
            output_schema=result.output_schema,
            schema_hint=hint,
            origin_via="wizard",
            config_job_id=job_id,
        )
    else:
        updates["status"] = "failed"
        updates["error"] = result.error or "no usable config produced"

    ref.update(updates)
    return 0


# --------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    import os

    p = argparse.ArgumentParser(prog="aiconfig", description=__doc__)
    sub = p.add_subparsers(dest="command")

    new = sub.add_parser("new", help="propose a scraper config for a site")
    new.add_argument("--url", required=True, help="listing / search page URL")
    new.add_argument("--intent", required=True, help="what to scrape, in words")
    new.add_argument("--detail-url", default="", help="a sample detail page URL")
    new.add_argument("--schema", default="",
                     help="output fields hint, e.g. 'title:string,date:string'")
    new.add_argument("--write", action="store_true",
                     help="after approval, write a /generic_sources doc")
    new.add_argument("--owner", default=os.environ.get("AICONFIG_OWNER_UID", ""),
                     help="owner uid for the written source (or AICONFIG_OWNER_UID)")
    new.add_argument("--name", default="", help="name for the source")
    new.add_argument("--cron", default="0 * * * *",
                     help="schedule cron (fixed minute; default hourly)")
    new.add_argument("--model", default="", help="model id (else provider default)")
    new.add_argument("--provider", default="",
                     help="anthropic | openai | gemini | openai_compatible "
                          "(default: anthropic or $AICONFIG_PROVIDER)")
    new.add_argument("--base-url", default="",
                     help="base URL for openai_compatible / custom endpoints")
    new.add_argument("--api-key", default="",
                     help="API key (else the provider's env var)")
    new.add_argument("--json", default="", help="write the session artifact here")

    adp = sub.add_parser(
        "adapter", help="generate + validate a Python adapter for a hard site")
    adp.add_argument("--url", required=True, help="listing / search page URL")
    adp.add_argument("--intent", required=True, help="what to scrape, in words")
    adp.add_argument("--key", required=True,
                     help="adapter module stem, e.g. 'acme_grants'")
    adp.add_argument("--schema", default="",
                     help="output fields, e.g. 'title:string*,amount:number'")
    adp.add_argument("--detail-url", default="", help="a sample detail page URL")
    adp.add_argument("--no-live", action="store_true",
                     help="skip the sandboxed live smoke test")
    adp.add_argument("--open-pr", action="store_true",
                     help="commit + push the branch and open a PR when green")
    adp.add_argument("--model", default="", help="model id (else provider default)")
    adp.add_argument("--provider", default="",
                     help="anthropic | openai | gemini | openai_compatible")
    adp.add_argument("--base-url", default="",
                     help="base URL for openai_compatible / custom endpoints")
    adp.add_argument("--api-key", default="",
                     help="API key (else the provider's env var)")
    return p


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--job" in argv:
        i = argv.index("--job")
        job_id = argv[i + 1] if i + 1 < len(argv) else ""
        return _run_job_mode(job_id)

    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "new":
        return _cmd_new(args)
    if args.command == "adapter":
        return _cmd_adapter(args)
    parser.print_help()
    return 1
