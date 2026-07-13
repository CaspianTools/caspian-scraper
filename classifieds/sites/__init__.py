"""Site adapter registry.

Add a new site by creating a module here that exposes an adapter class,
then registering it in `_REGISTRY`. The CLI's `--site` names are these keys.
"""

from __future__ import annotations

from .base import SearchSpec, SiteAdapter  # noqa: F401 (re-export)
from .dubizzle import DubizzleAdapter
from .facebook import FacebookAdapter
from .opensooq import OpenSooqAdapter
from .yallamotor import YallaMotorAdapter

_REGISTRY = {
    OpenSooqAdapter.key: OpenSooqAdapter,
    DubizzleAdapter.key: DubizzleAdapter,
    YallaMotorAdapter.key: YallaMotorAdapter,
    FacebookAdapter.key: FacebookAdapter,
}


def available() -> list[str]:
    return list(_REGISTRY)


def build(key: str, *, fb_cookies: str = "") -> SiteAdapter:
    if key not in _REGISTRY:
        raise KeyError(f"Unknown site {key!r}; available: {', '.join(_REGISTRY)}")
    return _REGISTRY[key](fb_cookies=fb_cookies)
