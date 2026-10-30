"""Git identity (user.name / user.email): detected from git, else asked for, never hard-coded.

The shared git config in this repo deliberately holds no identity, so each machine needs its own
in ~/.gitconfig.
"""

from __future__ import annotations

import getpass
import subprocess

from dotfiles import core, platform

KEYS = {
    "user.name": "Your full name for git commits",
    "user.email": "Your email address for git commits (a GitHub noreply address works)",
}


def detect(key: str) -> str:
    """The value git already has for `key` from any config file, or ""."""
    try:
        r = subprocess.run(
            ["git", "config", "--get", key], capture_output=True, text=True, cwd=core.home()
        )
    except FileNotFoundError:
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def suggest_name() -> str:
    """The account's real name if the OS knows it (a pre-filled default, not a decision)."""
    mac = platform.describe().os == "macos"
    cmd = ["id", "-F"] if mac else ["getent", "passwd", getpass.getuser()]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
    except OSError:
        return ""
    out = r.stdout.strip() if r.returncode == 0 else ""
    if mac:
        return out
    fields = out.split(":")
    return fields[4].split(",")[0] if len(fields) > 4 else ""


def ensure(ctx: core.Ctx) -> bool:
    """Make sure git has a name and email, asking for whichever can't be detected. Skipping is
    not a failure: it warns and says how to set it later."""
    core.step("git identity")
    good = True
    for key, question in KEYS.items():
        have = detect(key)
        if have:
            ctx.say(f"{key}: {have}")
            continue
        if ctx.dry_run:
            ctx.say(f"{key} is not set; would ask for it")
            continue
        value = ctx.prompt(question, suggest_name() if key == "user.name" else "")
        if not value:
            core.warn(f'{key} not set; run: git config --global {key} "..."')
            continue
        cp = ctx.run(["git", "config", "--global", key, value], check=False)
        good = good and (cp is None or cp.returncode == 0)
    return good
