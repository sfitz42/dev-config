"""A pretend install for watching the installing page: every stage plays for a while, with
made-up output and download bars, and nothing is touched. `wizard --demo`."""

from __future__ import annotations

import argparse
import time
from collections.abc import Callable

from dotfiles import core

KINDS = ("install", "fail", "remove")

# (step heading as install.run would print it, how long it plays relative to the pace,
#  the log lines it writes, and what its download bar is called, if it has one)
STAGES: list[tuple[str, float, list[str], str | None]] = [
    ("update repo", 1, ["fast-forward 09353b8..6f1c2aa"], "origin/main"),
    ("packages", 1.5, ["gh: installed", "ripgrep: installed", "starship: installed"], "brew"),
    ("external repos", 1, ["cloned zsh-autosuggestions"], None),
    ("link: zsh", 1, ["~/.zshrc -> config/zsh/.zshrc (backed up the old one)"], None),
    ("agent: claude", 1, ["settings synced", "plugins: 3 enabled"], None),
    ("models: ollama", 2, ["gpt-oss:20b: pulled"], "gpt-oss:20b"),
    ("devbox build core", 1, ["built devbox:core"], "core.Dockerfile"),
    ("doctor: checking the result", 1, ["links ok", "packages ok"], None),
]
REMOVED = ["~/.zshrc", "~/.zshenv", "~/.config/git/config", "~/.config/starship.toml"]


def _bar(name: str, done: float) -> str:
    width = 24
    filled = round(done * width)
    return f"{name}  {'━' * filled}{' ' * (width - filled)}  {done * 100:3.0f}%"


def _play(seconds: float, lines: list[str], bar: str | None) -> None:
    """Spread the stage's output over its time, with a download bar redrawing if it has one."""
    ticks = max(int(seconds * 10), 1)
    due = {j * ticks // len(lines): line for j, line in enumerate(lines)}
    for i in range(ticks):
        if bar:
            core.SINK("progress", _bar(bar, (i + 1) / ticks))
        if i in due:
            core.ok(due[i])
        time.sleep(0.1)
    if bar:
        core.SINK("out", _bar(bar, 1))


def job(
    kind: str = "install", pace: float = 6
) -> tuple[Callable[[core.Ctx], dict[str, bool]], int]:
    """The pretend job and its step count, for InstallingPage."""
    if kind == "remove":

        def remove(ctx: core.Ctx) -> dict[str, bool]:
            core.step("remove links created by this tool")
            for path in REMOVED:
                ctx.say(f"unlink {core.home()}/{path.removeprefix('~/')}")
                time.sleep(pace / len(REMOVED))
            core.step("restore backups")
            _play(pace, ["restored 2 file(s) from ~/.config-backups"], None)
            return {"remove": True}

        return remove, 2

    def install(ctx: core.Ctx) -> dict[str, bool]:
        results: dict[str, bool] = {}
        for heading, weight, lines, bar in STAGES:
            core.step(heading)
            _play(pace * weight, lines, bar)
            results[heading.split(":")[0]] = True
        if kind == "fail":
            core.err("demo: something went wrong, as it was always going to")
            results["demo"] = False
        return results

    return install, len(STAGES)


def add_demo_args(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--demo",
        nargs="?",
        const="install",
        choices=KINDS,
        help="play the installing page with pretend output, changing nothing (install, fail "
        "or remove; default install)",
    )
    p.add_argument(
        "--pace", type=float, default=6, metavar="SECONDS", help="seconds per --demo stage"
    )
