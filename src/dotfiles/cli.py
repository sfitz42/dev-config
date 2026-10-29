"""Command line interface: scripts/dotfiles <command>."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from collections.abc import Callable

from dotfiles import agents, core, install, links, models, packages, platform, state, update

LINK_MODULES = install.LINK_MODULES
ALL_MODULES = install.ALL_MODULES


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


def _extras(args: argparse.Namespace) -> list[str]:
    chosen = _csv(getattr(args, "extras", "") or "")
    unknown = [e for e in chosen if e not in install.EXTRAS]
    if unknown:
        core.err(f"unknown extra(s): {', '.join(unknown)}; available: {', '.join(install.EXTRAS)}")
        raise SystemExit(2)
    return chosen


def _build(args: argparse.Namespace) -> install.Selection:
    return install.Selection(
        modules=_selection(args, ALL_MODULES), extras=_extras(args), opts=_opts(args)
    )


def _finish(ctx: core.Ctx, results: dict[str, bool]) -> int:
    ctx.summary()
    return 0 if all(results.values()) else 1


def cmd_install(args: argparse.Namespace) -> int:
    ctx = core.Ctx(dry_run=args.dry_run, yes=args.yes)
    return _finish(ctx, install.run(ctx, _build(args)))


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
    touched = _csv(args.touched or "")
    if args.no_pull:
        pass  # re-exec'd after a pull that changed the installer
    elif not update.is_checkout():
        core.warn("not a git checkout; skipping pull")
    else:
        core.step("update repo")
        if not update.fetch():
            core.warn("git fetch failed; using what is already fetched")
        inc = update.incoming()
        if args.check:
            update.report(inc)
            return 1 if inc.behind else 0
        update.report(inc)
        touched = update.affected([p for _, p in inc.files])
        if inc.behind:
            if not ctx.confirm(f"fast-forward {inc.behind} commit(s)?"):
                core.warn("update cancelled")
                return 1
            if not update.fast_forward(ctx, inc):
                return 1
            if "installer" in touched and not ctx.dry_run:
                core.info("the installer changed: restarting it to re-apply")
                script = str(core.REPO_ROOT / "scripts" / "dotfiles")
                again = [*args.argv, "--no-pull", "--touched", ",".join(touched)]
                os.execv(script, [script, *again])
    saved = state.load()
    if args.only or args.skip or args.extras or not saved:
        sel, record = _build(args), not (args.only or args.skip or args.extras)
    else:
        sel, record = install.Selection.from_dict(saved["selection"]), True
        core.info(f"re-applying the saved selection from {saved.get('updated_at', '?')}")
        sel.extras = update.extras_to_rerun(sel.extras, touched)
    return _finish(ctx, install.run(ctx, sel, record=record))


def cmd_models(args: argparse.Namespace) -> int:
    ctx = core.Ctx(dry_run=args.dry_run, yes=args.yes)
    return 0 if models.pull(ctx, args.runtime, _csv(args.models or "")) else 1


def cmd_conjure(args: argparse.Namespace) -> int:
    from dotfiles.wizard import app  # textual is only imported for the wizard

    return app.run_wizard(args.reapply, _csv(args.touched or ""), args.calm)


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
    for module, dst, status in links.link_status():
        (core.ok if status == "ok" else core.warn)(f"{module:<9} {dst}: {status}")
        problems += status != "ok"
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
    p = argparse.ArgumentParser(
        prog="dotfiles",
        description="Install and manage dev-config. With no command on a terminal, opens the "
        "conjure wizard.",
    )
    sub = p.add_subparsers(dest="command")

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

    extras_help = f"comma-separated extras: {', '.join(install.EXTRAS)}"
    sp = add("install", cmd_install, "install packages and link config", True, True)
    sp.add_argument("--extras", help=extras_help)
    sp = add(
        "update",
        cmd_update,
        "show incoming changes, fast-forward, then re-apply what was installed",
        True,
        True,
    )
    sp.add_argument("--extras", help=extras_help)
    sp.add_argument(
        "--check", action="store_true", help="report commits behind only (exit 1 if behind)"
    )
    sp.add_argument("--no-pull", action="store_true", help=argparse.SUPPRESS)
    sp.add_argument("--touched", help=argparse.SUPPRESS)
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
    sp = add("models", cmd_models, "pull the local models in models.yaml (oMLX and/or Ollama)")
    sp.add_argument("models", nargs="?", help="comma-separated model names (default: all)")
    sp.add_argument(
        "--runtime",
        choices=models.RUNTIMES,
        help="only this runtime (default: every one found here; under WSL, Ollama on Windows)",
    )
    sp = sub.add_parser("conjure", help="open the interactive installer (the default on a TTY)")
    sp.add_argument("--reapply", action="store_true", help=argparse.SUPPRESS)
    sp.add_argument("--touched", help=argparse.SUPPRESS)
    sp.add_argument("--calm", action="store_true", help="no animation (also CONJURE_CALM=1)")
    sp.set_defaults(fn=cmd_conjure)
    return p


def interactive() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        if not interactive():
            parser.print_usage(sys.stderr)
            core.err("no command given (the wizard needs a terminal)")
            return 2
        args = parser.parse_args(["conjure"])
    args.argv = argv
    code: int = args.fn(args)
    return code
