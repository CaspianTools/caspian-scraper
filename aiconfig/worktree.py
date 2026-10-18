"""Isolate AI-generated adapter code in a git worktree, validate it there, and
open a PR — never touching `main`, never auto-committing to it.

Follows the repo's worktree discipline (CLAUDE.md §Worktrees): a fresh worktree
branched from origin/main under .claude/worktrees/ (gitignored), all generated
files written + validated THERE, and only a branch + PR pushed. A human reviews
the diff and merges; the adapter goes live on the next cron tick after merge.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from . import validate


def _git(args: list[str], cwd: str, *, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=check,
        timeout=180,
    )


def _write(base: Path, rel: str, content: str) -> str:
    path = base / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return str(path)


def build_adapter_in_worktree(
    *,
    key: str,
    artifacts: dict,
    spec_json: str,
    repo_root: str,
    run_live: bool = True,
    open_pr: bool = False,
) -> dict:
    """Create a worktree, write + validate the adapter there, and (optionally)
    open a PR. Returns a report dict. Never mutates `main`."""
    root = Path(repo_root).resolve()
    name = f"aiconfig-{key}"
    branch = f"worktree-{name}"
    wt_dir = root / ".claude" / "worktrees" / name

    result: dict = {
        "key": key, "branch": branch, "worktree": str(wt_dir),
        "pr_url": "", "passed": False, "report": "", "ast_gate": {},
    }

    # Fresh branch off origin/main (best-effort fetch first).
    try:
        _git(["fetch", "origin"], str(root), check=False)
        if wt_dir.exists():
            _git(["worktree", "remove", "--force", str(wt_dir)], str(root), check=False)
        _git(["branch", "-D", branch], str(root), check=False)
        base_ref = "origin/main"
        # Fall back to local main if origin/main isn't resolvable.
        probe = _git(["rev-parse", "--verify", base_ref], str(root), check=False)
        if probe.returncode != 0:
            base_ref = "HEAD"
        _git(["worktree", "add", "-b", branch, str(wt_dir), base_ref], str(root))
    except subprocess.CalledProcessError as e:
        result["report"] = f"worktree setup failed: {e.stderr or e}"
        return result

    # Write the four generated files into the worktree.
    adapter_path = _write(wt_dir, f"adapters/{key}.py", artifacts["adapter_py"])
    test_path = _write(wt_dir, f"tests/test_{key}.py", artifacts["test_py"])
    _write(wt_dir, f"tests/fixtures/generic/{key}_search.html",
           artifacts["search_fixture"])
    _write(wt_dir, f"tests/fixtures/generic/{key}_detail.html",
           artifacts["detail_fixture"])

    report = validate.validate_adapter(
        adapter_source=artifacts["adapter_py"],
        adapter_path=adapter_path,
        test_source=artifacts["test_py"],
        test_path=test_path,
        adapter_key=key,
        spec_json=spec_json,
        cwd=str(wt_dir),
        run_live=run_live,
    )
    result["passed"] = report["passed"]
    result["report"] = report["report"]
    result["ast_gate"] = next(
        (s for s in report["stages"] if s["stage"] == "ast_gate"), {}
    )

    if not report["passed"]:
        return result  # leave the worktree for inspection

    if open_pr:
        try:
            _git(["add", "-A"], str(wt_dir))
            _git(["commit", "-m",
                  f"feat(adapters): AI-generated adapter '{key}'\n\n"
                  f"Generated + validated by `python -m aiconfig adapter`.\n"
                  f"Human review required before merge."],
                 str(wt_dir))
            _git(["push", "-u", "origin", branch], str(wt_dir))
            pr = subprocess.run(
                ["gh", "pr", "create", "--title",
                 f"AI-generated adapter: {key}", "--body", result["report"],
                 "--head", branch],
                cwd=str(wt_dir), capture_output=True, text=True, timeout=120,
            )
            if pr.returncode == 0:
                result["pr_url"] = (pr.stdout or "").strip().splitlines()[-1]
            else:
                result["report"] += f"\n(gh pr create failed: {pr.stderr[:300]})"
        except subprocess.CalledProcessError as e:
            result["report"] += f"\n(git push/commit failed: {e.stderr or e})"

    return result
