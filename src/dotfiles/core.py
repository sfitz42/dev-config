"""Shared helpers: context (dry-run, backups), output, symlinks, copies.

Every state-changing action goes through here so --dry-run is honoured everywhere.
"""

from __future__ import annotations

import codecs
import dataclasses
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
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


def print_sink(level: str, msg: str) -> None:
    """Default output: the terminal. Levels: info, ok, warn, err, step, dry, out, progress."""
    if level == "progress":
        return  # live redraws; the final state of each bar arrives as "out"
    if level == "ok":
        print(f"{_c('32', '✓')} {msg}")
    elif level == "warn":
        print(f"{_c('33', '!')} {msg}", file=sys.stderr)
    elif level == "err":
        print(f"{_c('31', '✗')} {msg}", file=sys.stderr)
    elif level == "step":
        print(f"\n{_c('2', '==>')} {msg}")
    elif level == "dry":
        print(f"{_c('2', '[dry-run]')} {msg}")
    else:
        print(msg)


# Where all output goes; the wizard swaps this for its log pane
SINK: Callable[[str, str], None] = print_sink


def info(msg: str = "") -> None:
    SINK("info", msg)


def ok(msg: str) -> None:
    SINK("ok", msg)


def warn(msg: str) -> None:
    SINK("warn", msg)


def err(msg: str) -> None:
    SINK("err", msg)


def step(msg: str) -> None:
    SINK("step", msg)


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
    # set by the wizard: answer prompts in a dialog, and pipe command output into the sink
    ask: Callable[[str], bool] | None = None
    stream: bool = False

    @property
    def backup_dir(self) -> pathlib.Path:
        return self.backup_root / self.stamp

    def say(self, msg: str) -> None:
        SINK("dry" if self.dry_run else "info", msg)

    def confirm(self, question: str) -> bool:
        if self.yes:
            return True
        if self.ask is not None:
            return self.ask(question)
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
        if not self.stream:
            return subprocess.run(cmd, check=check, **kw)
        return _run_streamed(cmd, check=check, **kw)

    def summary(self) -> None:
        info(f"\nlinked: {self.linked}, unchanged: {self.unchanged}, backed up: {self.backed_up}")
        if self.backed_up and not self.dry_run:
            info(f"backups: {self.backup_dir}")
        if self.dry_run:
            info("(dry run: nothing was changed)")


_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
# a redraw: back to the start of the line (\r, or "cursor to column N" as ollama does)
_REDRAW = re.compile(r"\r|\x1b\[\d*G")
# progress output: a percentage, or a braille spinner at the end ("pulling manifest ⠋")
_PROGRESS = re.compile(r"^(.*?)\s*(?:\d{1,3}%.*|[⠀-⣿])$")


def _progress_key(line: str) -> str | None:
    """What a progress line is about ("pulling 8a43277aac50:"), or None for other output."""
    m = _PROGRESS.match(line)
    return m.group(1).strip() if m else None


class _Stream:
    """Turns a command's raw output into sink calls.

    Programs that draw progress bars redraw lines in place, with \\r or escape codes and no
    newline, sometimes several bars at once. Without a terminal that would arrive as one endless
    line (shown only when the command ends) or as thousands of copies. Here every redraw goes to
    the sink as "progress", which the wizard shows on one live line, and each bar's final state
    goes to "out" once, when the command finishes."""

    def __init__(self) -> None:
        self.bars: dict[str, str] = {}  # progress key -> latest text, in first-seen order
        self.said: set[str] = set()  # lines already sent; redraws repeat them
        self.last_progress = 0.0

    def segment(self, text: str, final: bool) -> None:
        line = _ANSI.sub("", text).strip()
        if not line:
            return
        key = _progress_key(line)
        if key is not None:
            if line in self.said:  # a finished bar, redrawn along with the others
                return
            self.bars[key] = line
            now = time.monotonic()
            if now - self.last_progress > 0.15:
                SINK("progress", line)
                self.last_progress = now
            return
        if not final or line in self.said:
            return
        self.bars.pop(line, None)  # "pulling manifest" done: drop its spinner
        self.flush()  # a new line means the bars before it are finished
        self.said.add(line)
        SINK("out", line)

    def flush(self) -> None:
        for line in self.bars.values():
            self.said.add(line)
            SINK("out", line)
        self.bars.clear()

    def feed(self, buf: str) -> str:
        """Handle every complete line in buf; return the unfinished rest."""
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            parts = _REDRAW.split(line)
            for part in parts[:-1]:
                self.segment(part, final=False)
            self.segment(parts[-1], final=True)
        parts = _REDRAW.split(buf)
        for part in parts[:-1]:  # redrawn already: only ever progress
            self.segment(part, final=False)
        return parts[-1]

    def close(self, rest: str) -> None:
        self.segment(rest, final=True)
        self.flush()


def _run_streamed(cmd: list[str], *, check: bool, **kw: Any) -> subprocess.CompletedProcess[Any]:
    """Run without a terminal: stdin closed, stdout and stderr sent to the sink as they arrive."""
    proc = subprocess.Popen(
        cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kw
    )
    assert proc.stdout is not None
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    stream, buf, fd = _Stream(), "", proc.stdout.fileno()
    while chunk := os.read(fd, 65536):  # whatever has arrived; no waiting for a newline
        buf = stream.feed(buf + decoder.decode(chunk))
    stream.close(buf + decoder.decode(b"", final=True))
    code = proc.wait()
    if check and code:
        raise subprocess.CalledProcessError(code, cmd)
    return subprocess.CompletedProcess(cmd, code)


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
