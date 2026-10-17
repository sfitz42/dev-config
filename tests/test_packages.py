import hashlib

import pytest

from dotfiles import packages
from dotfiles.core import Ctx


@pytest.fixture(autouse=True)
def no_brew_path(monkeypatch):
    monkeypatch.setattr(packages, "_which", lambda cmd: cmd in ("brew", "present-cmd"))


def test_is_installed_checks(tmp_path, fake_home):
    (fake_home / "App.app").mkdir()
    assert packages.is_installed({"app": "~/App.app"})
    assert not packages.is_installed({"app": "~/Nope.app"})
    assert packages.is_installed({"cmd": "present-cmd"})
    assert not packages.is_installed({"cmd": "absent-cmd"})


def test_casks_off_by_default_and_prefer_reorders():
    pkg = {"sources": [{"type": "brew-cask", "name": "x"}, {"type": "dmg", "url": "u"}, {"type": "web", "url": "w"}]}
    assert [s["type"] for s in packages.ordered_sources(pkg, {}, packages.Opts())] == ["dmg", "web"]
    assert [s["type"] for s in packages.ordered_sources(pkg, {"brew_casks": True}, packages.Opts())] == ["brew-cask", "dmg", "web"]
    assert [s["type"] for s in packages.ordered_sources(pkg, {"brew_casks": True}, packages.Opts(prefer=["web", "dmg"]))] == ["web", "dmg", "brew-cask"]


def test_no_brew_drops_brew_sources():
    pkg = {"sources": [{"type": "brew", "name": "x"}, {"type": "script", "url": "u"}]}
    assert [s["type"] for s in packages.ordered_sources(pkg, {}, packages.Opts(no_brew=True))] == ["script"]


def test_present_package_is_skipped_and_web_is_manual():
    c = Ctx(dry_run=True)
    data = {"defaults": {}}
    assert packages.install_package(c, "a", {"check": {"cmd": "present-cmd"}, "sources": []}, data, packages.Opts()) == "present"
    web = {"check": {"cmd": "absent-cmd"}, "sources": [{"type": "web", "url": "https://x"}]}
    assert packages.install_package(c, "b", web, data, packages.Opts()) == "manual"


def test_optional_skipped_unless_asked():
    c = Ctx(dry_run=True)
    pkg = {"check": {"cmd": "absent-cmd"}, "optional": True, "sources": [{"type": "brew", "name": "x"}]}
    assert packages.install_package(c, "t", pkg, {"defaults": {}}, packages.Opts()) == "skipped"
    assert packages.install_package(c, "t", pkg, {"defaults": {}}, packages.Opts(with_optional=True)) == "installed"


def test_download_verifies_sha256(tmp_path, monkeypatch):
    payload = b"hello"
    src = tmp_path / "f.bin"; src.write_bytes(payload)
    url = src.as_uri()
    good = hashlib.sha256(payload).hexdigest()
    out = tmp_path / "out"; out.mkdir()
    assert packages.download(Ctx(), url, out, good).read_bytes() == payload
    bad = tmp_path / "bad"; bad.mkdir()
    assert packages.download(Ctx(), url, bad, "0" * 64) is None
    assert not (bad / "f.bin").exists()      # a failed download is deleted


def test_unpinned_script_requires_approval(monkeypatch):
    c = Ctx(yes=False)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False, raising=False)
    assert packages._script(c, {"url": "https://x/install.sh", "pinned": False}, "p") is False


def test_local_override_excludes_and_prefers(tmp_path):
    (tmp_path / "local").mkdir()
    (tmp_path / "packages.yaml").write_text("packages:\n  a: {check: {cmd: a}, sources: []}\n  b: {check: {cmd: b}, sources: []}\n")
    (tmp_path / "local" / "packages.local.yaml").write_text("exclude: [b]\nprefer: [dmg]\ndefaults: {brew_casks: true}\n")
    d = packages.load_manifest(tmp_path)
    assert list(d["packages"]) == ["a"] and d["prefer"] == ["dmg"] and d["defaults"]["brew_casks"] is True
