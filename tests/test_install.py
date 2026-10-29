import sys

import pytest

from dotfiles import agents, cli, core, install, links, packages, state


@pytest.fixture
def calls(monkeypatch):
    """Stub every section so install.run can be checked without touching the machine."""
    seen = []
    monkeypatch.setattr(
        packages, "install_all", lambda ctx, opts, root: seen.append("packages") or {"a": "present"}
    )
    monkeypatch.setattr(packages, "install_repos", lambda ctx, opts, root: seen.append("repos"))
    monkeypatch.setattr(
        links, "link_modules", lambda ctx, names, root: seen.append(f"links:{names}") or True
    )
    monkeypatch.setattr(
        agents, "sync", lambda ctx, only, root, opts: seen.append(f"agents:{only}") or True
    )
    monkeypatch.setattr(state, "save", lambda sel, root: seen.append("saved"))
    return seen


def test_runs_selected_sections_in_order(calls):
    sel = install.Selection(modules=["zsh", "packages", "agents"], agents=["pi"])
    results = install.run(core.Ctx(), sel)
    assert calls == ["packages", "links:['zsh']", "agents:['pi']", "saved"]
    assert results == {"packages": True, "links": True, "agents": True}


def test_dry_run_is_not_recorded_and_extras_are_child_commands(calls, monkeypatch):
    said = []
    monkeypatch.setattr(core, "SINK", lambda level, msg: said.append((level, msg)))
    sel = install.Selection(modules=[], extras=["devbox:core"])
    assert install.run(core.Ctx(dry_run=True), sel) == {"devbox:core": True}
    assert "saved" not in calls
    assert ("dry", f"{sys.executable} -m dotfiles.devbox build core") in said


def test_selection_round_trip():
    sel = install.Selection(
        modules=["packages", "zsh"],
        agents=["claude"],
        extras=["models"],
        opts=packages.Opts(prefer=["brew"], names=["gh"]),
    )
    assert install.Selection.from_dict(sel.to_dict()) == sel
    # unknown names from an older or newer record are dropped, not fatal
    odd = install.Selection.from_dict({"modules": ["zsh", "gone"], "extras": ["nope"], "opts": {}})
    assert odd.modules == ["zsh"] and odd.extras == []


def test_state_save_and_load(fake_home, repo):
    assert state.load() is None
    state.save({"modules": ["zsh"]}, repo)
    saved = state.load()
    assert saved is not None and saved["selection"] == {"modules": ["zsh"]}
    assert (fake_home / ".local" / "state" / "dotfiles" / "install.json").exists()


def test_cli_install_builds_selection(calls):
    assert cli.main(["install", "--only", "zsh,git", "--extras", "models", "-n"]) == 0
    assert calls[0] == "links:['zsh', 'git']"


def test_cli_rejects_unknown_extra():
    with pytest.raises(SystemExit):
        cli.main(["install", "--extras", "spells"])


def test_no_command_without_a_terminal(monkeypatch, capsys):
    monkeypatch.setattr(cli, "interactive", lambda: False)
    assert cli.main([]) == 2
    assert "needs a terminal" in capsys.readouterr().err
