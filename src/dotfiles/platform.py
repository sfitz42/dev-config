"""Which machine we are on: OS, WSL, and the native package manager."""

from __future__ import annotations

import functools
import pathlib
import sys
from typing import Any


def os_name() -> str:
    """macos | linux | windows (the names used by `os:` in packages.yaml and links.yaml)."""
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


@functools.cache
def is_wsl() -> bool:
    try:
        return "microsoft" in pathlib.Path("/proc/sys/kernel/osrelease").read_text().lower()
    except OSError:
        return False


def os_release(path: pathlib.Path = pathlib.Path("/etc/os-release")) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                out[k] = v.strip().strip('"')
    except OSError:
        pass
    return out


def pkg_manager(release: dict[str, str] | None = None) -> str | None:
    """dnf | apt | None, from ID / ID_LIKE in /etc/os-release."""
    if os_name() != "linux" and release is None:
        return None
    r = os_release() if release is None else release
    ids = [r.get("ID", ""), *r.get("ID_LIKE", "").split()]
    if any(i in ("fedora", "rhel", "centos") for i in ids):
        return "dnf"
    if any(i in ("debian", "ubuntu") for i in ids):
        return "apt"
    return None


def supported(entry: dict[str, Any], current: str | None = None) -> bool:
    """True if an entry with an optional `os: [..]` list applies to this OS."""
    wanted = entry.get("os")
    return not wanted or (current or os_name()) in wanted
