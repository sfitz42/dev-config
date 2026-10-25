"""Shared helpers: context (dry-run, backups), output, symlinks, copies.

Every state-changing action goes through here so --dry-run is honoured everywhere.
"""

from __future__ import annotations

import dataclasses
import os
import pathlib
import shutil
import subprocess
import sys
import time
from typing import Any

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def home() -> pathlib.Path:
    return pathlib.Path(os.path.expanduser("~"))


def expand(p: str | pathlib.Path) -> pathlib.Path:
    return pathlib.Path(os.path.expanduser(str(p)))


def state_dir() -> pathlib.Path:
    base = os.environ.get("XDG_STATE_HOME") or str(home() / ".local" / "state")
    return pathlib.Path(base) / "dotfiles"


_COLOR = sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def info(msg: str = "") -> None:
    print(msg)


def ok(msg: str) -> None:
    print(f"{_c('32', '✓')} {msg}")


def warn(msg: str) -> None:
    print(f"{_c('33', '!')} {msg}", file=sys.stderr)


def err(msg: str) -> None:
    print(f"{_c('31', '✗')} {msg}", file=sys.stderr)


def step(msg: str) -> None:
    print(f"\n{_c('2', '==>')} {msg}")


@dataclasses.dataclass
class Ctx:
    dry_run: bool = False
    yes: bool = False
    backup_root: pathlib.Path = dataclasses.field(
        default_factory=lambda: home() / ".config-backups"
    )
    stamp: str = dataclasses.field(default_factory=lambda: time.strftime("%Y%m%d-%H%M%S"))
    linked: int = 0
    unchanged: int = 0
    backed_up: int = 0
    # per-run one-off steps (sudo approval, apt update)
    once: dict[str, bool] = dataclasses.field(default_factory=dict)

    @property
    def backup_dir(self) -> pathlib.Path:
        return self.backup_root / self.stamp

    def say(self, msg: str) -> None:
        print(f"{_c('2', '[dry-run]')} {msg}" if self.dry_run else msg)

    def confirm(self, question: str) -> bool:
        if self.yes:
            return True
        if not sys.stdin.isatty():
            return False
        return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")

    def run(
        self, cmd: list[str], *, check: bool = True, **kw: Any
    ) -> subprocess.CompletedProcess[Any] | None:
        """Run a command, or just print it under --dry-run."""
        if self.dry_run:
            self.say(" ".join(str(c) for c in cmd))
            return None
        return subprocess.run(cmd, check=check, **kw)

    def summary(self) -> None:
        info(f"\nlinked: {self.linked}, unchanged: {self.unchanged}, backed up: {self.backed_up}")
        if self.backed_up and not self.dry_run:
            info(f"backups: {self.backup_dir}")
        if self.dry_run:
            info("(dry run: nothing was changed)")


def backup_path(ctx: Ctx, path: pathlib.Path) -> pathlib.Path:
    """Move an existing file/dir/symlink into the backup dir and record it in manifest.tsv."""
    try:
        rel = path.relative_to(home())
    except ValueError:
        rel = pathlib.Path("_abs") / str(path).lstrip("/")
    dest = ctx.backup_dir / rel
    if ctx.dry_run:
        ctx.say(f"backup {path} -> {dest}")
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(dest))
        with open(ctx.backup_dir / "manifest.tsv", "a") as f:
            f.write(f"{path}\t{dest}\n")
    ctx.backed_up += 1
    return dest


def _record_link(ctx: Ctx, src: pathlib.Path, dst: pathlib.Path) -> None:
    if ctx.dry_run:
        return
    sd = state_dir()
    sd.mkdir(parents=True, exist_ok=True)
    f = sd / "links.tsv"
    line = f"{dst}\t{src}\n"
    existing = f.read_text().splitlines(keepends=True) if f.exists() else []
    # one record per destination (a moved repo replaces its old one)
    kept = [rec for rec in existing if not rec.startswith(f"{dst}\t")]
    f.write_text("".join(kept) + line)


def link_file(ctx: Ctx, src: pathlib.Path, dst: pathlib.Path) -> bool:
    """Make dst a symlink to src. No-op if already linked; backs up anything in the way."""
    if not src.exists():
        err(f"link source missing: {src}")
        return False
    if dst.is_symlink() and pathlib.Path(os.readlink(dst)) == src:
        ctx.unchanged += 1
        info(f"= {dst} (already linked)")
        _record_link(ctx, src, dst)
        return True
    if dst.is_symlink() and not dst.exists():
        # dangling link (e.g. the repo was moved): nothing to preserve, so repoint without a backup
        ctx.say(f"repoint stale link {dst} (was -> {os.readlink(dst)})")
        if not ctx.dry_run:
            dst.unlink()
    elif dst.exists() or dst.is_symlink():
        backup_path(ctx, dst)
    if ctx.dry_run:
        ctx.say(f"link {dst} -> {src}")
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.symlink_to(src)
        _record_link(ctx, src, dst)
        ok(f"{dst} -> {src}")
    ctx.linked += 1
    return True


def copy_if_missing(ctx: Ctx, src: pathlib.Path, dst: pathlib.Path) -> bool:
    """Copy src to dst only if dst does not exist (for files that apps rewrite themselves)."""
    if not src.exists():
        err(f"copy source missing: {src}")
        return False
    if dst.exists() or dst.is_symlink():
        ctx.unchanged += 1
        info(f"= {dst} (exists, left alone)")
        return True
    if ctx.dry_run:
        ctx.say(f"copy {src} -> {dst}")
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        ok(f"copied {src} -> {dst}")
    ctx.linked += 1
    return True


def ensure_dir(ctx: Ctx, path: pathlib.Path, mode: int = 0o755) -> None:
    if path.is_dir():
        return
    if ctx.dry_run:
        ctx.say(f"mkdir -m {mode:o} {path}")
    else:
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(mode)


def snapshot(ctx: Ctx, path: pathlib.Path) -> None:
    """Copy a file into the backup dir before it is modified in place (no restore record)."""
    if not path.exists():
        return
    try:
        rel = path.relative_to(home())
    except ValueError:
        rel = pathlib.Path("_abs") / str(path).lstrip("/")
    dest = ctx.backup_dir / rel
    if ctx.dry_run:
        ctx.say(f"snapshot {path} -> {dest}")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
