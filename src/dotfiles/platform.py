"""Which machine we are on: OS, WSL, and the native package manager."""
from __future__ import annotations

import sys
from functools import cache
from pathlib import Path


def os_name() -> str:
    """macos | linux | windows (the names used by `os:` in packages.yaml and links.yaml)."""
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


@cache
def is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/sys/kernel/osrelease").read_text().lower()
    except OSError:
        return False


def os_release(path: Path = Path("/etc/os-release")) -> dict[str, str]:
    out = {}
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


def supported(entry: dict, current: str | None = None) -> bool:
    """True if an entry with an optional `os: [..]` list applies to this OS."""
    wanted = entry.get("os")
    return not wanted or (current or os_name()) in wanted
