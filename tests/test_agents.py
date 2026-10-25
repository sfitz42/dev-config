import json
import pathlib

import pytest

from dotfiles import agents, core


class Rec(core.Ctx):
    """Ctx that records commands instead of running them."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.cmds = []

    def run(self, cmd, **kw):
        self.cmds.append(list(cmd))


def mk(tmp_path, **kw):
    return Rec(backup_root=tmp_path / "backups", stamp="t1", **kw)


def test_settings_merge_keeps_other_keys_and_is_idempotent(fake_home, repo, tmp_path):
    (repo / "s.json").write_text(json.dumps({"model": "sonnet", "nested": {"a": 1}}))
    target = fake_home / ".app" / "settings.json"
    target.parent.mkdir()
    target.write_text(json.dumps({"model": "opus", "keep": True, "nested": {"b": 2}}))
    spec = {"file": "s.json", "target": "~/.app/settings.json"}
    c = mk(tmp_path)
    assert agents.sync_settings(c, spec, repo) is True
    assert json.loads(target.read_text()) == {
        "model": "sonnet",
        "keep": True,
        "nested": {"a": 1, "b": 2},
    }
    assert (
        json.loads((c.backup_dir / ".app" / "settings.json").read_text())["model"] == "opus"
    )  # snapshot
    assert agents.sync_settings(mk(tmp_path), spec, repo) is False  # second run: no-op


def test_settings_created_when_missing_and_dry_run_writes_nothing(fake_home, repo, tmp_path):
    (repo / "s.json").write_text('{"a": 1}')
    spec = {"file": "s.json", "target": "~/new/settings.json"}
    agents.sync_settings(mk(tmp_path, dry_run=True), spec, repo)
    assert not (fake_home / "new").exists()
    agents.sync_settings(mk(tmp_path), spec, repo)
    assert json.loads((fake_home / "new/settings.json").read_text()) == {"a": 1}


def test_models_not_rendered_without_secret(fake_home, repo, tmp_path):
    (repo / "m.tmpl").write_text('{"key": "${SECRET}"}')
    target = fake_home / "models.json"
    target.write_text('{"key": "existing"}')
    spec = {"template": "m.tmpl", "target": "~/models.json", "env": ["SECRET"]}
    assert agents.sync_models(mk(tmp_path), spec, repo, {}) is False
    assert json.loads(target.read_text()) == {"key": "existing"}  # untouched
    assert agents.sync_models(mk(tmp_path), spec, repo, {"SECRET": "s3"}) is True
    assert json.loads(target.read_text()) == {"key": "s3"}
    assert agents.sync_models(mk(tmp_path), spec, repo, {"SECRET": "s3"}) is False  # idempotent


def test_read_env_from_local_file(repo, monkeypatch):
    (repo / "local" / "agents.env").write_text("# c\nOMLX_API_KEY=abc=def\n")
    monkeypatch.delenv("OMLX_API_KEY", raising=False)
    assert agents.read_env(repo)["OMLX_API_KEY"] == "abc=def"


def test_local_override_merges_lists_and_dicts(repo):
    (repo / "agents" / "x").mkdir(parents=True)
    (repo / "agents/x/agent.yaml").write_text(
        "agent: x\nplugins: [a@m]\nsettings: {file: f, target: t}\n"
    )
    (repo / "local/agents.x.yaml").write_text("plugins: [b@m]\nsettings: {target: t2}\n")
    m = agents.load_agents(repo)["x"]
    assert m["plugins"] == ["a@m", "b@m"] and m["settings"] == {"file": "f", "target": "t2"}


@pytest.fixture
def claude_world(monkeypatch):
    state = {
        "market_list": "claude-plugins-official",
        "plugin_list": "",
        "published": {"defra-aice": ["p1", "p2"], "other": ["z"]},
    }
    monkeypatch.setattr(
        agents,
        "_capture",
        lambda cmd: state["market_list"] if "marketplace" in cmd else state["plugin_list"],
    )
    monkeypatch.setattr(agents, "_marketplace_plugins", lambda name: state["published"].get(name))
    return state


def test_plugins_are_opt_in(claude_world, tmp_path):
    m = {"marketplaces": [{"name": "other", "source": "o/o"}], "plugins": []}
    c = mk(tmp_path)
    agents.sync_claude(c, m)
    assert not any(
        cmd[:3] == ["claude", "plugin", "install"] for cmd in c.cmds
    )  # marketplace added, nothing installed
    assert ["claude", "plugin", "marketplace", "add", "o/o"] in c.cmds


def test_install_all_flag_and_explicit_plugins(claude_world, tmp_path):
    claude_world["plugin_list"] = '[{"id": "p1@defra-aice"}]'  # p1 already installed
    m = {
        "marketplaces": [
            {"name": "defra-aice", "source": "D/a", "install_all": True},
            {"name": "other", "source": "o/o"},
        ],
        "plugins": ["z@other"],
    }
    c = mk(tmp_path)
    agents.sync_claude(c, m)
    installs = [cmd[3] for cmd in c.cmds if cmd[:3] == ["claude", "plugin", "install"]]
    assert installs == [
        "z@other",
        "p2@defra-aice",
    ]  # explicit + the rest of install_all; p1 skipped; 'other' not expanded


def test_pi_extensions_skip_installed(monkeypatch, tmp_path):
    monkeypatch.setattr(agents, "_capture", lambda cmd: "npm:@a/have\n")
    c = mk(tmp_path)
    agents.sync_pi(c, {"extensions": ["npm:@a/have", "git:github.com/x/y"]})
    assert c.cmds == [["pi", "install", "git:github.com/x/y"]]


def test_real_manifests_are_valid():
    root = pathlib.Path(__file__).resolve().parents[1]
    found = agents.load_agents(root)
    assert {"claude", "pi"} <= set(found)
    mk_ = {m["name"]: m for m in found["claude"]["marketplaces"]}
    assert mk_["defra-aice"]["install_all"] is True and not mk_["claude-plugins-official"].get(
        "install_all"
    )
    tmpl = (root / "agents/pi/models.json.tmpl").read_text()
    assert "${OMLX_API_KEY}" in tmpl and json.loads(tmpl.replace("${OMLX_API_KEY}", "x"))


def test_failed_cli_query_skips_instead_of_reinstalling(monkeypatch, tmp_path):
    monkeypatch.setattr(agents, "_capture", lambda cmd: None)  # e.g. pi without node on PATH
    c = mk(tmp_path)
    agents.sync_pi(c, {"extensions": ["npm:x@1"]})
    agents.sync_claude(c, {"marketplaces": [{"name": "m", "source": "o/m"}], "plugins": ["p@m"]})
    assert c.cmds == []  # nothing was (re)installed


def test_pinned_extension_is_matched_by_exact_source(monkeypatch, tmp_path):
    monkeypatch.setattr(
        agents, "_capture", lambda cmd: "User packages:\n  npm:pkg@0.20.1\n    /path\n"
    )
    c = mk(tmp_path)
    agents.sync_pi(c, {"extensions": ["npm:pkg@0.20.1"]})
    assert c.cmds == []


def test_source_must_match_a_whole_line(monkeypatch, tmp_path):
    monkeypatch.setattr(agents, "_capture", lambda cmd: "User packages:\n  npm:pkg@0.20.10\n")
    c = mk(tmp_path)
    agents.sync_pi(c, {"extensions": ["npm:pkg@0.20.1"]})
    assert c.cmds == [["pi", "install", "npm:pkg@0.20.1"]]


@pytest.fixture
def pi_repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    (root / "pi-extensions/packages/todo-list").mkdir(parents=True)
    monkeypatch.setattr(agents.shutil, "which", lambda name: f"/bin/{name}")
    return root


def test_local_extension_installs_workspace_then_absolute_path(monkeypatch, tmp_path, pi_repo):
    monkeypatch.setattr(agents, "_capture", lambda cmd: "User packages:\n")
    c = mk(tmp_path)
    agents.sync_pi(c, {"extensions": ["./pi-extensions/packages/todo-list"]}, pi_repo)
    pkg = str((pi_repo / "pi-extensions/packages/todo-list").resolve())
    assert c.cmds == [["pnpm", "install", "--frozen-lockfile"], ["pi", "install", pkg]]


def test_local_extension_matched_by_installed_path(monkeypatch, tmp_path, pi_repo):
    pkg = str((pi_repo / "pi-extensions/packages/todo-list").resolve())
    listed = f"User packages:\n  ../../repo/pi-extensions/packages/todo-list\n    {pkg}\n"
    monkeypatch.setattr(agents, "_capture", lambda cmd: listed)
    c = mk(tmp_path)
    agents.sync_pi(c, {"extensions": ["./pi-extensions/packages/todo-list"]}, pi_repo)
    assert c.cmds == [
        ["pnpm", "install", "--frozen-lockfile"]
    ]  # deps refreshed, nothing reinstalled


def test_workspace_installed_once_and_skipped_without_pnpm(monkeypatch, tmp_path, pi_repo):
    monkeypatch.setattr(agents, "_capture", lambda cmd: "User packages:\n")
    exts = {"extensions": ["./pi-extensions/packages/a", "./pi-extensions/packages/b", "npm:x@1"]}
    c = mk(tmp_path)
    agents.sync_pi(c, exts, pi_repo)
    assert [cmd[0] for cmd in c.cmds] == ["pnpm", "pi", "pi", "pi"]

    monkeypatch.setattr(agents.shutil, "which", lambda name: None)
    c = mk(tmp_path)
    agents.sync_pi(c, exts, pi_repo)
    assert c.cmds == [["pi", "install", "npm:x@1"]]  # local ones skipped, npm still synced
