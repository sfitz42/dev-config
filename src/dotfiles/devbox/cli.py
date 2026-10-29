"""devbox [-C project-dir] <command>: manage one persistent dev container per project.

Commands:
  up                create (if needed) and start the project container
  shell             open zsh in the workspace (starts the container if stopped)
  exec <cmd...>     run a command in the container
  stop              stop it (state is kept; `devbox up` starts it again)
  down              stop and delete the container (volumes are kept)
  recreate          down + up: apply changed config or a rebuilt image
  status            show state, address, ports and volumes
  logs              show container logs
  ssh-config        print the ssh host entry for editors (--install writes ~/.ssh/config.d/<name>)
  purge             down + delete this project's volumes (asks first)
  build [core|fullstack|all] [args...]
                    build the images (extra args go to the runtime's `build`)

Machine-level settings (e.g. DEVBOX_PROXY=...) go in ~/.config/devbox/config (or $DEVBOX_CONFIG).
Per-project settings go in <project-dir>/.devbox.env. Both are KEY=value lines, e.g.
  DEVBOX_PORTS="3000 8085"          # host:container or just a port; bound to 127.0.0.1
  DEVBOX_MEMORY=8G
  DEVBOX_NO_PROXY=floci,backend     # extra hosts to exempt from the proxy
See DEFAULTS in dotfiles/devbox/config.py for everything that can be set. Changing create-time
settings (ports, memory, image, ...) needs `devbox recreate`.

Runtime: Apple `container` on macOS, `wslc` on Windows and inside WSL (DEVBOX_RUNTIME overrides).
"""

from __future__ import annotations

import os
import pathlib
import re
import stat
import subprocess
import sys
import time

from dotfiles import platform
from dotfiles.devbox import build, config, runtime

COMMANDS = (
    "up",
    "shell",
    "exec",
    "stop",
    "down",
    "recreate",
    "status",
    "logs",
    "ssh-config",
    "purge",
    "build",
)


def die(msg: str) -> int:
    print(f"devbox: {msg}", file=sys.stderr)
    return 1


