"""What was installed, and from which commit: the record `update` re-applies."""

from __future__ import annotations

import json
import pathlib
import subprocess
import time
from typing import Any

from dotfiles import core, platform


def path() -> pathlib.Path:
    return core.state_dir() / "install.json"


def git(*args: str, root: pathlib.Path = core.REPO_ROOT) -> str | None:
    """Output of a read-only git query, or None (not a checkout, no upstream, no git)."""
    try:
        r = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    except FileNotFoundError:
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def load() -> dict[str, Any] | None:
    try:
        data: dict[str, Any] = json.loads(path().read_text())
    except (OSError, ValueError):
        return None
    return data


def save(selection: dict[str, Any], root: pathlib.Path = core.REPO_ROOT) -> None:
    f = path()
    f.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "commit": git("rev-parse", "HEAD", root=root),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD", root=root),
        "selection": selection,
        "platform": platform.describe().label,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    f.write_text(json.dumps(record, indent=2) + "\n")
