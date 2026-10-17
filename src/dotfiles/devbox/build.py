"""Build dev-core and dev-fullstack (replaces devcontainers/build.sh).

  devbox build [core|fullstack|all] [extra `build` args]
  CORE_TAG=dev-core:0.1.0 FULLSTACK_TAG=dev-fullstack:0.1.0 devbox build

Shared config (config/zsh, starship.toml) and local/certificates/*.crt are staged into the
git-ignored build context first, so the images use the same shell config and trust the same CAs.

Proxy (optional, for networks that block the container VM):
  - Apple `container`: enabled when local/proxy/tinyproxy.conf exists (or USE_PROXY=1/0); starts
    tinyproxy on the VM bridge (192.168.64.1:8888) and passes it as build args
  - any runtime: BUILD_PROXY=http://host:port uses that proxy as-is (with wslc the Windows host
    is reachable from builds as host.wslc.internal)
Proxy build args are only used while building; they are not stored in the image.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from ..core import REPO_ROOT
from .runtime import AppleContainer, DevboxError, Runtime

CONTEXT = REPO_ROOT / "devcontainers"
TARGETS = ("core", "fullstack", "all")
BRIDGE_HOST, BRIDGE_PORT = "192.168.64.1", 8888
PIDFILE = Path("/tmp/tinyproxy.pid")


def stage(repo: Path = REPO_ROOT, context: Path = CONTEXT) -> None:
    cfg = context / "config"
    shutil.rmtree(cfg, ignore_errors=True)
    cfg.mkdir(parents=True)
    shutil.copy2(repo / "config" / "starship" / "starship.toml", cfg / "starship.toml")
    shutil.copytree(repo / "config" / "zsh", cfg / "zsh")
    certs = context / "certificates"
    certs.mkdir(exist_ok=True)
    for old in certs.glob("*.crt"):
        old.unlink()
    for c in sorted((repo / "local" / "certificates").glob("*.crt")):
        shutil.copy2(c, certs / c.name)


def proxy_args(url: str) -> list[str]:
    args = []
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        args += ["--build-arg", f"{k}={url}"]
    for k in ("NO_PROXY", "no_proxy"):
        args += ["--build-arg", f"{k}=localhost,127.0.0.1"]
    return args


def _pid_alive(pidfile: Path) -> bool:
    try:
        os.kill(int(pidfile.read_text().strip()), 0)
        return True
    except (OSError, ValueError):
        return False


def _start_tinyproxy(conf: Path) -> None:
    if not shutil.which("tinyproxy"):
        raise DevboxError("tinyproxy not found: brew install tinyproxy")
    if not conf.exists():
        raise DevboxError(f"USE_PROXY=1 needs {conf}")

    def bridge_up() -> bool:
        out = subprocess.run(["ifconfig", "bridge100"], capture_output=True, text=True).stdout
        return f"inet {BRIDGE_HOST} " in out

    for _ in range(30):
        if bridge_up():
            break
        time.sleep(1)
    else:
        raise DevboxError(f"bridge100 never got {BRIDGE_HOST}")
    if not _pid_alive(PIDFILE):
        subprocess.run(["tinyproxy", "-c", str(conf)], check=True)
        time.sleep(1)


def resolve_proxy(rt: Runtime, repo: Path = REPO_ROOT) -> str:
    """The proxy URL for this build, or '' (starting tinyproxy where that applies)."""
    if os.environ.get("BUILD_PROXY"):
        return os.environ["BUILD_PROXY"]
    conf = repo / "local" / "proxy" / "tinyproxy.conf"
    use = os.environ.get("USE_PROXY", "1" if conf.exists() else "0") == "1"
    if not use:
        return ""
    if not isinstance(rt, AppleContainer):
        raise DevboxError(f"the tinyproxy setup is for Apple `container`; with {rt.name} set "
                          "BUILD_PROXY=http://host.wslc.internal:<port> (or USE_PROXY=0)")
    _start_tinyproxy(conf)
    return f"http://{BRIDGE_HOST}:{BRIDGE_PORT}"


def build_args(tag: str, dockerfile: str, proxy: str, extra: list[str]) -> list[str]:
    return ["build", *(proxy_args(proxy) if proxy else []), "-t", tag, "-f", dockerfile, *extra, "."]


def main(rt: Runtime, argv: list[str]) -> int:
    target = "all"
    if argv and argv[0] in TARGETS:
        target, argv = argv[0], argv[1:]
    core_tag = os.environ.get("CORE_TAG", "dev-core:0.1.0")
    full_tag = os.environ.get("FULLSTACK_TAG", "dev-fullstack:0.1.0")

    stage()
    rt.prepare_build()
    proxy = resolve_proxy(rt)

    def run(args: list[str]) -> None:
        print(f"==> {rt.cli} {' '.join(args)}", file=sys.stderr)
        r = subprocess.run([rt.cli, *args], cwd=CONTEXT)
        if r.returncode != 0:
            raise DevboxError(f"build failed (exit {r.returncode})")

    if target in ("core", "all"):
        run(build_args(core_tag, "images/core.Dockerfile", proxy, argv))
    if target in ("fullstack", "all"):
        run(build_args(full_tag, "images/dev-fullstack.Dockerfile", proxy,
                       ["--build-arg", f"CORE_IMAGE={core_tag}", *argv]))
    return 0
