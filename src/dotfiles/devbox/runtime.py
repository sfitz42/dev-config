"""Container runtimes devbox can drive: Apple `container` (macOS) and `wslc` (Windows / WSL).

Argument lists are built by pure methods so they can be tested without a runtime installed.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
from typing import Any

from dotfiles import platform
from dotfiles.devbox import config


class DevboxError(Exception):
    pass


class Runtime:
    name = ""
    cli = ""
    supports_caps = True  # can add capabilities (needed for dockerd in the container)
    supports_ssh_agent = True  # can forward the host's ssh-agent into the container
    ssh_host = "localhost"  # how the host reaches published ports

    # ---- argument builders (pure) --------------------------------------------
    def cpus_flag(self) -> str:
        raise NotImplementedError

    def run_args(self, cfg: config.Settings, pubkey: str = "", agent: bool = False) -> list[str]:
        """Arguments for creating the project's container (after the CLI name)."""
        docker = cfg.flag("DEVBOX_DOCKER") and self.supports_caps
        args = [
            "run",
            "-d",
            "--name",
            cfg.name,
            "-m",
            cfg["DEVBOX_MEMORY"],
            self.cpus_flag(),
            cfg["DEVBOX_CPUS"],
        ]
        if docker:
            args += ["--cap-add", "CAP_NET_ADMIN", "--cap-add", "CAP_SYS_ADMIN"]
        if agent and self.supports_ssh_agent:
            args += ["--ssh"]
        for p in cfg.ports:
            args += ["-p", f"127.0.0.1:{p}" if ":" in p else f"127.0.0.1:{p}:{p}"]
        if cfg.flag("DEVBOX_SSHD"):
            args += ["-p", f"127.0.0.1:{cfg.ssh_port}:{cfg.ssh_port}"]
        args += [
            "-e",
            f"DEVBOX_DOCKER={'1' if docker else '0'}",
            "-e",
            f"DEVBOX_SSHD={cfg['DEVBOX_SSHD']}",
            "-e",
            f"DEVBOX_SSHD_PORT={cfg.ssh_port}",
            "-e",
            f"DEVBOX_PROXY_INJECT={cfg['DEVBOX_PROXY_INJECT']}",
            "-e",
            "TERM=xterm-256color",
        ]
        if cfg.flag("DEVBOX_SSHD"):
            args += ["-e", f"DEVBOX_SSH_PUBKEY={pubkey}"]
        proxy = cfg["DEVBOX_PROXY"]
        if proxy:
            no = cfg.no_proxy
            args += [
                "-e",
                f"HTTP_PROXY={proxy}",
                "-e",
                f"HTTPS_PROXY={proxy}",
                "-e",
                f"http_proxy={proxy}",
                "-e",
                f"https_proxy={proxy}",
                "-e",
                f"NO_PROXY={no}",
                "-e",
                f"no_proxy={no}",
            ]
        args += ["-v", f"{self.host_path(cfg.project_dir)}:{cfg['DEVBOX_WORKSPACE']}"]
        for vol, mount in cfg.volumes(with_docker=self.supports_caps):
            args += ["-v", f"{vol}:{mount}"]
        return args + [cfg["DEVBOX_IMAGE"], "sleep", "infinity"]

    def volume_create_args(self, vol: str, size: str | None) -> list[str]:
        raise NotImplementedError

    def delete_args(self, name: str) -> list[str]:
        raise NotImplementedError

    def volume_delete_args(self, vol: str) -> list[str]:
        raise NotImplementedError

    def parse_state(self, listing: str, name: str) -> str:
        """running | stopped | '' (missing), from `list --all --format json` output."""
        raise NotImplementedError

    def host_path(self, p: pathlib.Path) -> str:
        return str(p)

    # ---- calls ---------------------------------------------------------------
    def available(self) -> bool:
        return shutil.which(self.cli) is not None

    def call(
        self, *args: str, quiet: bool = True, check: bool = True
    ) -> subprocess.CompletedProcess[bytes]:
        out = subprocess.DEVNULL if quiet else None
        err = subprocess.DEVNULL if quiet and not check else None  # best-effort calls stay silent
        r = subprocess.run([self.cli, *args], stdout=out, stderr=err)
        if check and r.returncode != 0:
            raise DevboxError(f"{self.cli} {args[0]} failed (exit {r.returncode})")
        return r

    def capture(self, *args: str) -> str:
        r = subprocess.run([self.cli, *args], capture_output=True, text=True)
        return r.stdout if r.returncode == 0 else ""

    def state(self, name: str) -> str:
        return self.parse_state(self.capture("list", "--all", "--format", "json"), name)

    def address(self, name: str) -> str:
        return "-"

    def volume_exists(self, vol: str) -> bool:
        return (
            subprocess.run([self.cli, "volume", "inspect", vol], capture_output=True).returncode
            == 0
        )

    def prepare_build(self) -> None:
        """Anything the runtime needs before `build` (start services)."""


