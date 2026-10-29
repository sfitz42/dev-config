"""What the wizard offers on this machine, and how the ticked boxes become an install.Selection.

Kept free of Textual so it can be tested on its own.
"""

from __future__ import annotations

import dataclasses
import pathlib
from collections.abc import Callable
from typing import Any

from dotfiles import agents, core, install, links, models, packages, platform

GROUPS = {
    "packages": "📦 Packages",
    "config": "📜 Config",
    "agents": "🤖 Agents",
    "models": "🧠 Models",
    "extras": "✨ Extras",
}
RUNTIME_LABEL = {"omlx": "oMLX", "ollama": "Ollama"}

# which listed models a runtime already has (None: can't tell); swapped out in tests
Pulled = Callable[[str, dict[str, Any]], set[str] | None]


@dataclasses.dataclass
class Choice:
    # pkg:<name> | link:<module> | repos | agent:<name> | model:<runtime>:<name> | extra:<name>
    value: str
    label: str
    group: str  # a GROUPS key
    note: str = ""  # shown beside the label: present, missing, optional, why unavailable
    available: bool = True
    default: bool = True


def _package_choices(
    plat: platform.Platform, root: pathlib.Path, picked: set[str] | None
) -> list[Choice]:
    data = packages.load_manifest(root)
    out = []
    for name, pkg in data["packages"].items():
        if not platform.supported(pkg, plat.os, plat.wsl):
            note = f"not for {plat.os}"
            if platform.supported(pkg, plat.os, wsl=False):
                note = pkg.get("wsl_note", "not under WSL")
            out.append(Choice(f"pkg:{name}", name, "packages", note, False, False))
            continue
        optional = bool(pkg.get("optional"))
        present = packages.is_installed(pkg["check"])
        note = "installed" if present else ("optional" if optional else "missing")
        default = name in picked if picked is not None else not optional
        out.append(Choice(f"pkg:{name}", name, "packages", note, True, default))
    return out


def _model_choices(
    plat: platform.Platform,
    sel: install.Selection | None,
    root: pathlib.Path,
    pulled: Pulled,
) -> list[Choice]:
    """One choice per model in models.yaml, showing whether it is already pulled. Ticked: what
    was chosen last time, else what is already pulled (re-pulling those only checks for updates;
    nothing new and large is downloaded unless you tick it)."""
    manifest = models.load_manifest(root)
    out = []
    for rt in models.RUNTIMES:
        ok_, why = models.available(rt, plat)
        have = pulled(rt, manifest[rt]) if ok_ else None
        legacy = sel is not None and ("models" in sel.extras or f"models:{rt}" in sel.extras)
        for name, size in models.entries(manifest[rt]):
            if not ok_:
                note = why
            elif have is None:
                note = f"status unknown (is Ollama running?) · {size}".rstrip(" ·")
            elif name in have:
                note = "pulled"
            else:
                note = f"not pulled · {size}".rstrip(" ·")
            if sel is not None:
                default = f"{rt}:{name}" in sel.models or legacy
            else:
                default = have is not None and name in have
            label = f"{name}  ({RUNTIME_LABEL[rt]})"
            out.append(Choice(f"model:{rt}:{name}", label, "models", note, ok_, ok_ and default))
    return out


