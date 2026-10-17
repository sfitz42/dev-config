"""Install tools from packages.yaml, trying each package's sources in order."""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .core import REPO_ROOT, Ctx, err, expand, home, info, ok, step, warn

BREW_BIN = "/opt/homebrew/bin"


@dataclass
class Opts:
    prefer: list[str] = field(default_factory=list)   # source types to try first
    no_brew: bool = False
    names: list[str] = field(default_factory=list)     # restrict to these packages
    with_optional: bool = False


# ---- manifest -------------------------------------------------------------

def load_manifest(root: Path = REPO_ROOT) -> dict:
    """packages.yaml merged with local/packages.local.yaml (prefer / exclude / defaults / packages)."""
    data = yaml.safe_load((root / "packages.yaml").read_text())
    data.setdefault("defaults", {})
    data.setdefault("external_repos", {})
    local = root / "local" / "packages.local.yaml"
    if local.exists():
        extra = yaml.safe_load(local.read_text()) or {}
        data["defaults"].update(extra.get("defaults", {}))
        data["prefer"] = extra.get("prefer", [])
        for name in extra.get("exclude", []):
            data["packages"].pop(name, None)
        for name, override in extra.get("packages", {}).items():
            data["packages"].setdefault(name, {}).update(override)
        data["external_repos"].update(extra.get("external_repos", {}))
    return data


# ---- checks ---------------------------------------------------------------

def _which(cmd: str) -> bool:
    extra = [BREW_BIN, str(home() / ".local" / "bin"), "/usr/local/bin"]
    path = os.pathsep.join([os.environ.get("PATH", ""), *extra])
    return shutil.which(cmd, path=path) is not None


def is_installed(check: dict) -> bool:
    (kind, value), = check.items()
    if kind in ("app", "dir"):
        return expand(value).exists()
    if kind == "cmd":
        return _which(value)
    if kind == "gh_extension":
        if not _which("gh"):
            return False
        out = subprocess.run(["gh", "extension", "list"], capture_output=True, text=True).stdout
        return re.search(rf"gh-{re.escape(value)}\b", out) is not None
    if kind == "font":
        fonts = [home() / "Library/Fonts", Path("/Library/Fonts")]
        needle = value.replace(" ", "").lower()
        return any(needle[:5] in p.name.lower() for d in fonts if d.exists() for p in d.iterdir())
    raise ValueError(f"unknown check type: {kind}")


# ---- source selection -----------------------------------------------------

def ordered_sources(pkg: dict, defaults: dict, opts: Opts, prefer_local: list[str] | None = None) -> list[dict]:
    sources = list(pkg.get("sources", []))
    if not defaults.get("brew_casks", False):
        sources = [s for s in sources if s["type"] != "brew-cask"]
    if opts.no_brew or not _which("brew"):
        sources = [s for s in sources if s["type"] not in ("brew", "brew-cask")]
    prefer = opts.prefer or prefer_local or []
    if prefer:
        rank = {t: i for i, t in enumerate(prefer)}
        sources.sort(key=lambda s: rank.get(s["type"], len(rank)))   # stable: keeps manifest order within a rank
    return sources


# ---- download and verify --------------------------------------------------

