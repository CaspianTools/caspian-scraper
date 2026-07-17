"""Tests for the adapter validation pipeline (aiconfig.validate).

Exercises the AST/compile/pytest gates and the abort-on-first-failure
orchestration. The live smoke is not run here (run_live=False) — it needs a real
site and is exercised only in the CLI/Actions flow.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig import validate  # noqa: E402

GOOD_SRC = (
    "from __future__ import annotations\n"
    "import re\n"
    "from classifieds import extract\n"
    "def parse_detail_html(html, url):\n"
    "    return {'url': url, 'data': {'title': extract.strip_tags(html)}}\n"
)

BAD_SRC = (
    "from __future__ import annotations\n"
    "import os\n"
    "os.system('echo pwned')\n"
)


def test_ast_gate_good_and_bad():
    assert validate.ast_gate(GOOD_SRC)["ok"] is True
    bad = validate.ast_gate(BAD_SRC)
    assert bad["ok"] is False
    assert bad["findings"]


def test_compile_check(tmp_path):
    good = tmp_path / "good.py"
    good.write_text(GOOD_SRC, encoding="utf-8")
    assert validate.compile_check(str(good))["ok"] is True

    bad = tmp_path / "bad.py"
    bad.write_text("def f(:\n    pass\n", encoding="utf-8")
    assert validate.compile_check(str(bad))["ok"] is False


def test_run_pytest_pass_and_fail(tmp_path):
    ok = tmp_path / "test_ok.py"
    ok.write_text("def test_ok():\n    assert True\n", encoding="utf-8")
    assert validate.run_pytest(str(ok), str(tmp_path))["ok"] is True

    bad = tmp_path / "test_bad.py"
    bad.write_text("def test_bad():\n    assert False\n", encoding="utf-8")
    assert validate.run_pytest(str(bad), str(tmp_path))["ok"] is False


def test_validate_aborts_on_ast_fail(tmp_path):
    path = tmp_path / "adapter.py"
    path.write_text(BAD_SRC, encoding="utf-8")
    test = tmp_path / "test_x.py"
    test.write_text("def test_ok():\n    assert True\n", encoding="utf-8")
    report = validate.validate_adapter(
        adapter_source=BAD_SRC,
        adapter_path=str(path),
        test_source="def test_ok():\n    assert True\n",
        test_path=str(test),
        adapter_key="x",
        spec_json="{}",
        cwd=str(tmp_path),
        run_live=False,
    )
    assert report["passed"] is False
    # Aborted at the very first gate — nothing compiled or ran.
    assert len(report["stages"]) == 1
    assert report["stages"][0]["stage"] == "ast_gate"


def test_validate_full_green(tmp_path):
    path = tmp_path / "adapter.py"
    path.write_text(GOOD_SRC, encoding="utf-8")
    test = tmp_path / "test_x.py"
    test.write_text("def test_ok():\n    assert 1 + 1 == 2\n", encoding="utf-8")
    report = validate.validate_adapter(
        adapter_source=GOOD_SRC,
        adapter_path=str(path),
        test_source="def test_ok():\n    assert 1 + 1 == 2\n",
        test_path=str(test),
        adapter_key="x",
        spec_json="{}",
        cwd=str(tmp_path),
        run_live=False,
    )
    assert report["passed"] is True
    assert [s["stage"] for s in report["stages"]] == [
        "ast_gate", "ast_gate_test", "compile", "unit_test",
    ]


def test_scrubbed_env_removes_secrets(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret")
    monkeypatch.setenv("MY_FANCY_TOKEN", "t")
    monkeypatch.setenv("HARMLESS", "ok")
    env = validate._scrubbed_env()
    assert "ANTHROPIC_API_KEY" not in env
    assert "MY_FANCY_TOKEN" not in env
    assert env.get("HARMLESS") == "ok"
    assert env.get("AICONFIG_SANDBOX") == "1"
