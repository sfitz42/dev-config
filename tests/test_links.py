import os
from pathlib import Path

from dotfiles import links
from dotfiles.core import Ctx


def mk(tmp_path, **kw):
    kw.setdefault("backup_root", tmp_path / "backups")
    return Ctx(stamp="t1", **kw)


def test_link_modules_and_status(fake_home, repo, tmp_path):
    c = mk(tmp_path)
    assert links.link_modules(c, ["zsh", "ssh", "zed"], root=repo)
    assert Path(os.readlink(fake_home / ".zshrc")) == repo / "config" / "zshrc"
    assert (fake_home / ".ssh").stat().st_mode & 0o777 == 0o700
    assert (fake_home / ".ssh/config.d/hostA").is_symlink()
    assert not (fake_home / ".ssh/config.d/host.example").exists()   # *.example is skipped
    assert not (fake_home / ".config/zed/settings.json").is_symlink()  # copied, not linked
    assert {s for _, _, s in links.link_status(repo)} == {"ok"}


def test_status_reports_problems(fake_home, repo):
    (fake_home / ".zshrc").write_text("real file")
    rows = {Path(d).name: s for _, d, s in links.link_status(repo)}
    assert rows[".zshrc"] == "not-a-link" and rows["hostA"] == "missing"


def test_unknown_module_fails(fake_home, repo, tmp_path):
    assert not links.link_modules(mk(tmp_path), ["nope"], root=repo)


def test_uninstall_roundtrip_restores_originals(fake_home, repo, tmp_path):
    (fake_home / ".zshrc").write_text("original")
    c = mk(tmp_path, backup_root=fake_home / ".config-backups")
    links.link_modules(c, ["zsh", "ssh"], root=repo)
    assert (fake_home / ".zshrc").is_symlink()
    u = Ctx(backup_root=fake_home / ".config-backups")
    assert links.unlink_all(u) == 2            # .zshrc + hostA
    assert links.restore_backups(u) == 1
    assert (fake_home / ".zshrc").read_text() == "original" and not (fake_home / ".zshrc").is_symlink()
    assert not (fake_home / ".ssh/config.d/hostA").exists()


def test_unlink_leaves_changed_targets_alone(fake_home, repo, tmp_path):
    c = mk(tmp_path)
    links.link_modules(c, ["zsh"], root=repo)
    (fake_home / ".zshrc").unlink(); (fake_home / ".zshrc").write_text("user replaced")
    assert links.unlink_all(Ctx()) == 0
    assert (fake_home / ".zshrc").read_text() == "user replaced"
