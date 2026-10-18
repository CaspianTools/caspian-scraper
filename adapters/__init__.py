"""Registry for generic AI-generated adapters.

Auto-discovers modules dropped into this package (adapters/<key>.py) instead of
requiring an __init__ edit per adapter — that keeps the AI-generated surface to a
single new file whose only job is to pass the AST safety gate. A module is a
valid adapter if it exposes a top-level `ADAPTER` instance, a `build()` factory,
or an `Adapter` class.

Only modules that were reviewed + merged to `main` are importable here (the cron
checks out main each tick), so build() never imports un-vetted code.
"""

from __future__ import annotations

from .base import Adapter, FetchSpec  # noqa: F401 — re-export

# NB: importlib/pkgutil/Path are imported INSIDE the functions below, not at
# module level, so `import adapters` doesn't expose them as package attributes
# for a generated adapter to reach (the AST safety gate also denies them, but
# this keeps the re-export surface minimal).

_RESERVED = {"base"}


def available() -> list[str]:
    """Module stems in this package that could be adapters."""
    import pkgutil
    from pathlib import Path

    pkg_dir = Path(__file__).parent
    out: list[str] = []
    for info in pkgutil.iter_modules([str(pkg_dir)]):
        if info.ispkg or info.name.startswith("_") or info.name in _RESERVED:
            continue
        out.append(info.name)
    return sorted(out)


def build(key: str):
    """Import adapters.<key> and return its adapter instance."""
    import importlib

    key = str(key or "").strip()
    if not key or key in _RESERVED or not key.replace("_", "").isalnum():
        raise ValueError(f"invalid adapter key {key!r}")
    mod = importlib.import_module(f"{__name__}.{key}")
    if hasattr(mod, "build") and callable(mod.build):
        return mod.build()
    if hasattr(mod, "ADAPTER"):
        return mod.ADAPTER
    if hasattr(mod, "Adapter"):
        return mod.Adapter()
    raise ValueError(
        f"adapter module {key!r} exposes no ADAPTER / build() / Adapter"
    )