def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(ctx: Ctx, url: str, dest_dir: Path, sha256: str | None) -> Path | None:
    name = Path(url.split("?")[0]).name or "download"
    dest = dest_dir / name
    if ctx.dry_run:
        ctx.say(f"download {url}" + (f" (sha256 {sha256[:12]}…)" if sha256 else " (UNPINNED)"))
        return dest
    info(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "dev-config-installer"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    if sha256:
        got = sha256_of(dest)
        if got != sha256:
            err(f"  sha256 mismatch for {name}: expected {sha256}, got {got}")
            dest.unlink()
            return None
        ok(f"  sha256 verified ({sha256[:12]}…)")
    return dest


def team_id_of(path: Path) -> str | None:
    out = subprocess.run(["codesign", "-dv", "--verbose=4", str(path)], capture_output=True, text=True)
    m = re.search(r"TeamIdentifier=(\S+)", out.stderr + out.stdout)
    return m.group(1) if m else None


# ---- per-source installers (each returns True on success) ------------------

def _brew(ctx, s, name):       return _ok(ctx.run(["brew", "install", s["name"]], check=False))
def _brew_cask(ctx, s, name):  return _ok(ctx.run(["brew", "install", "--cask", s["name"]], check=False))
def _gh_ext(ctx, s, name):     return _ok(ctx.run(["gh", "extension", "install", s["repo"]], check=False))


def _ok(cp) -> bool:
    return True if cp is None else cp.returncode == 0   # None = dry run


def _git(ctx, s, name):
    dest = expand(s["dest"])
    ok_ = _ok(ctx.run(["git", "clone", "--depth", "1", s["url"], str(dest)], check=False))
    if ok_ and s.get("ref"):
        ok_ = _ok(ctx.run(["git", "-C", str(dest), "checkout", s["ref"]], check=False))
    return ok_


def _dmg(ctx, s, name):
    with tempfile.TemporaryDirectory(prefix="dotfiles-") as tmp:
        f = download(ctx, s["url"], Path(tmp), s.get("sha256"))
        if f is None:
            return False
        if ctx.dry_run:
            ctx.say(f"mount, verify Team ID {s.get('team_id')}, copy {s['app']} to /Applications")
            return True
        mnt = Path(tmp) / "mnt"
        mnt.mkdir()
        subprocess.run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mnt), str(f)],
                       check=True, capture_output=True)
        try:
            app = next(mnt.glob(f"**/{s['app']}"), None) or (mnt / s["app"])
            got = team_id_of(app)
            if s.get("team_id") and got != s["team_id"]:
                err(f"  Team ID mismatch for {s['app']}: expected {s['team_id']}, got {got}")
                return False
            subprocess.run(["ditto", str(app), f"/Applications/{s['app']}"], check=True)
            ok(f"  installed /Applications/{s['app']} (Team ID {got})")
            return True
        finally:
            subprocess.run(["hdiutil", "detach", "-quiet", str(mnt)], check=False)


def _pkg(ctx, s, name):
    with tempfile.TemporaryDirectory(prefix="dotfiles-") as tmp:
        f = download(ctx, s["url"], Path(tmp), s.get("sha256"))
        if f is None:
            return False
        if not ctx.dry_run and not ctx.confirm(f"  {name}: run the installer with sudo?"):
            warn("  skipped (needs admin approval)")
            return False
        return _ok(ctx.run(["sudo", "installer", "-pkg", str(f), "-target", "/"], check=False))


def _script(ctx, s, name):
    pinned = s.get("pinned", True) and s.get("sha256")
    if not pinned and not ctx.dry_run and not ctx.confirm(
            f"  {name}: run UNPINNED vendor script {s['url']}?"):
        warn("  skipped (unpinned script not approved; pass --yes to allow)")
        return False
    with tempfile.TemporaryDirectory(prefix="dotfiles-") as tmp:
        f = download(ctx, s["url"], Path(tmp), s.get("sha256"))
        if f is None:
            return False
        return _ok(ctx.run(["/bin/sh", str(f)], check=False))


HANDLERS = {"brew": _brew, "brew-cask": _brew_cask, "gh-extension": _gh_ext, "git": _git,
            "dmg": _dmg, "pkg": _pkg, "script": _script}


def install_package(ctx: Ctx, name: str, pkg: dict, data: dict, opts: Opts) -> str:
    """Returns: present | installed | manual | failed | skipped."""
    if is_installed(pkg["check"]):
        info(f"= {name} (present)")
        return "present"
    if pkg.get("optional") and not opts.with_optional and name not in opts.names:
        info(f"- {name} (optional, skipped)")
        return "skipped"
    for s in ordered_sources(pkg, data["defaults"], opts, data.get("prefer")):
        if s["type"] == "web":
            warn(f"{name}: install manually from {s['url']}")
            return "manual"
        info(f"+ {name} via {s['type']}")
        if HANDLERS[s["type"]](ctx, s, name):
            return "installed"
        warn(f"  {s['type']} failed for {name}; trying next source")
    err(f"{name}: no usable source")
    return "failed"


def install_all(ctx: Ctx, opts: Opts, root: Path = REPO_ROOT) -> dict[str, str]:
    data = load_manifest(root)
    step("packages")
    results = {}
    for name, pkg in data["packages"].items():
        if opts.names and name not in opts.names:
            continue
        results[name] = install_package(ctx, name, pkg, data, opts)
    return results


def install_repos(ctx: Ctx, opts: Opts, root: Path = REPO_ROOT) -> None:
    step("external repos")
    for name, r in load_manifest(root)["external_repos"].items():
        dest = expand(r["dest"])
        if dest.exists():
            info(f"= {name} ({dest} exists, left alone)")
            continue
        info(f"+ {name}")
        _git(ctx, r, name)


def check_all(root: Path = REPO_ROOT) -> list[tuple[str, bool, bool]]:
    """(name, installed, optional) for every package."""
    data = load_manifest(root)
    return [(n, is_installed(p["check"]), bool(p.get("optional"))) for n, p in data["packages"].items()]
