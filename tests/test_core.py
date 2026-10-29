import os
import pathlib

import conftest

from dotfiles import core

pytestmark = conftest.needs_symlinks


def ctx(tmp_path, **kw):
    return core.Ctx(backup_root=tmp_path / "backups", stamp="t1", **kw)


def test_dry_run_changes_nothing(fake_home, tmp_path):
    src = tmp_path / "src"
    src.write_text("x")
    c = ctx(tmp_path, dry_run=True)
    assert core.link_file(c, src, fake_home / ".zshrc")
    assert not (fake_home / ".zshrc").exists() and not (fake_home / ".zshrc").is_symlink()
    assert not (tmp_path / "backups").exists()


def test_fresh_link_then_idempotent(fake_home, tmp_path):
    src = tmp_path / "src"
    src.write_text("x")
    c = ctx(tmp_path)
    core.link_file(c, src, fake_home / ".zshrc")
    assert pathlib.Path(os.readlink(fake_home / ".zshrc")) == src
    assert (c.linked, c.unchanged, c.backed_up) == (1, 0, 0)
    c2 = ctx(tmp_path)
    core.link_file(c2, src, fake_home / ".zshrc")
    assert (c2.linked, c2.unchanged, c2.backed_up) == (0, 1, 0)


def test_existing_file_is_backed_up(fake_home, tmp_path):
    src = tmp_path / "src"
    src.write_text("new")
    dst = fake_home / ".zshrc"
    dst.write_text("mine")
    c = ctx(tmp_path)
    core.link_file(c, src, dst)
    assert dst.is_symlink()
    assert (c.backup_dir / ".zshrc").read_text() == "mine"
    assert str(dst) in (c.backup_dir / "manifest.tsv").read_text()
    assert c.backed_up == 1


def test_wrong_symlink_is_replaced_with_backup(fake_home, tmp_path):
    src = tmp_path / "src"
    src.write_text("x")
    other = tmp_path / "other"
    other.write_text("y")
    dst = fake_home / ".zshrc"
    dst.symlink_to(other)
    c = ctx(tmp_path)
    core.link_file(c, src, dst)
    assert pathlib.Path(os.readlink(dst)) == src and c.backed_up == 1


def test_nested_parent_created_and_missing_source_fails(fake_home, tmp_path):
    src = tmp_path / "src"
    src.write_text("x")
    c = ctx(tmp_path)
    assert core.link_file(c, src, fake_home / ".config" / "a" / "conf")
    assert not core.link_file(c, tmp_path / "nope", fake_home / ".x")
    assert not (fake_home / ".x").exists()


def test_copy_if_missing_never_overwrites(fake_home, tmp_path):
    src = tmp_path / "src"
    src.write_text("repo")
    dst = fake_home / "s.json"
    c = ctx(tmp_path)
    core.copy_if_missing(c, src, dst)
    assert dst.read_text() == "repo" and not dst.is_symlink()
    dst.write_text("app edited")
    core.copy_if_missing(c, src, dst)
    assert dst.read_text() == "app edited"


def test_dangling_link_is_repointed_without_backup(fake_home, tmp_path):
    old = tmp_path / "old-repo"
    old.mkdir()
    (old / "f").write_text("x")
    new = tmp_path / "new-repo"
    new.mkdir()
    (new / "f").write_text("x")
    dst = fake_home / ".zshrc"
    c0 = ctx(tmp_path)
    core.link_file(c0, old / "f", dst)
    (old / "f").unlink()
    old.rmdir()  # the repo "moves": old target vanishes
    c = ctx(tmp_path)
    assert core.link_file(c, new / "f", dst)
    assert pathlib.Path(os.readlink(dst)) == new / "f"
    assert c.backed_up == 0 and not (tmp_path / "backups").exists()


def test_link_record_keeps_one_line_per_destination(fake_home, tmp_path):
    a = tmp_path / "a"
    a.write_text("1")
    b = tmp_path / "b"
    b.write_text("2")
    dst = fake_home / ".x"
    core.link_file(ctx(tmp_path), a, dst)
    dst.unlink()
    core.link_file(ctx(tmp_path), b, dst)
    lines = (core.state_dir() / "links.tsv").read_text().splitlines()
    assert lines == [f"{dst}\t{b}"]
