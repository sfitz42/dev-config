import subprocess

from dotfiles import core, identity


def _git_global(key):
    return subprocess.run(
        ["git", "config", "--global", "--get", key], capture_output=True, text=True
    ).stdout.strip()


def _isolate(fake_home, monkeypatch):
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setattr(identity, "suggest_name", lambda: "")


def test_asks_for_what_git_lacks(fake_home, monkeypatch):
    _isolate(fake_home, monkeypatch)
    asked = []

    def ask(question, default):
        asked.append(question)
        return "Ada Lovelace" if "name" in question else "ada@example.com"

    ctx = core.Ctx(ask_text=ask)
    assert identity.ensure(ctx)
    assert len(asked) == 2
    assert _git_global("user.name") == "Ada Lovelace"
    assert _git_global("user.email") == "ada@example.com"


def test_does_not_ask_when_detected(fake_home, monkeypatch):
    _isolate(fake_home, monkeypatch)
    (fake_home / ".gitconfig").write_text("[user]\n\tname = Ada\n\temail = a@b.c\n")

    def ask(question, default):
        raise AssertionError("should not ask")

    assert identity.ensure(core.Ctx(ask_text=ask))


def test_unanswered_is_skipped_not_failed(fake_home, monkeypatch):
    _isolate(fake_home, monkeypatch)
    assert identity.ensure(core.Ctx(yes=True))
    assert _git_global("user.name") == ""


def test_dry_run_changes_nothing(fake_home, monkeypatch):
    _isolate(fake_home, monkeypatch)
    assert identity.ensure(core.Ctx(dry_run=True, ask_text=lambda q, d: "x"))
    assert _git_global("user.name") == ""
