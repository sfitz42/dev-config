"""The install engine shared by the CLI and the wizard: a Selection in, sections run in order."""

from __future__ import annotations

import dataclasses
import pathlib
import sys
from typing import Any

from dotfiles import agents, core, identity, links, models, packages, state

LINK_MODULES = list(links.load_modules())
ALL_MODULES = ["packages", "repos", *LINK_MODULES, "agents"]
DEVBOX_TARGETS = ("core", "fullstack", "all")
# models: every runtime found here; models:<runtime> just that one
EXTRAS = [
    "models",
    *(f"models:{r}" for r in models.RUNTIMES),
    *(f"devbox:{t}" for t in DEVBOX_TARGETS),
]


@dataclasses.dataclass
class Selection:
    modules: list[str] = dataclasses.field(default_factory=lambda: list(ALL_MODULES))
    agents: list[str] = dataclasses.field(default_factory=list)  # empty: every agent
    extras: list[str] = dataclasses.field(default_factory=list)
    opts: packages.Opts = dataclasses.field(default_factory=packages.Opts)
    # individual models from models.yaml, as runtime:name (e.g. ollama:gpt-oss:20b)
    models: list[str] = dataclasses.field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Selection:
        known = {f.name for f in dataclasses.fields(packages.Opts)}
        opts = packages.Opts(**{k: v for k, v in data.get("opts", {}).items() if k in known})
        return cls(
            modules=[m for m in data.get("modules", ALL_MODULES) if m in ALL_MODULES],
            agents=list(data.get("agents", [])),
            extras=[e for e in data.get("extras", []) if e in EXTRAS],
            opts=opts,
            models=[m for m in data.get("models", []) if m.split(":", 1)[0] in models.RUNTIMES],
        )

    def models_by_runtime(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for m in self.models:
            runtime, name = m.split(":", 1)
            out.setdefault(runtime, []).append(name)
        return out


def run_extra(ctx: core.Ctx, extra: str, root: pathlib.Path = core.REPO_ROOT) -> bool:
    if extra == "models" or extra.startswith("models:"):
        runtime = extra.split(":", 1)[1] if ":" in extra else None
        return models.pull(ctx, runtime, root=root)
    if extra.startswith("devbox:"):
        core.step(f"devbox build {extra.split(':', 1)[1]}")
        # a child process: the build drives the container CLI directly, so stream its output
        cmd = [sys.executable, "-m", "dotfiles.devbox", "build", extra.split(":", 1)[1]]
        cp = ctx.run(cmd, cwd=root, check=False)
        return cp is None or cp.returncode == 0
    core.err(f"unknown extra: {extra}")
    return False


def run(
    ctx: core.Ctx, sel: Selection, root: pathlib.Path = core.REPO_ROOT, record: bool = True
) -> dict[str, bool]:
    """Run each selected section; returns section -> succeeded. Records the selection after a
    real (not dry) run so `update` can re-apply it."""
    results: dict[str, bool] = {}
    if "packages" in sel.modules:
        outcome = packages.install_all(ctx, sel.opts, root)
        results["packages"] = "failed" not in outcome.values()
    if "repos" in sel.modules:
        packages.install_repos(ctx, sel.opts, root)
        results["repos"] = True
    link_mods = [m for m in sel.modules if m in LINK_MODULES]
    if link_mods:
        results["links"] = links.link_modules(ctx, link_mods, root)
        if "git" in link_mods:
            results["git identity"] = identity.ensure(ctx)
    if "agents" in sel.modules:
        results["agents"] = agents.sync(ctx, sel.agents, root, opts=sel.opts)
    for runtime, names in sel.models_by_runtime().items():
        results[f"models: {runtime}"] = models.pull(ctx, runtime, names, root)
    for extra in sel.extras:
        results[extra] = run_extra(ctx, extra, root)
    if record and not ctx.dry_run:
        state.save(sel.to_dict(), root)
    return results
