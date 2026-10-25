"""Sync coding-assistant setup (settings, models, plugins, extensions) from agents/*/agent.yaml."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import string
import subprocess
from collections.abc import Callable
from typing import Any

import yaml

from dotfiles import core, links, packages

# ---- manifests ------------------------------------------------------------


def _merge(base: Any, extra: Any) -> Any:
    """Merge local overrides over the manifest: dicts merge, lists append, scalars replace."""
    if isinstance(base, dict) and isinstance(extra, dict):
        return {**base, **{k: _merge(base[k], v) if k in base else v for k, v in extra.items()}}
    if isinstance(base, list) and isinstance(extra, list):
        return base + [x for x in extra if x not in base]
    return extra


def load_agents(root: pathlib.Path = core.REPO_ROOT) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for f in sorted((root / "agents").glob("*/agent.yaml")):
        data = yaml.safe_load(f.read_text()) or {}
        local = root / "local" / f"agents.{data['agent']}.yaml"
        if local.exists():
            data = _merge(data, yaml.safe_load(local.read_text()) or {})
        out[data["agent"]] = data
    return out


def read_env(root: pathlib.Path = core.REPO_ROOT) -> dict[str, str]:
    """Environment plus local/agents.env (NAME=value lines); the environment wins."""
    env: dict[str, str] = {}
    f = root / "local" / "agents.env"
    if f.exists():
        for line in f.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env.update({k: v for k, v in os.environ.items() if k in env or k.isupper()})
    return env


def _capture(cmd: list[str]) -> str | None:
    """Output of a read-only query, or None if the tool is missing or the command fails
    (for example `pi` without node on PATH). Callers must not treat None as 'nothing installed'."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    return (r.stdout or "") + (r.stderr or "")


# ---- settings and models --------------------------------------------------


def deep_merge(current: dict[str, Any], declared: dict[str, Any]) -> dict[str, Any]:
    out = dict(current)
    for k, v in declared.items():
        out[k] = (
            deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
        )
    return out


def _write_json(ctx: core.Ctx, target: pathlib.Path, data: dict[str, Any]) -> None:
    if ctx.dry_run:
        ctx.say(f"write {target}")
        return
    core.snapshot(ctx, target)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(target)


def sync_settings(ctx: core.Ctx, spec: dict[str, Any], root: pathlib.Path) -> bool:
    """Merge the declared keys into the target; other keys in the target are left alone."""
    declared = json.loads((root / spec["file"]).read_text())
    target = core.expand(spec["target"])
    current = json.loads(target.read_text()) if target.exists() else {}
    merged = deep_merge(current, declared)
    if merged == current:
        core.info(f"= {target} (settings already match)")
        return False
    changed = sorted(k for k in declared if current.get(k) != merged.get(k))
    _write_json(ctx, target, merged)
    core.ok(f"{target}: set {', '.join(changed)}")
    return True


def sync_models(
    ctx: core.Ctx, spec: dict[str, Any], root: pathlib.Path, env: dict[str, str]
) -> bool:
    """Render a template with secrets from the environment; never clobbers if one is missing."""
    missing = [k for k in spec.get("env", []) if not env.get(k)]
    target = core.expand(spec["target"])
    if missing:
        core.warn(
            f"{target}: not rendered, missing {', '.join(missing)} "
            "(set in the environment or local/agents.env)"
        )
        return False
    text = string.Template((root / spec["template"]).read_text()).substitute(env)
    rendered = json.loads(text)
    if target.exists() and json.loads(target.read_text()) == rendered:
        core.info(f"= {target} (already matches the template)")
        return False
    _write_json(ctx, target, rendered)
    core.ok(f"{target}: rendered from {spec['template']}")
    return True


# ---- per-agent steps ------------------------------------------------------


def _marketplace_plugins(name: str) -> list[str] | None:
    """Plugin names a marketplace publishes, from its local clone (None until it has been added)."""
    f = core.expand(f"~/.claude/plugins/marketplaces/{name}/.claude-plugin/marketplace.json")
    if not f.exists():
        return None
    return [p["name"] for p in json.loads(f.read_text()).get("plugins", [])]


