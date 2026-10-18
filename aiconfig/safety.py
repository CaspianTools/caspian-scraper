"""Static AST safety gate for AI-generated adapter code.

Runs BEFORE the generated module is ever imported or executed. It is an
allow-list on imports PLUS a denylist on dangerous symbols/attributes — because
an allow-listed leaf module can transitively re-export forbidden stdlib
(classifieds/ai.py imports os+requests), allow-listing the module path alone is
not enough, so we also reject those names wherever they're imported, referenced,
or reached through an attribute chain. This is the first guardrail; it is NOT a
full sandbox (it does not stop, e.g., a supply-chain issue in a vetted module),
so process isolation + a scrubbed env in validate.py and a human PR review back
it up. Nothing un-vetted should reach those stages.

Returns {"passed": bool, "findings": [str]}.
"""

from __future__ import annotations

import ast

# Exact module paths a generated adapter may import. Network is allowed ONLY via
# the vetted classifieds helpers, never directly (no requests/urllib.request).
ALLOWED_IMPORTS = {
    "__future__",
    "re",
    "json",
    "typing",
    "dataclasses",
    "urllib.parse",
    "html",
    "datetime",
    "adapters",
    "adapters.base",
    "classifieds",
    "classifieds.extract",
    "classifieds.http",
    "classifieds.browser",
    "classifieds.models",
    "classifieds.ai",
}

# Relative-import module names allowed within the adapters package.
_ALLOWED_RELATIVE = {None, "base"}

# Builtins/functions that enable code execution, reflection escapes, or FS/proc
# access. Generated adapters compose the toolkit and never need these.
FORBIDDEN_CALLS = {
    "eval", "exec", "compile", "__import__", "open", "input",
    "globals", "locals", "vars", "getattr", "setattr", "delattr",
    "breakpoint", "memoryview", "__build_class__", "help",
}

# Bare names that should never appear.
FORBIDDEN_NAMES = {
    "__builtins__", "__import__", "__loader__", "__spec__",
}

# Dangerous module/symbol names. An allow-listed leaf module can transitively
# re-export stdlib (classifieds/ai.py does `import os, requests`;
# classifieds/browser.py `from pathlib import Path`; adapters/__init__ pulls in
# importlib/Path), so allow-listing the *module path* is not enough. We also
# reject these as imported symbols (`from classifieds.ai import os`), as bare
# names, and as attribute accesses (`classifieds.ai.os.system(...)`) so a
# re-export can't be reached through any allowed module. These names never
# collide with the toolkit surface (get/post/links/meta_tags/compile/...).
DANGEROUS = {
    "os", "sys", "subprocess", "socket", "requests", "urllib", "pathlib",
    "Path", "importlib", "builtins", "shutil", "ctypes", "pickle", "marshal",
    "io", "system", "popen", "environ", "getenv", "putenv", "setenv",
    "import_module", "read_text", "write_text", "read_bytes", "write_bytes",
    "urlopen", "Popen", "spawnv", "spawnl", "execv", "execl", "fork",
}


def _dunder(name: str) -> bool:
    return len(name) > 4 and name.startswith("__") and name.endswith("__")


class _Gate(ast.NodeVisitor):
    def __init__(self, extra_allowed: set | None = None) -> None:
        self.findings: list[str] = []
        self.allowed = ALLOWED_IMPORTS | (extra_allowed or set())

    def _flag(self, node: ast.AST, msg: str) -> None:
        line = getattr(node, "lineno", "?")
        self.findings.append(f"line {line}: {msg}")

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if alias.name not in self.allowed:
                self._flag(node, f"disallowed import '{alias.name}'")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level and node.level > 0:
            if node.module not in _ALLOWED_RELATIVE:
                self._flag(node, f"disallowed relative import '.{node.module}'")
        elif node.module not in self.allowed:
            self._flag(node, f"disallowed import from '{node.module}'")
        # Even from an allowed module, reject importing a re-exported dangerous
        # symbol (e.g. `from classifieds.ai import os, requests`).
        for alias in node.names:
            if alias.name in DANGEROUS:
                self._flag(node, f"forbidden imported symbol '{alias.name}'")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        # Bare-name builtins (eval/open/getattr/...) are the primary risk.
        if isinstance(func, ast.Name) and func.id in FORBIDDEN_CALLS:
            self._flag(node, f"forbidden call '{func.id}(...)'")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        # Dunder escapes AND non-dunder attribute chains that reach a re-exported
        # dangerous module/function (e.g. classifieds.ai.os.system, adapters.Path).
        if _dunder(node.attr):
            self._flag(node, f"forbidden dunder attribute access '.{node.attr}'")
        elif node.attr in DANGEROUS:
            self._flag(node, f"forbidden attribute access '.{node.attr}'")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in FORBIDDEN_NAMES or node.id in DANGEROUS or _dunder(node.id):
            self._flag(node, f"forbidden name '{node.id}'")
        self.generic_visit(node)

    # Constants can hide dunder strings fed to getattr; flag them defensively.
    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str) and _dunder(node.value):
            self._flag(node, f"suspicious dunder string literal '{node.value}'")
        self.generic_visit(node)


def check_source(source: str, *, extra_allowed: set | None = None) -> dict:
    """Static-analyse `source`. Returns {'passed': bool, 'findings': [str]}.

    `extra_allowed` adds module paths to the import allow-list — used to let a
    generated TEST import the specific adapter module under test
    (e.g. {"adapters.acme_grants"}) without widening the gate for anything else.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"passed": False, "findings": [f"syntax error: {e}"]}
    gate = _Gate(extra_allowed=extra_allowed)
    gate.visit(tree)
    return {"passed": not gate.findings, "findings": gate.findings}


def check_file(path: str, *, extra_allowed: set | None = None) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return check_source(fh.read(), extra_allowed=extra_allowed)
    except OSError as e:
        return {"passed": False, "findings": [f"cannot read {path}: {e}"]}