class Devbox:
    def __init__(self, cfg: config.Settings, rt: runtime.Runtime):
        self.cfg, self.rt = cfg, rt
        self.name = cfg.name

    # ---- steps ----------------------------------------------------------------
    def ensure_key(self) -> None:
        if not self.cfg.flag("DEVBOX_SSHD"):
            return
        key = self.cfg.ssh_key
        if not key.exists():
            print(f"creating SSH key {key} (no passphrase)")
            key.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            subprocess.run(
                [
                    "ssh-keygen",
                    "-q",
                    "-t",
                    "ed25519",
                    "-N",
                    "",
                    "-C",
                    "devbox dev container",
                    "-f",
                    str(key),
                ],
                check=True,
            )

    def ensure_volumes(self) -> None:
        for vol, _ in self.cfg.volumes(with_docker=self.rt.supports_caps):
            if self.rt.volume_exists(vol):
                continue
            size = self.cfg["DEVBOX_DOCKER_VOLUME_SIZE"] if vol == f"{self.name}-docker" else None
            self.rt.call(*self.rt.volume_create_args(vol, size))

    def create(self) -> None:
        pubkey = (
            self.cfg.ssh_key.with_name(self.cfg.ssh_key.name + ".pub").read_text().strip()
            if self.cfg.flag("DEVBOX_SSHD")
            else ""
        )
        agent = self.cfg.flag("DEVBOX_FORWARD_AGENT") and bool(os.environ.get("SSH_AUTH_SOCK"))
        if self.cfg.flag("DEVBOX_DOCKER") and not self.rt.supports_caps:
            print(
                f"note: {self.rt.name} cannot add capabilities, "
                "so Docker inside the container is off "
                "(set DEVBOX_DOCKER=0 to silence this)",
                file=sys.stderr,
            )
        self.rt.call(*self.rt.run_args(self.cfg, pubkey=pubkey, agent=agent))

    def wait_ready(self) -> None:
        print(f"waiting for {self.name}", end="", flush=True)
        for _ in range(120):
            r = subprocess.run(
                [self.rt.cli, "exec", self.name, "test", "-f", "/tmp/devbox-ready"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if r.returncode == 0:
                print(" ready")
                return
            print(".", end="", flush=True)
            time.sleep(1)
        print()
        raise runtime.DevboxError("container did not become ready; try: devbox logs")

    def up(self) -> None:
        state = self.rt.state(self.name)
        if state == "running":
            return
        if state == "stopped":
            self.rt.call("start", self.name)
        else:
            self.ensure_key()
            self.ensure_volumes()
            self.create()
        self.wait_ready()

    def stop(self) -> None:
        if self.rt.state(self.name) == "running":
            self.rt.call("stop", "-t", "40", self.name)

    def down(self) -> None:
        self.stop()
        if self.rt.state(self.name):
            self.rt.call(*self.rt.delete_args(self.name))
        known = config_home() / ".ssh" / "known_hosts_devbox"
        if self.cfg.flag("DEVBOX_SSHD") and known.exists():
            subprocess.run(
                [
                    "ssh-keygen",
                    "-q",
                    "-R",
                    f"[{self.rt.ssh_host}]:{self.cfg.ssh_port}",
                    "-f",
                    str(known),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def ssh_block(self) -> str:
        lines = [
            f"Host {self.name}",
            f"  HostName {self.rt.ssh_host}",
            f"  Port {self.cfg.ssh_port}",
            "  User dev",
            f"  IdentityFile {ssh_path(self.cfg.ssh_key)}",
            "  IdentitiesOnly yes",
            "  UserKnownHostsFile ~/.ssh/known_hosts_devbox",
            "  StrictHostKeyChecking accept-new",
        ]
        if not self.rt.supports_ssh_agent and self.cfg.flag("DEVBOX_FORWARD_AGENT"):
            lines += [
                "  # the runtime can't forward the agent into the container; ssh sessions can",
                "  ForwardAgent yes",
            ]
        return "\n".join(lines) + "\n"

    def install_ssh_config(self) -> pathlib.Path:
        # One file per project in ~/.ssh/config.d/ so ~/.ssh/config can be a managed symlink
        ssh_dir = config_home() / ".ssh"
        conf_d = ssh_dir / "config.d"
        conf_d.mkdir(mode=0o700, parents=True, exist_ok=True)
        entry = conf_d / self.name
        entry.write_text(self.ssh_block())
        if platform.os_name() != "windows":
            entry.chmod(0o600)
        main = ssh_dir / "config"
        text = main.read_text() if main.exists() else ""
        if not re.search(r"^\s*Include\s.*config\.d", text, re.MULTILINE):
            print(
                "note: add 'Include ~/.ssh/config.d/*' to the top of ~/.ssh/config so ssh reads it",
                file=sys.stderr,
            )
        return entry

    def exec_(self, args: list[str], tty: bool) -> int:
        # -i only when there is input to forward (a pipe or file): wslc fails on a NUL/closed stdin
        mode = ["-it"] if tty else (["-i"] if stdin_has_data() else [])
        cmd = [self.rt.cli, "exec", *mode, "-w", self.cfg["DEVBOX_WORKSPACE"], self.name, *args]
        if platform.os_name() == "windows":
            return subprocess.run(cmd).returncode
        os.execvp(cmd[0], cmd)  # hand the terminal over, as the bash version did
        return 0


def stdin_has_data() -> bool:
    """stdin is a pipe or a regular file (not a terminal, /dev/null or NUL)."""
    try:
        mode = os.fstat(sys.stdin.fileno()).st_mode
    except (OSError, ValueError, AttributeError):
        return False
    return stat.S_ISFIFO(mode) or stat.S_ISREG(mode)


def config_home() -> pathlib.Path:
    return pathlib.Path(os.path.expanduser("~"))


def ssh_path(p: pathlib.Path) -> str:
    """A path for ssh_config: ~-relative under home (nothing to quote), else quoted if needed."""
    try:
        return "~/" + p.relative_to(config_home()).as_posix()
    except ValueError:
        s = p.as_posix()
        return f'"{s}"' if " " in s else s


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    project = pathlib.Path.cwd()
    if argv[:1] == ["-C"]:
        if len(argv) < 2:
            return die("-C needs a directory")
        project = pathlib.Path(argv[1]).resolve()
        if not project.is_dir():
            return die(f"not a directory: {argv[1]}")
        argv = argv[2:]
    cmd, rest = (argv[0], argv[1:]) if argv else ("help", [])
    if cmd in ("help", "-h", "--help"):
        print(__doc__.strip())
        return 0
    if cmd not in COMMANDS:
        return die(f"unknown command '{cmd}' (try: devbox help)")

    cfg = config.settings(project)
    try:
        rt = runtime.select(cfg["DEVBOX_RUNTIME"] or os.environ.get("DEVBOX_RUNTIME", ""))
        if not rt.available():
            return die(
                f"'{rt.cli}' not found"
                + (" (needs WSL 2.9.3+: wsl --update)" if rt.name == "wslc" else "")
            )
        if cmd == "build":
            return build.main(rt, rest)
        box = Devbox(cfg, rt)
        return run(box, cmd, rest)
    except runtime.DevboxError as e:
        return die(str(e))
    except KeyboardInterrupt:
        return 130


def run(box: Devbox, cmd: str, rest: list[str]) -> int:
    cfg, name = box.cfg, box.name
    if cmd == "up":
        box.up()
        print(f"{name} is running (project: {cfg.project_dir} -> {cfg['DEVBOX_WORKSPACE']})")
        if cfg.flag("DEVBOX_SSHD"):
            print(f"ssh: ssh {name}   (run 'devbox ssh-config --install' once)")
    elif cmd == "shell":
        box.up()
        return box.exec_(["zsh"], tty=True)
    elif cmd == "exec":
        if not rest:
            return die("exec needs a command")
        box.up()
        return box.exec_(rest, tty=sys.stdin.isatty() and sys.stdout.isatty())
    elif cmd == "stop":
        box.stop()
    elif cmd == "down":
        box.down()
    elif cmd == "recreate":
        box.down()
        box.up()
    elif cmd == "status":
        s = box.rt.state(name)
        print(
            f"name:    {name}\nstate:   {s or 'not created'}\n"
            f"runtime: {box.rt.name}\nproject: {cfg.project_dir}"
        )
        if s:
            print(f"address: {box.rt.address(name)}")
        ssh = f" ssh={cfg.ssh_port}" if cfg.flag("DEVBOX_SSHD") else ""
        print(f"ports:   {cfg['DEVBOX_PORTS'] or 'none'}{ssh}")
        print("volumes:")
        for vol, _ in cfg.volumes(with_docker=box.rt.supports_caps):
            print(f"  {vol}")
    elif cmd == "logs":
        return box.rt.call("logs", name, quiet=False, check=False).returncode
    elif cmd == "ssh-config":
        if rest[:1] == ["--install"]:
            print(f"wrote {box.install_ssh_config()}")
        else:
            print(box.ssh_block(), end="")
    elif cmd == "purge":
        ans = input(f"Delete container {name} and ALL its volumes (Docker images, caches)? [y/N] ")
        if ans not in ("y", "Y"):
            return die("aborted")
        box.down()
        for vol, _ in cfg.volumes(with_docker=box.rt.supports_caps):
            box.rt.call(*box.rt.volume_delete_args(vol), check=False)
    return 0
