"""Updates: fetch, show what is incoming, fast-forward, and work out which modules it touches."""

from __future__ import annotations

import dataclasses
import fnmatch
import pathlib

from dotfiles import core, install, links, state


@dataclasses.dataclass
class Incoming:
    upstream: str | None  # e.g. origin/main; None if the branch tracks nothing
    commits: list[str]  # `git log --oneline` lines, newest first
    files: list[tuple[str, str]]  # (status, path) from `git diff --name-status`
    dirty: list[str]  # tracked files with local changes
    ahead: int  # local commits the upstream does not have

    @property
    def behind(self) -> int:
        return len(self.commits)


def is_checkout(root: pathlib.Path = core.REPO_ROOT) -> bool:
    return (root / ".git").exists()


def fetch(root: pathlib.Path = core.REPO_ROOT) -> bool:
    """Fetch the upstream. Read-only for the working tree, so it runs under --dry-run too."""
    return state.git("fetch", "--quiet", root=root) is not None


def _lines(out: str | None) -> list[str]:
    return [line for line in (out or "").splitlines() if line.strip()]


def incoming(root: pathlib.Path = core.REPO_ROOT) -> Incoming:
    dirty = _lines(state.git("status", "--porcelain", "--untracked-files=no", root=root))
    upstream = state.git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}", root=root)
    if not upstream:
        return Incoming(None, [], [], dirty, 0)
    commits = _lines(state.git("log", "--oneline", "--no-decorate", "HEAD..@{u}", root=root))
    files = []
    # three dots: changes on the upstream since the merge base, not local edits reversed
    for line in _lines(state.git("diff", "--name-status", "HEAD...@{u}", root=root)):
        status, *paths = line.split("\t")
        files.append((status[:1], paths[-1]))
    ahead = len(_lines(state.git("rev-list", "@{u}..HEAD", root=root)))
    return Incoming(upstream, commits, files, dirty, ahead)


INSTALLER_PATHS = ("src/", "scripts/", "pyproject.toml", "uv.lock")


def affected(paths: list[str], root: pathlib.Path = core.REPO_ROOT) -> list[str]:
    """Modules (install.ALL_MODULES names), `devbox` and `installer` that changed paths touch."""
    hit: set[str] = set()
    modules = links.load_modules(root)
    for p in paths:
        if p == "links.yaml":
            hit.update(modules)
        elif p == "packages.yaml":
            hit.update(("packages", "repos"))
        elif p == "models.yaml":
            hit.add("models")
        elif p.startswith(("agents/", "pi-extensions/")):
            hit.add("agents")
        elif p.startswith("devcontainers/"):
            hit.add("devbox")
        elif p.startswith(INSTALLER_PATHS):
            hit.add("installer")
        for name, entries in modules.items():
            for e in entries:
                if e.get("src") == p or ("glob" in e and fnmatch.fnmatch(p, e["glob"])):
                    hit.add(name)
    order = [*install.ALL_MODULES, "models", "devbox", "installer"]
    return [m for m in order if m in hit]


def extras_to_rerun(extras: list[str], touched: list[str]) -> list[str]:
    """Extras are slow (image builds, model downloads), so an update only re-runs the ones whose
    inputs changed: devbox images on devcontainers/, models on models.yaml or the installer."""
    return [
        e
        for e in extras
        if (e.startswith("devbox:") and "devbox" in touched)
        or (e.startswith("models") and ("models" in touched or "installer" in touched))
    ]


def blocker(inc: Incoming) -> str | None:
    """Why a fast-forward cannot happen, or None."""
    if inc.upstream is None:
        return "this branch has no upstream to update from"
    if inc.ahead:
        return (
            f"local branch has {inc.ahead} commit(s) not on {inc.upstream}; merge or rebase by hand"
        )
    if inc.dirty and inc.behind:
        return "uncommitted changes to tracked files: commit or stash them first"
    return None


def fast_forward(ctx: core.Ctx, inc: Incoming, root: pathlib.Path = core.REPO_ROOT) -> bool:
    why = blocker(inc)
    if why:
        core.err(why)
        return False
    if not inc.behind:
        return True
    cp = ctx.run(["git", "-C", str(root), "merge", "--ff-only", "--quiet", "@{u}"], check=False)
    if cp is not None and cp.returncode != 0:
        core.err("git merge --ff-only failed")
        return False
    if not ctx.dry_run:
        core.ok(f"updated to {state.git('rev-parse', '--short', 'HEAD', root=root)}")
    return True


def report(inc: Incoming) -> None:
    """Plain-text summary for the CLI."""
    if inc.upstream is None:
        core.warn("no upstream branch; nothing to pull")
        return
    if not inc.behind:
        core.ok(f"up to date with {inc.upstream}")
        return
    core.info(f"{inc.behind} new commit(s) on {inc.upstream}:")
    for c in inc.commits:
        core.info(f"  {c}")
    core.info("changed files:")
    for status, p in inc.files:
        core.info(f"  {status} {p}")
    core.info(f"affects: {', '.join(affected([p for _, p in inc.files])) or 'nothing installed'}")