class AppleContainer(Runtime):
    name = "container"
    cli = "container"

    def cpus_flag(self) -> str:
        return "-c"

    def volume_create_args(self, vol: str, size: str | None) -> list[str]:
        return ["volume", "create", *(["-s", size] if size else []), vol]

    def delete_args(self, name: str) -> list[str]:
        return ["delete", name]

    def volume_delete_args(self, vol: str) -> list[str]:
        return ["volume", "delete", vol]

    def _find(self, listing: str, name: str) -> dict[str, Any] | None:
        try:
            items = json.loads(listing or "[]")
        except json.JSONDecodeError:
            return None
        return next((c for c in items if c.get("configuration", {}).get("id") == name), None)

    def parse_state(self, listing: str, name: str) -> str:
        c = self._find(listing, name)
        if c is None:
            return ""
        status = c.get("status")
        state = status.get("state") if isinstance(status, dict) else status
        return "running" if state == "running" else "stopped"

    def address(self, name: str) -> str:
        c = self._find(self.capture("list", "--all", "--format", "json"), name) or {}
        raw = c.get("status")
        status: dict[str, Any] = raw if isinstance(raw, dict) else {}
        nets = status.get("networks") or [{}]
        return str(nets[0].get("ipv4Address") or "-")

    def prepare_build(self) -> None:
        self.call("system", "start", quiet=False)
        # The bridge address only exists while a VM is running; the builder provides one.
        self.call("builder", "start", quiet=False)


class Wslc(Runtime):
    """WSL containers (wslc.exe, WSL 2.9.3+). Verified on wslc 3.0.3:
    - containers get Docker's default capabilities and there is no --cap-add/--privileged,
      so dockerd cannot run inside (iptables and the /proc/sys remount are denied)
    - no --ssh agent forwarding
    - published ports bind IPv4 127.0.0.1 only, and `localhost` resolves to ::1 first on Windows
    - list output is one docker-style JSON object per line (`Names`, `State`)
    """

    name = "wslc"
    supports_caps = False
    supports_ssh_agent = False
    ssh_host = "127.0.0.1"

    def __init__(self) -> None:
        # From inside a WSL distro the Windows binary is reached through interop
        self.cli = "wslc.exe" if platform.is_wsl() else "wslc"

    def cpus_flag(self) -> str:
        return "--cpus"

    def volume_create_args(self, vol: str, size: str | None) -> list[str]:
        if size:  # a sized volume is its own VHDX; SizeBytes takes bytes only
            return [
                "volume",
                "create",
                "-d",
                "vhd",
                "-o",
                f"SizeBytes={config.size_bytes(size)}",
                vol,
            ]
        return ["volume", "create", vol]

    def delete_args(self, name: str) -> list[str]:
        return ["remove", name]

    def volume_delete_args(self, vol: str) -> list[str]:
        return ["volume", "remove", vol]

    def parse_state(self, listing: str, name: str) -> str:
        for line in listing.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                c = json.loads(line)
            except json.JSONDecodeError:
                continue
            if name in str(c.get("Names", "")).split(","):
                return "running" if c.get("State") == "running" else "stopped"
        return ""

    def address(self, name: str) -> str:
        try:
            info = json.loads(self.capture("inspect", name) or "[]")
            nets = info[0]["NetworkSettings"]["Networks"]
            return str(next(iter(nets.values()))["IPAddress"] or "-")
        except (json.JSONDecodeError, IndexError, KeyError, StopIteration, TypeError):
            return "-"

    def host_path(self, p: pathlib.Path) -> str:
        if platform.is_wsl():
            # wslc runs on the Windows side: hand it the \\wsl.localhost\... form of a distro path
            r = subprocess.run(["wslpath", "-w", str(p)], capture_output=True, text=True)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip()
        return str(p)


RUNTIMES: dict[str, type[Runtime]] = {"container": AppleContainer, "wslc": Wslc}


def select(choice: str = "") -> Runtime:
    """DEVBOX_RUNTIME if set, else by platform."""
    if choice:
        if choice not in RUNTIMES:
            raise DevboxError(f"unknown DEVBOX_RUNTIME '{choice}' (use: {', '.join(RUNTIMES)})")
        return RUNTIMES[choice]()
    os_ = platform.os_name()
    if os_ == "macos":
        return AppleContainer()
    if os_ == "windows" or platform.is_wsl():
        return Wslc()
    raise DevboxError(
        "no supported container runtime here (Apple `container` on macOS, wslc on Windows/WSL)"
    )
