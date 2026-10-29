import shutil
import subprocess

import pytest

from dotfiles import core, update


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


@pytest.fixture
def clones(tmp_path, repo, monkeypatch):
    """An origin, the checkout under test (`work`), and a second clone that pushes to origin."""
    for k, v in {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.com",
        "GIT_CONFIG_GLOBAL": str(tmp_path / "gitconfig"),
    }.items():
        monkeypatch.setenv(k, v)
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "first")
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "push", "-q", "-u", "origin", "main")
    work = tmp_path / "work"
    subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True)
    return repo, work


def push_change(upstream):
    (upstream / "config" / "zshrc").write_text("changed\n")
    (upstream / "src").mkdir()
    (upstream / "src" / "x.py").write_text("x = 1\n")
    git(upstream, "add", "-A")
    git(upstream, "commit", "-q", "-m", "change zshrc and the installer")
    git(upstream, "push", "-q")


def test_incoming_and_affected(clones):
    upstream, work = clones
    assert update.incoming(work).behind == 0
    push_change(upstream)
    assert update.fetch(work)
    inc = update.incoming(work)
    assert inc.upstream == "origin/main"
    assert inc.behind == 1 and "change zshrc" in inc.commits[0]
    assert ("M", "config/zshrc") in inc.files and ("A", "src/x.py") in inc.files
    assert update.affected([p for _, p in inc.files], work) == ["zsh", "installer"]
    assert update.blocker(inc) is None


def test_fast_forward(clones):
    upstream, work = clones
    push_change(upstream)
    update.fetch(work)
    assert update.fast_forward(core.Ctx(), update.incoming(work), work)
    assert (work / "config" / "zshrc").read_text() == "changed\n"
    assert update.incoming(work).behind == 0


def test_dirty_tree_blocks_fast_forward(clones):
    upstream, work = clones
    push_change(upstream)
    update.fetch(work)
    (work / "links.yaml").write_text("modules: {}\n")
    inc = update.incoming(work)
    assert inc.dirty and "uncommitted" in (update.blocker(inc) or "")
    assert not update.fast_forward(core.Ctx(), inc, work)
    assert (work / "config" / "zshrc").read_text() == "new zshrc\n"


def test_no_upstream(repo, tmp_path):
    shutil.rmtree(repo / ".git", ignore_errors=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    inc = update.incoming(repo)
    assert inc.upstream is None and update.blocker(inc)


def test_affected_paths(repo):
    assert update.affected(["links.yaml"], repo) == ["zsh", "ssh", "zed"]
    assert update.affected(["packages.yaml"], repo) == ["packages", "repos"]
    assert update.affected(["local/ssh.d/hostB"], repo) == ["ssh"]
    assert update.affected(["agents/pi/settings.json", "devcontainers/x"], repo) == [
        "agents",
        "devbox",
    ]
    assert update.affected(["docs/index.md"], repo) == []


def test_extras_to_rerun():
    extras = ["models", "devbox:all"]
    assert update.extras_to_rerun(extras, []) == []
    assert update.extras_to_rerun(extras, ["devbox"]) == ["devbox:all"]
    assert update.extras_to_rerun(extras, ["installer"]) == ["models"]