def sync_claude(ctx: core.Ctx, m: dict[str, Any]) -> None:
    listed = _capture(["claude", "plugin", "marketplace", "list"])
    installed = _capture(["claude", "plugin", "list", "--json"])
    if listed is None or installed is None:
        core.warn(
            "claude: could not query marketplaces/plugins "
            "(is `claude` installed and working?); skipping"
        )
        return
    for mk in m.get("marketplaces", []):
        if mk["name"] in listed or mk["source"] in listed:
            core.info(f"= marketplace {mk['name']}")
        else:
            core.info(f"+ marketplace {mk['name']} ({mk['source']})")
            ctx.run(["claude", "plugin", "marketplace", "add", mk["source"]], check=False)

    wanted: list[str] = list(m.get("plugins", []))
    for mk in m.get("marketplaces", []):
        if not mk.get("install_all"):
            continue
        names = _marketplace_plugins(mk["name"])
        if names is None:
            core.warn(
                f"marketplace {mk['name']}: its plugin list is only known once it has been added "
                f"({'re-run without --dry-run' if ctx.dry_run else 'add failed?'})"
            )
            continue
        wanted += [f"{n}@{mk['name']}" for n in names]

    for spec in dict.fromkeys(wanted):
        if spec in installed:
            core.info(f"= plugin {spec}")
        else:
            core.info(f"+ plugin {spec}")
            ctx.run(["claude", "plugin", "install", spec], check=False)


PI_WORKSPACE = "pi-extensions"  # pnpm workspace holding the audited local extensions


def _pi_source(src: str, root: pathlib.Path) -> str:
    """`./path` sources are repo-relative; `pi list` shows a local package by its absolute path."""
    return str((root / src).resolve()) if src.startswith("./") else src


def _install_pi_workspace(ctx: core.Ctx, root: pathlib.Path) -> bool:
    """Install the local extensions' dependencies (Pi does not install them for local packages)."""
    if shutil.which("pnpm") is None:
        core.warn("pi: pnpm not found (mise provides it with node); skipping local extensions")
        return False
    core.info(f"~ {PI_WORKSPACE}: pnpm install")
    ctx.run(["pnpm", "install", "--frozen-lockfile"], cwd=root / PI_WORKSPACE, check=False)
    return True


def sync_pi(ctx: core.Ctx, m: dict[str, Any], root: pathlib.Path = core.REPO_ROOT) -> None:
    listed = _capture(["pi", "list"])
    if listed is None:
        core.warn(
            "pi: `pi list` failed (is node on PATH? try from an interactive shell); "
            "skipping extensions"
        )
        return
    have = {line.strip() for line in listed.splitlines()}
    wanted = m.get("extensions", [])
    locals_ok = not any(s.startswith("./") for s in wanted) or _install_pi_workspace(ctx, root)
    for src in wanted:
        if src.startswith("./") and not locals_ok:
            continue
        source = _pi_source(src, root)
        if source in have:
            core.info(f"= extension {src}")
        else:
            core.info(f"+ extension {src}")
            ctx.run(["pi", "install", source], check=False)


STEPS: dict[str, Callable[[core.Ctx, dict[str, Any]], None]] = {
    "claude": sync_claude
}  # pi is called with the repo root (sync_pi)


def sync(
    ctx: core.Ctx,
    only: list[str] | None = None,
    root: pathlib.Path = core.REPO_ROOT,
    opts: packages.Opts | None = None,
) -> bool:
    agents = load_agents(root)
    env = read_env(root)
    unknown = [a for a in (only or []) if a not in agents]
    if unknown:
        core.err(f"unknown agent(s): {', '.join(unknown)}; available: {', '.join(agents)}")
        return False
    pkgs = packages.load_manifest(root)
    for name, m in agents.items():
        if only and name not in only:
            continue
        core.step(f"agent: {name}")
        if "install" in m:
            pkg = m["install"]["package"]
            packages.install_package(ctx, pkg, pkgs["packages"][pkg], pkgs, opts or packages.Opts())
        if "settings" in m:
            sync_settings(ctx, m["settings"], root)
        if "models" in m:
            sync_models(ctx, m["models"], root, env)
        if m.get("links"):
            links.apply_entries(ctx, m["links"], root)
        if name == "pi":
            sync_pi(ctx, m, root)
        elif name in STEPS:
            STEPS[name](ctx, m)
    return True


def export() -> None:
    """Print what each CLI reports as installed (to seed or check a manifest)."""
    for title, cmd in [
        ("claude marketplaces", ["claude", "plugin", "marketplace", "list"]),
        ("claude plugins", ["claude", "plugin", "list"]),
        ("pi extensions", ["pi", "list"]),
    ]:
        out = _capture(cmd)
        print(
            f"## {title}\n"
            f"{out.strip() if out and out.strip() else '(none / not installed / command failed)'}\n"
        )
