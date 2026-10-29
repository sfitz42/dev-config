"""Pull the local models listed in models.yaml, into oMLX and/or Ollama.

  dotfiles models                          # every runtime found on this machine
  dotfiles models --runtime ollama         # one runtime
  dotfiles models Qwen3.8-27B-4bit         # only these names (from that runtime's list)

Under WSL, Ollama models go to Ollama on Windows (ollama.exe): one model store and one server on
port 11434, rather than a second copy of everything inside WSL. Downloads resume and skip what is
already present, so re-running is safe (for a pulled Ollama model it is a quick manifest check).
"""

from __future__ import annotations

import dataclasses
import glob
import json
import os
import pathlib
import shutil
import socket
import urllib.request
from typing import Any

import yaml

from dotfiles import core, platform

RUNTIMES = ("omlx", "ollama")
EXCLUDE_NEWER = "1 week"
OLLAMA_PORT = 11434
OLLAMA_API = f"http://127.0.0.1:{OLLAMA_PORT}"


def load_manifest(root: pathlib.Path = core.REPO_ROOT) -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load((root / "models.yaml").read_text())
    return data


def entries(spec: dict[str, Any]) -> list[tuple[str, str]]:
    """(name, size) for each model in a runtime's list; entries are a name or {name, size}."""
    out = []
    for m in spec.get("models", []):
        out.append((m, "") if isinstance(m, str) else (str(m["name"]), str(m.get("size", ""))))
    return out


def names(spec: dict[str, Any]) -> list[str]:
    return [n for n, _ in entries(spec)]


# ---- oMLX -----------------------------------------------------------------------------------


def model_dir() -> str:
    return os.environ.get("OMLX_MODEL_DIR") or str(core.home() / ".omlx" / "models")


def omlx_cmd(spec: dict[str, Any], name: str, dest: str) -> list[str]:
    org = spec["org"]
    return [
        "uvx",
        "--exclude-newer",
        EXCLUDE_NEWER,
        "--from",
        f"huggingface_hub=={spec['hf_version']}",
        "hf",
        "download",
        f"{org}/{name}",
        "--local-dir",
        f"{dest}/{org}/{name}",
    ]


def pull_omlx(ctx: core.Ctx, spec: dict[str, Any], wanted: list[str]) -> bool:
    if shutil.which("uvx") is None and not ctx.dry_run:
        core.err("uvx not found on PATH (install uv)")
        return False
    dest, good = model_dir(), True
    have = installed("omlx", spec) or set()
    for name in wanted:
        core.info(f"+ {spec['org']}/{name}" + (" (pulled; checking files)" if name in have else ""))
        cp = ctx.run(omlx_cmd(spec, name, dest), check=False)
        ok_ = cp is None or cp.returncode == 0
        if ok_ and not ctx.dry_run:
            core.ok(f"{name} ready")
        good &= ok_
    core.info("Restart the server to pick up new models: omlx restart")
    return good


# ---- Ollama ---------------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Ollama:
    exe: str
    windows: bool  # ollama.exe on the Windows side of WSL

    @property
    def cwd(self) -> str | None:
        # a Windows exe started from a WSL directory warns about UNC paths; give it a Windows one
        return "/mnt/c" if self.windows and os.path.isdir("/mnt/c") else None


def _windows_ollama() -> str | None:
    found = shutil.which("ollama.exe")
    if found:
        return found
    # not on PATH (interop PATH appending turned off): the per-user install location
    hits = glob.glob("/mnt/c/Users/*/AppData/Local/Programs/Ollama/ollama.exe")
    return hits[0] if hits else None


def linux_ollama() -> str | None:
    extra = [str(core.home() / ".local" / "bin"), "/usr/local/bin", "/opt/homebrew/bin"]
    return shutil.which("ollama", path=os.pathsep.join([os.environ.get("PATH", ""), *extra]))


def find_ollama() -> Ollama | None:
    """The Ollama to pull into. Under WSL that is only ever the Windows one."""
    if platform.is_wsl():
        exe = _windows_ollama()
        return Ollama(exe, windows=True) if exe else None
    exe = linux_ollama()
    return Ollama(exe, windows=False) if exe else None


def reachable(host: str = "127.0.0.1", port: int = OLLAMA_PORT) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def _api(path: str) -> Any:
    """GET from the local Ollama server, or None if it isn't running or reachable. Read-only,
    and unlike the CLI it never starts the server."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_API}{path}", timeout=2) as r:
            return json.loads(r.read())
    except (OSError, ValueError):
        return None


def ollama_version() -> str | None:
    data = _api("/api/version")
    return str(data["version"]) if isinstance(data, dict) and "version" in data else None


def _tag(name: str) -> str:
    return name if ":" in name else f"{name}:latest"


def installed(runtime: str, spec: dict[str, Any]) -> set[str] | None:
    """Which of the listed models are already pulled, or None if that can't be told (the Ollama
    server isn't running)."""
    if runtime == "omlx":
        base = pathlib.Path(model_dir()) / spec["org"]
        return {n for n in names(spec) if (base / n).is_dir()}
    data = _api("/api/tags")
    if not isinstance(data, dict):
        return None
    have = {_tag(m.get("name", "")) for m in data.get("models", [])}
    return {n for n in names(spec) if _tag(n) in have}


