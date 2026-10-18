"""Validation pipeline for AI-generated adapter code.

Gates run in order; the first failure aborts (nothing further imports/executes
the code). Highest-value gate first — the static AST allow-list — then compile,
then the generated unit test, then an optional sandboxed live smoke run in a
subprocess with a SCRUBBED environment (no Firestore/destination/LLM secrets).

Returns a structured report dict the CLI/PR body renders.
"""

from __future__ import annotations

import os
import subprocess
import sys

from .safety import check_source

# Secret-ish env vars the sandboxed smoke subprocess must never see, even if the
# AST gate somehow missed an exfiltration path.
_SCRUB_EXACT = {
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "FIREBASE_ADMIN_SA_JSON",
    "ANTHROPIC_API_KEY",
    "CLASSIFIEDS_AI_KEY",
    "AICONFIG_MODEL",
    "GH_DISPATCH_TOKEN",
    "GITHUB_TOKEN",
    "ENTIRELYSAFE_API_KEY",
}
_SCRUB_SUFFIXES = ("_SECRET", "_KEY", "_TOKEN", "_PASSWORD", "_SA_JSON")


def _scrubbed_env() -> dict:
    out: dict[str, str] = {}
    for k, v in os.environ.items():
        if k in _SCRUB_EXACT:
            continue
        if any(k.endswith(sfx) for sfx in _SCRUB_SUFFIXES):
            continue
        out[k] = v
    # Belt-and-braces flag so the adapter/toolkit can't accidentally reach out.
    out["AICONFIG_SANDBOX"] = "1"
    return out


def ast_gate(source: str, *, extra_allowed: set | None = None,
             stage: str = "ast_gate") -> dict:
    r = check_source(source, extra_allowed=extra_allowed)
    return {"stage": stage, "ok": r["passed"], "findings": r["findings"]}


def compile_check(path: str) -> dict:
    # Scrubbed env even though py_compile does not execute the module — belt and
    # braces so no stage ever runs generated code with production secrets.
    proc = subprocess.run(
        [sys.executable, "-m", "py_compile", path],
        capture_output=True, text=True, timeout=60, env=_scrubbed_env(),
    )
    return {
        "stage": "compile",
        "ok": proc.returncode == 0,
        "output": (proc.stderr or proc.stdout or "")[:2000],
    }


def run_pytest(test_path: str, cwd: str) -> dict:
    # pytest imports the adapter module and runs the generated test — both are
    # AI-authored, so this MUST run with a scrubbed env (no API keys / creds).
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", test_path, "-q"],
        capture_output=True, text=True, cwd=cwd, timeout=300, env=_scrubbed_env(),
    )
    return {
        "stage": "unit_test",
        "ok": proc.returncode == 0,
        "output": (proc.stdout or "")[-3000:] + (proc.stderr or "")[-1000:],
    }


_SMOKE_SNIPPET = (
    "import json,sys\n"
    "from adapters import build\n"
    "from adapters.base import FetchSpec\n"
    "spec=FetchSpec(**json.loads(sys.argv[1]))\n"
    "a=build(sys.argv[2])\n"
    "n=0\n"
    "reqs=spec.required_fields()\n"
    "for rec in a.fetch(spec):\n"
    "    data=rec.get('data',rec) if isinstance(rec,dict) else {}\n"
    "    if all(data.get(f) for f in reqs) or (not reqs and data):\n"
    "        n+=1\n"
    "    if n>=1: break\n"
    "print('SMOKE_OK' if n>=1 else 'SMOKE_EMPTY')\n"
)


def live_smoke(adapter_key: str, spec_json: str, cwd: str, *, timeout: int = 120) -> dict:
    """Run the adapter against the live site in an isolated subprocess with a
    scrubbed env, capped time + output. Asserts >=1 record with required fields."""
    try:
        proc = subprocess.run(
            [sys.executable, "-c", _SMOKE_SNIPPET, spec_json, adapter_key],
            capture_output=True, text=True, cwd=cwd, timeout=timeout,
            env=_scrubbed_env(),
        )
    except subprocess.TimeoutExpired:
        return {"stage": "live_smoke", "ok": False, "output": "timed out"}
    out = (proc.stdout or "")[-3000:]
    err = (proc.stderr or "")[-1500:]
    return {
        "stage": "live_smoke",
        "ok": proc.returncode == 0 and "SMOKE_OK" in out,
        "output": (out + "\n" + err).strip()[:4000],
    }


def validate_adapter(
    *,
    adapter_source: str,
    adapter_path: str,
    test_source: str,
    test_path: str,
    adapter_key: str,
    spec_json: str,
    cwd: str,
    run_live: bool = True,
) -> dict:
    """Run the full gate chain. Returns {passed, stages:[...], report:str}.

    Both the adapter AND the generated test are AI-authored and untrusted, so
    BOTH pass the AST gate before pytest ever imports/executes them. The test is
    allowed to import only the adapter-under-test on top of the toolkit."""
    stages: list[dict] = []

    g = ast_gate(adapter_source)
    stages.append(g)
    if not g["ok"]:
        return _finish(stages, adapter_key)

    gt = ast_gate(
        test_source,
        extra_allowed={f"adapters.{adapter_key}"},
        stage="ast_gate_test",
    )
    stages.append(gt)
    if not gt["ok"]:
        return _finish(stages, adapter_key)

    c = compile_check(adapter_path)
    stages.append(c)
    if not c["ok"]:
        return _finish(stages, adapter_key)

    t = run_pytest(test_path, cwd)
    stages.append(t)
    if not t["ok"]:
        return _finish(stages, adapter_key)

    if run_live:
        s = live_smoke(adapter_key, spec_json, cwd)
        stages.append(s)

    return _finish(stages, adapter_key)


def _finish(stages: list[dict], adapter_key: str) -> dict:
    passed = all(s["ok"] for s in stages)
    lines = [f"validation report for adapter '{adapter_key}':"]
    for s in stages:
        mark = "PASS" if s["ok"] else "FAIL"
        detail = s.get("findings") or s.get("output") or ""
        lines.append(f"  [{mark}] {s['stage']}"
                     + (f" — {detail}" if detail and not s["ok"] else ""))
    return {"passed": passed, "stages": stages, "report": "\n".join(lines)}
