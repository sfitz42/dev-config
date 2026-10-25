"""Link/copy config files according to links.yaml."""

from __future__ import annotations

import fnmatch
import os
import pathlib
from typing import Any

import yaml

from dotfiles import core, platform


def load_modules(root: pathlib.Path = core.REPO_ROOT) -> dict[str, list[dict[str, Any]]]:
    modules: dict[str, list[dict[str, Any]]] = yaml.safe_load((root / "links.yaml").read_text())[
        "modules"
    ]
    return modules


def module_supported(name: str, root: pathlib.Path = core.REPO_ROOT) -> bool:
    """False for modules that `module_os` in links.yaml limits to other OSes."""
    limits = yaml.safe_load((root / "links.yaml").read_text()).get("module_os") or {}
    return platform.supported({"os": limits.get(name)})


Action = tuple[str, pathlib.Path, pathlib.Path | None]


def expand_entry(entry: dict[str, Any], root: pathlib.Path = core.REPO_ROOT) -> list[Action]:
    """Turn a links.yaml entry into concrete actions: (kind, src, dst)."""
    if "mkdir" in entry:
        return [("mkdir", core.expand(entry["mkdir"]), None)]
    if "glob" in entry:
        out: list[Action] = []
        for src in sorted(root.glob(entry["glob"])):
            if src.is_dir() or fnmatch.fnmatch(src.name, entry.get("exclude", "")):
                continue
            out.append(("link", src, core.expand(entry["dst_dir"]) / src.name))
        return out
    kind = "copy" if entry.get("copy") == "if-missing" else "link"
    return [(kind, root / entry["src"], core.expand(entry["dst"]))]


def apply_entries(
    ctx: core.Ctx, entries: list[dict[str, Any]], root: pathlib.Path = core.REPO_ROOT
) -> bool:
    good = True
    for entry in entries:
        if "mkdir" in entry:
            core.ensure_dir(ctx, core.expand(entry["mkdir"]), int(entry.get("mode", "755"), 8))
            continue
        actions = expand_entry(entry, root)
        if not actions and "glob" in entry:
            core.info(f"  (nothing matches {entry['glob']})")
        for kind, src, dst in actions:
            if dst is None:
                continue
            if kind == "copy":
                good &= core.copy_if_missing(ctx, src, dst)
            else:
                good &= core.link_file(ctx, src, dst)
    return good


def link_modules(ctx: core.Ctx, names: list[str], root: pathlib.Path = core.REPO_ROOT) -> bool:
    modules = load_modules(root)
    good = True
    for name in names:
        if name not in modules:
            core.err(f"unknown module: {name}")
            good = False
            continue
        if not module_supported(name, root):
            core.info(f"- {name} (not for {platform.os_name()})")
            continue
        core.step(f"link: {name}")
        good &= apply_entries(ctx, modules[name], root)
    return good


def link_status(root: pathlib.Path = core.REPO_ROOT) -> list[tuple[str, str, str]]:
    """(module, dst, state) for doctor. state: ok | missing | not-a-link | wrong-target."""
    rows: list[tuple[str, str, str]] = []
    for name, entries in load_modules(root).items():
        if not module_supported(name, root):
            continue
        for entry in entries:
            for kind, src, dst in expand_entry(entry, root):
                if kind == "mkdir" or dst is None:
                    continue
                if kind == "copy":
                    rows.append((name, str(dst), "ok" if dst.exists() else "missing"))
                elif dst.is_symlink():
                    target = pathlib.Path(os.readlink(dst))
                    rows.append((name, str(dst), "ok" if target == src else "wrong-target"))
                elif dst.exists():
                    rows.append((name, str(dst), "not-a-link"))
                else:
                    rows.append((name, str(dst), "missing"))
    return rows


def unlink_all(ctx: core.Ctx) -> int:
    """Remove links this tool created (recorded in links.tsv) that still point at the repo."""
    f = core.state_dir() / "links.tsv"
    removed = 0
    if not f.exists():
        core.warn("no link record found; nothing to unlink")
        return 0
    keep = []
    for line in f.read_text().splitlines():
        dst_s, src_s = line.split("\t")
        dst, src = pathlib.Path(dst_s), pathlib.Path(src_s)
        if dst.is_symlink() and pathlib.Path(os.readlink(dst)) == src:
            ctx.say(f"unlink {dst}")
            if not ctx.dry_run:
                dst.unlink()
            removed += 1
        elif dst.is_symlink() or dst.exists():
            keep.append(line)  # changed since; leave it, and keep the record
    if not ctx.dry_run:
        f.write_text("".join(f"{k}\n" for k in keep))
    return removed


def restore_backups(ctx: core.Ctx) -> int:
    """Move backed-up files back, newest backup first, only where the destination is free."""
    restored = 0
    seen: set[str] = set()
    if not ctx.backup_root.exists():
        return 0
    for d in sorted(ctx.backup_root.iterdir(), reverse=True):
        manifest = d / "manifest.tsv"
        if not manifest.exists():
            continue
        for line in manifest.read_text().splitlines():
            dst_s, bak_s = line.split("\t")
            dst, bak = pathlib.Path(dst_s), pathlib.Path(bak_s)
            if dst_s in seen or not (bak.exists() or bak.is_symlink()):
                continue
            seen.add(dst_s)
            if dst.exists() or dst.is_symlink():
                core.warn(f"not restoring {dst}: something is there")
                continue
            ctx.say(f"restore {bak} -> {dst}")
            if not ctx.dry_run:
                dst.parent.mkdir(parents=True, exist_ok=True)
                bak.rename(dst)
            restored += 1
    return restored
