"""Which machine we are on: OS, WSL, and the native package manager."""

from __future__ import annotations

import dataclasses
import functools
import pathlib
import platform as stdlib_platform
import shutil
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


def supported(entry: dict[str, Any], current: str | None = None, wsl: bool | None = None) -> bool:
    """True if an entry with an optional `os: [..]` list applies to this OS. `wsl: false` also
    rules it out under WSL (e.g. Ollama, which belongs on the Windows side for the GPU)."""
    if entry.get("wsl") is False and (is_wsl() if wsl is None else wsl):
        return False
    wanted = entry.get("os")
    return not wanted or (current or os_name()) in wanted


@dataclasses.dataclass(frozen=True)
class Platform:
    """Everything the wizard shows about this machine and uses to offer or hide choices."""

    os: str
    arch: str
    wsl: bool
    distro: str
    pkg_manager: str | None
    brew: bool
    container_runtime: str | None  # devbox runtime CLI, if installed
    ollama: str | None = None  # where models get pulled: windows (from WSL) | native | None
    wsl_ollama: bool = False  # a Linux ollama inside WSL as well (not used, worth a warning)

    @property
    def apple_silicon(self) -> bool:
        return self.os == "macos" and self.arch in ("arm64", "aarch64")

    @property
    def label(self) -> str:
        if self.os == "macos":
            return f"macOS ({'Apple Silicon' if self.apple_silicon else self.arch})"
        name = self.distro or self.os.capitalize()
        return f"{name} on WSL" if self.wsl and "WSL" not in name else name


def _container_runtime() -> str | None:
    from dotfiles.devbox import runtime  # devbox imports this module

    try:
        rt = runtime.select()
    except runtime.DevboxError:
        return None
    return rt.cli if rt.available() else None


def describe() -> Platform:
    from dotfiles import models  # models imports this module

    os_ = os_name()
    found = models.find_ollama()
    return Platform(
        os=os_,
        arch=stdlib_platform.machine().lower(),
        wsl=is_wsl(),
        distro=os_release().get("PRETTY_NAME", "") if os_ == "linux" else "",
        pkg_manager=pkg_manager(),
        brew=shutil.which("brew") is not None or pathlib.Path("/opt/homebrew/bin/brew").exists(),
        container_runtime=_container_runtime(),
        ollama=("windows" if found.windows else "native") if found else None,
        wsl_ollama=is_wsl() and models.linux_ollama() is not None,
    )