def wsl_warnings() -> list[str]:
    """Things worth knowing when Ollama lives on Windows and the tools live in WSL."""
    if not platform.is_wsl():
        return []
    out = []
    if linux_ollama():
        out.append(
            "a Linux ollama is installed inside WSL. Models are pulled into Ollama on Windows "
            "instead: it uses the GPU through the Windows driver directly (GPU passthrough into "
            "WSL can break with driver or WSL updates), the two keep separate model stores "
            "(everything twice on disk), and with mirrored networking both want port 11434. "
            "Best removed, or at least left stopped."
        )
    if _windows_ollama() is None:
        out.append(
            "no Ollama on Windows found. Install it on the Windows side (winget install "
            "Ollama.Ollama) rather than inside WSL: it gets the GPU without relying on WSL's GPU "
            "passthrough, and there is one model store and one server."
        )
    return out


TOO_OLD = "requires ollama version"


def pull_ollama(ctx: core.Ctx, spec: dict[str, Any], wanted: list[str]) -> bool:
    for w in wsl_warnings():
        core.warn(w)
    o = find_ollama()
    if o is None:
        if not platform.is_wsl():
            core.err("ollama not found: install it (scripts/dotfiles packages ollama)")
        return False
    version = ollama_version()
    where = "Ollama on Windows" if o.windows else "Ollama"
    core.info(f"pulling into {where}" + (f" {version}" if version else "") + f" ({o.exe})")
    have = installed("ollama", spec) or set()
    # watch the output for "model requires ollama version …" to say what to do about it
    output: list[str] = []
    outer = core.SINK

    def watch(level: str, msg: str) -> None:
        if level == "out":
            output.append(msg)
        outer(level, msg)

    core.SINK = watch
    good = True
    try:
        for name in wanted:
            core.info(f"+ {name}" + (" (pulled; checking for updates)" if name in have else ""))
            cp = ctx.run([o.exe, "pull", name], cwd=o.cwd, check=False)
            ok_ = cp is None or cp.returncode == 0
            if ok_ and not ctx.dry_run:
                core.ok(f"{name} ready")
            good &= ok_
    finally:
        core.SINK = outer
    if any(TOO_OLD in line for line in output):
        how = "on Windows (it offers updates from the tray, or winget upgrade Ollama.Ollama)"
        core.warn(f"{where} is too old for some models: update it {how if o.windows else ''}")
    if o.windows and not ctx.dry_run and not reachable():
        core.warn(
            f"Ollama on Windows isn't reachable at localhost:{OLLAMA_PORT} from WSL, so agents "
            "here can't use it. Set networkingMode=mirrored in %UserProfile%\\.wslconfig "
            "(then wsl --shutdown), or point OLLAMA_HOST at the Windows host."
        )
    return good


# ---- both -----------------------------------------------------------------------------------


def available(runtime: str, plat: platform.Platform) -> tuple[bool, str]:
    """(usable here, a note for the wizard)."""
    if runtime == "omlx":
        return plat.apple_silicon, "" if plat.apple_silicon else "Apple Silicon only"
    if plat.ollama == "windows":
        return True, "into Ollama on Windows"
    if plat.ollama == "native":
        return True, ""
    return False, "Ollama for Windows not found" if plat.wsl else "ollama not installed"


def pull(
    ctx: core.Ctx,
    runtime: str | None = None,
    only: list[str] | None = None,
    root: pathlib.Path = core.REPO_ROOT,
) -> bool:
    manifest = load_manifest(root)
    plat = platform.describe()
    runtimes = [runtime] if runtime else [r for r in RUNTIMES if available(r, plat)[0]]
    if not runtimes:
        core.err("no model runtime here: oMLX needs Apple Silicon, and Ollama was not found")
        for w in wsl_warnings():
            core.warn(w)
        return False
    good = True
    for rt in runtimes:
        spec = manifest[rt]
        listed = names(spec)
        wanted = [n for n in listed if not only or n in only]
        unknown = [n for n in only or [] if n not in listed]
        if unknown and runtime:
            core.err(f"not in the {rt} list in models.yaml: {', '.join(unknown)}")
            good = False
        core.step(f"models: {rt}")
        if not wanted:
            core.info("  (nothing to pull)")
            continue
        good &= (pull_omlx if rt == "omlx" else pull_ollama)(ctx, spec, wanted)
    return good