def choices(
    plat: platform.Platform,
    saved: dict[str, Any] | None = None,
    root: pathlib.Path = core.REPO_ROOT,
    pulled: Pulled | None = None,  # default: models.installed (asks the Ollama server)
) -> list[Choice]:
    """Every option, ticked from the saved selection if there is one, else the sensible default:
    everything required for this platform, models already pulled, nothing optional, no extras."""
    sel = install.Selection.from_dict(saved) if saved else None
    picked_pkgs = set(sel.opts.names) if sel and sel.opts.names else None
    if sel and "packages" not in sel.modules:
        picked_pkgs = set()
    out = _package_choices(plat, root, picked_pkgs)

    for name in links.load_modules(root):
        ok_ = links.module_supported(name, root, plat.os)
        default = (name in sel.modules) if sel else ok_
        note = "" if ok_ else "not for this OS"
        out.append(Choice(f"link:{name}", name, "config", note, ok_, default and ok_))
    repos = packages.load_manifest(root)["external_repos"]
    if repos:
        default = ("repos" in sel.modules) if sel else True
        label = f"external repos ({', '.join(repos)})"
        out.append(Choice("repos", label, "config", "git clones", True, default))

    for name in agents.load_agents(root):
        if sel:
            default = "agents" in sel.modules and (not sel.agents or name in sel.agents)
        else:
            default = True
        out.append(Choice(f"agent:{name}", name, "agents", "", True, default))

    out += _model_choices(plat, sel, root, pulled or models.installed)

    extras = set(sel.extras) if sel else set()
    has_rt = plat.container_runtime is not None
    for target in ("core", "fullstack"):
        on = f"devbox:{target}" in extras or "devbox:all" in extras
        out.append(
            Choice(
                f"extra:devbox:{target}",
                f"build devbox image dev-{target}",
                "extras",
                plat.container_runtime or "no container runtime",
                has_rt,
                on and has_rt,
            )
        )
    return out


def selection(
    checked: set[str], all_choices: list[Choice], opts: packages.Opts
) -> install.Selection:
    """Turn the ticked choice values into the Selection the engine runs."""
    by_group: dict[str, list[str]] = {g: [] for g in GROUPS}
    for c in all_choices:
        if c.value in checked and c.available:
            by_group[c.group].append(c.value)

    modules: list[str] = []
    pkg_names = [v.split(":", 1)[1] for v in by_group["packages"]]
    if pkg_names:
        modules.append("packages")
    if "repos" in by_group["config"]:
        modules.append("repos")
    modules += [v.split(":", 1)[1] for v in by_group["config"] if v.startswith("link:")]
    agent_names = [v.split(":", 1)[1] for v in by_group["agents"]]
    if agent_names:
        modules.append("agents")

    extras = [v.split(":", 1)[1] for v in by_group["extras"]]
    if "devbox:core" in extras and "devbox:fullstack" in extras:
        extras = [e for e in extras if not e.startswith("devbox:")] + ["devbox:all"]

    return install.Selection(
        modules=[m for m in install.ALL_MODULES if m in modules],
        agents=agent_names,
        extras=extras,
        opts=dataclasses.replace(opts, names=pkg_names),
        models=[v.split(":", 1)[1] for v in by_group["models"]],  # runtime:name
    )


def needs_sudo(sel: install.Selection, root: pathlib.Path = core.REPO_ROOT) -> bool:
    """True if a package this selection would install comes from dnf/apt or a macOS .pkg, so the
    wizard can ask for the password up front (commands run without a terminal)."""
    if "packages" not in sel.modules and "agents" not in sel.modules:
        return False
    data = packages.load_manifest(root)
    for name, pkg in data["packages"].items():
        if sel.opts.names and name not in sel.opts.names:
            continue
        if not platform.supported(pkg) or packages.is_installed(pkg["check"]):
            continue
        sources = packages.ordered_sources(pkg, data["defaults"], sel.opts, data.get("prefer"))
        # `admin: true`: a vendor script that calls sudo itself (e.g. Ollama's on Linux)
        if sources and (pkg.get("admin") or sources[0]["type"] in (*packages.NATIVE, "pkg")):
            return True
    return False


def step_count(sel: install.Selection, root: pathlib.Path = core.REPO_ROOT) -> int:
    """How many `core.step` headings a run prints, to size the progress bar."""
    n = int("packages" in sel.modules) + int("repos" in sel.modules)
    n += sum(
        1 for m in sel.modules if m in install.LINK_MODULES and links.module_supported(m, root)
    )
    if "agents" in sel.modules:
        n += len(sel.agents) or len(agents.load_agents(root))
    return n + len(sel.models_by_runtime()) + len(sel.extras)
