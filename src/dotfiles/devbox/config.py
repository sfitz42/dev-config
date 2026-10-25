"""devbox settings: defaults < machine config < project .devbox.env.

Both files are `KEY=value` lines (shell-style quoting and comments; no `$VAR` or `$(...)`
expansion, since they are parsed rather than sourced).
"""

from __future__ import annotations

import dataclasses
import os
import pathlib
import re
import shlex
import sys

DEFAULTS: dict[str, str] = {
    "DEVBOX_IMAGE": "dev-fullstack:0.1.0",
    "DEVBOX_NAME": "",  # default: devbox-<project dir name>
    # Where the project dir is mounted (matches core WORKDIR)
    "DEVBOX_WORKSPACE": "/home/dev/workspace",
    "DEVBOX_MEMORY": "6G",
    "DEVBOX_CPUS": "4",
    "DEVBOX_PORTS": "",  # space-separated; host:container or just a port
    "DEVBOX_DOCKER": "1",  # run dockerd inside (Apple `container` only)
    "DEVBOX_SSHD": "1",  # run sshd inside (Zed, ssh)
    "DEVBOX_SSH_PORT": "",  # default: derived from the name (2200-2999)
    "DEVBOX_SSH_KEY": "~/.ssh/devbox",  # created if missing
    "DEVBOX_FORWARD_AGENT": "1",  # forward the host's ssh-agent (git over ssh)
    "DEVBOX_PROXY": "",  # e.g. http://192.168.64.1:8888; empty = no proxy
    "DEVBOX_NO_PROXY": "",  # extra, added to the built-in exemptions
    "DEVBOX_PROXY_INJECT": "off",  # off|all: docker CLI proxy injection (see entrypoint)
    "DEVBOX_DOCKER_VOLUME_SIZE": "40G",
    "DEVBOX_RUNTIME": "",  # container|wslc; default: by platform
}

ALWAYS_NO_PROXY = "localhost,127.0.0.1,::1,172.16.0.0/12"


def _words(value: str, windows: bool) -> list[str]:
    lex = shlex.shlex(value, posix=True)
    lex.whitespace_split = True
    lex.commenters = "#"
    if windows:
        lex.escape = ""  # backslashes are path separators there (C:\Users\...)
    return list(lex)


def parse_env_file(text: str, windows: bool | None = None) -> dict[str, str]:
    """KEY=value lines; `export ` prefixes, quotes and trailing comments work like a shell."""
    windows = sys.platform.startswith("win") if windows is None else windows
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        out[key] = " ".join(_words(value, windows))
    return out


def machine_config_path() -> pathlib.Path:
    return pathlib.Path(
        os.path.expanduser(os.environ.get("DEVBOX_CONFIG") or "~/.config/devbox/config")
    )


def load(project_dir: pathlib.Path) -> dict[str, str]:
    values = dict(DEFAULTS)
    for f in (machine_config_path(), project_dir / ".devbox.env"):
        if f.is_file():
            values.update(parse_env_file(f.read_text()))
    return values


# ---- derived values ---------------------------------------------------------


def _crc_table() -> list[int]:
    table: list[int] = []
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = ((c << 1) ^ 0x04C11DB7) if c & 0x80000000 else (c << 1)
        table.append(c & 0xFFFFFFFF)
    return table


_CRC = _crc_table()


def cksum(data: bytes) -> int:
    """POSIX `cksum` CRC, so ports derived by the old bash devbox stay the same."""
    crc = 0
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC[((crc >> 24) ^ b) & 0xFF]
    n = len(data)
    while n:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC[((crc >> 24) ^ (n & 0xFF)) & 0xFF]
        n >>= 8
    return ~crc & 0xFFFFFFFF


def slug(project_dir: pathlib.Path) -> str:
    return re.sub(r"[^a-z0-9_.-]", "-", project_dir.name.lower())


def size_bytes(size: str) -> int:
    """'40G' -> bytes (binary units, like the runtimes use)."""
    m = re.fullmatch(r"\s*(\d+)\s*([KMGTP]?)B?\s*", size, re.IGNORECASE)
    if not m:
        raise ValueError(f"not a size: {size!r}")
    total: int = int(m.group(1)) * 1024 ** " KMGTP".index(m.group(2).upper() or " ")
    return total


@dataclasses.dataclass
class Settings:
    project_dir: pathlib.Path
    values: dict[str, str]
    name: str = dataclasses.field(init=False)
    ssh_port: int = dataclasses.field(init=False)

    def __post_init__(self) -> None:
        self.name = self.values["DEVBOX_NAME"] or f"devbox-{slug(self.project_dir)}"
        p = self.values["DEVBOX_SSH_PORT"]
        self.ssh_port = int(p) if p else 2200 + cksum(self.name.encode()) % 800

    def __getitem__(self, key: str) -> str:
        return self.values[key]

    def flag(self, key: str) -> bool:
        return self.values[key] == "1"

    @property
    def ports(self) -> list[str]:
        return self.values["DEVBOX_PORTS"].split()

    @property
    def ssh_key(self) -> pathlib.Path:
        return pathlib.Path(os.path.expanduser(self.values["DEVBOX_SSH_KEY"]))

    @property
    def no_proxy(self) -> str:
        extra = self.values["DEVBOX_NO_PROXY"]
        return f"{ALWAYS_NO_PROXY},{extra}" if extra else ALWAYS_NO_PROXY

    def volumes(self, with_docker: bool = True) -> list[tuple[str, str]]:
        """(volume name, mount point). The Docker store only matters where dockerd can run."""
        n = self.name
        vols = [(f"{n}-docker", "/var/lib/docker")] if with_docker else []
        return vols + [
            (f"{n}-zed", "/home/dev/.zed_server"),
            (f"{n}-uv", "/home/dev/.cache/uv"),
            (f"{n}-npm", "/home/dev/.npm"),
        ]


def settings(project_dir: pathlib.Path) -> Settings:
    return Settings(project_dir, load(project_dir))
