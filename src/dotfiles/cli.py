"""Command line interface: scripts/dotfiles <command>."""

from __future__ import annotations

import argparse
import subprocess
from collections.abc import Callable

from dotfiles import agents, core, links, packages, platform

LINK_MODULES = list(links.load_modules())
ALL_MODULES = ["packages", "repos", *LINK_MODULES, "agents"]


def _csv(value: str) -> list[str]:
    return [v for v in value.split(",") if v]


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("-n", "--dry-run", action="store_true", help="print actions, change nothing")
    p.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="never prompt (approves unpinned scripts and sudo)",
    )


def _selection(args: argparse.Namespace, universe: list[str]) -> list[str]:
    chosen = _csv(args.only) if getattr(args, "only", None) else list(universe)
    unknown = [m for m in chosen if m not in universe]
    if unknown:
        core.err(f"unknown module(s): {', '.join(unknown)}; available: {', '.join(universe)}")
        raise SystemExit(2)
    return [m for m in chosen if m not in _csv(getattr(args, "skip", "") or "")]


def _opts(args: argparse.Namespace) -> packages.Opts:
    return packages.Opts(
        prefer=_csv(getattr(args, "prefer", "") or ""),
        no_brew=getattr(args, "no_brew", False),
        names=_csv(getattr(args, "packages", "") or ""),
        with_optional=getattr(args, "with_optional", False),
    )


def cmd_install(args: argparse.Namespace) -> int:
    ctx = core.Ctx(dry_run=args.dry_run, yes=args.yes)
    mods = _selection(args, ALL_MODULES)
    good = True
    if "packages" in mods:
        results = packages.install_all(ctx, _opts(args))
        good &= "failed" not in results.values()
    if "repos" in mods:
        packages.install_repos(ctx, _opts(args))
    link_mods = [m for m in mods if m in LINK_MODULES]
    if link_mods:
        good &= links.link_modules(ctx, link_mods)
    if "agents" in mods:
        good &= agents.sync(ctx, opts=_opts(args))
    ctx.summary()
    return 0 if good else 1


def cmd_link(args: argparse.Namespace) -> int:
    ctx = core.Ctx(dry_run=args.dry_run, yes=args.yes)
    good = links.link_modules(ctx, _selection(args, LINK_MODULES))
    ctx.summary()
    return 0 if good else 1


def cmd_packages(args: argparse.Namespace) -> int:
    if args.check:
        rows = packages.check_all()
        for name, present, optional in rows:
            mark = "present" if present else ("optional" if optional else "MISSING")
            core.info(f"{name:<16} {mark}")
        return 0 if all(p or o for _, p, o in rows) else 1
    ctx = core.Ctx(dry_run=args.dry_run, yes=args.yes)
    results = packages.install_all(ctx, _opts(args))
    return 1 if "failed" in results.values() else 0


def cmd_agents(args: argparse.Namespace) -> int:
    if args.export:
        agents.export()
        return 0
    ctx = core.Ctx(dry_run=args.dry_run, yes=args.yes)
    good = agents.sync(ctx, _csv(args.only or ""), opts=_opts(args))
    return 0 if good else 1


def cmd_update(args: argparse.Namespace) -> int:
    ctx = core.Ctx(dry_run=args.dry_run, yes=args.yes)
    core.step("update repo")
    if (core.REPO_ROOT / ".git").exists():
        ctx.run(["git", "-C", str(core.REPO_ROOT), "pull", "--ff-only"], check=False)
    else:
        core.warn("not a git checkout; skipping pull")
    return cmd_install(args)


def cmd_uninstall(args: argparse.Namespace) -> int:
    ctx = core.Ctx(dry_run=args.dry_run, yes=args.yes)
    core.step("remove links created by this tool")
    n = links.unlink_all(ctx)
    core.step("restore backed-up files")
    r = links.restore_backups(ctx)
    core.info(f"\nunlinked: {n}, restored: {r}" + (" (dry run)" if ctx.dry_run else ""))
    core.info("Installed packages are left alone; remove them with brew, dnf/apt or by hand.")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    problems = 0
    core.step("links")
    for module, dst, state in links.link_status():
        (core.ok if state == "ok" else core.warn)(f"{module:<9} {dst}: {state}")
        problems += state != "ok"
    core.step("packages")
    for name, present, optional in packages.check_all():
        if present:
            core.ok(f"{name}")
        elif optional:
            core.info(f"- {name} (optional, not installed)")
        else:
            core.warn(f"{name}: missing")
            problems += 1
    core.step("local overrides")
    tracked = subprocess.run(
        ["git", "-C", str(core.REPO_ROOT), "ls-files", "local"], capture_output=True, text=True
    ).stdout.split()
    leaked = [f for f in tracked if not (f.endswith(".example") or f.endswith("README.md"))]
    if leaked:
        core.warn(f"tracked files under local/ that should be ignored: {leaked}")
        problems += 1
    else:
        core.ok("no private files tracked under local/")
    if platform.is_wsl():
        core.step("wsl")
        if str(core.REPO_ROOT).startswith("/mnt/"):
            core.warn(
                f"repo is on the Windows drive ({core.REPO_ROOT}): slow, and the links point "
                "across filesystems. Clone it into the distro instead (e.g. ~/.dev-config)."
            )
            problems += 1
        else:
            core.ok(f"repo is on the Linux filesystem ({core.REPO_ROOT})")
    core.info(f"\n{problems} problem(s)")
    return 1 if problems else 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="dotfiles", description="Install and manage dev-config")
    sub = p.add_subparsers(dest="command", required=True)

    def add(
        name: str,
        fn: Callable[[argparse.Namespace], int],
        help_: str,
        with_select: bool = False,
        with_pkg: bool = False,
    ) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_)
        _common(sp)
        if with_select:
            sp.add_argument("--only", help=f"comma-separated modules: {', '.join(ALL_MODULES)}")
            sp.add_argument("--skip", help="comma-separated modules to skip")
        if with_pkg:
            sp.add_argument("--prefer", help="source types to try first, e.g. dmg,web or brew")
            sp.add_argument("--no-brew", action="store_true", help="never use brew")
            sp.add_argument(
                "--with-optional", action="store_true", help="also install optional packages"
            )
        sp.set_defaults(fn=fn)
        return sp

    add("install", cmd_install, "install packages and link config", True, True)
    add("update", cmd_update, "git pull, then install", True, True)
    sp = add("link", cmd_link, "link config only", True)
    sp = add("packages", cmd_packages, "install or check packages", False, True)
    sp.add_argument("packages", nargs="?", help="comma-separated package names (default: all)")
    sp.add_argument("--check", action="store_true", help="report installed/missing only")
    sp = add(
        "agents", cmd_agents, "sync coding-assistant settings, plugins and extensions", False, True
    )
    sp.add_argument("--only", help="comma-separated agents, e.g. claude,pi")
    sp.add_argument(
        "--export", action="store_true", help="print what each CLI reports as installed"
    )
    add("uninstall", cmd_uninstall, "remove links, restore backups")
    add("doctor", cmd_doctor, "verify links, packages and local overrides")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    code: int = args.fn(args)
    return code
