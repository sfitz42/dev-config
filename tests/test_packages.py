import hashlib

import pytest

from dotfiles import core, packages


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
    pkg = {
        "sources": [
            {"type": "brew-cask", "name": "x"},
            {"type": "dmg", "url": "u"},
            {"type": "web", "url": "w"},
        ]
    }
    assert [s["type"] for s in packages.ordered_sources(pkg, {}, packages.Opts())] == ["dmg", "web"]
    assert [
        s["type"] for s in packages.ordered_sources(pkg, {"brew_casks": True}, packages.Opts())
    ] == ["brew-cask", "dmg", "web"]
    assert [
        s["type"]
        for s in packages.ordered_sources(
            pkg, {"brew_casks": True}, packages.Opts(prefer=["web", "dmg"])
        )
    ] == ["web", "dmg", "brew-cask"]


def test_no_brew_drops_brew_sources():
    pkg = {"sources": [{"type": "brew", "name": "x"}, {"type": "script", "url": "u"}]}
    assert [s["type"] for s in packages.ordered_sources(pkg, {}, packages.Opts(no_brew=True))] == [
        "script"
    ]


def test_present_package_is_skipped_and_web_is_manual():
    c = core.Ctx(dry_run=True)
    data = {"defaults": {}}
    assert (
        packages.install_package(
            c, "a", {"check": {"cmd": "present-cmd"}, "sources": []}, data, packages.Opts()
        )
        == "present"
    )
    web = {"check": {"cmd": "absent-cmd"}, "sources": [{"type": "web", "url": "https://x"}]}
    assert packages.install_package(c, "b", web, data, packages.Opts()) == "manual"


def test_optional_skipped_unless_asked():
    c = core.Ctx(dry_run=True)
    pkg = {
        "check": {"cmd": "absent-cmd"},
        "optional": True,
        "sources": [{"type": "brew", "name": "x"}],
    }
    assert packages.install_package(c, "t", pkg, {"defaults": {}}, packages.Opts()) == "skipped"
    assert (
        packages.install_package(c, "t", pkg, {"defaults": {}}, packages.Opts(with_optional=True))
        == "installed"
    )


def test_download_verifies_sha256(tmp_path, monkeypatch):
    payload = b"hello"
    src = tmp_path / "f.bin"
    src.write_bytes(payload)
    url = src.as_uri()
    good = hashlib.sha256(payload).hexdigest()
    out = tmp_path / "out"
    out.mkdir()
    assert packages.download(core.Ctx(), url, out, good).read_bytes() == payload
    bad = tmp_path / "bad"
    bad.mkdir()
    assert packages.download(core.Ctx(), url, bad, "0" * 64) is None
    assert not (bad / "f.bin").exists()  # a failed download is deleted


def test_unpinned_script_requires_approval(monkeypatch):
    c = core.Ctx(yes=False)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False, raising=False)
    assert packages._script(c, {"url": "https://x/install.sh", "pinned": False}, "p") is False


class Rec(core.Ctx):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.cmds = []

    def run(self, cmd, **kw):
        self.cmds.append(list(cmd))


@pytest.fixture
def on_linux(monkeypatch):
    def set_(manager="dnf"):
        monkeypatch.setattr(packages.platform, "os_name", lambda: "linux")
        monkeypatch.setattr(packages.platform, "pkg_manager", lambda release=None: manager)

    return set_


def test_os_limited_sources_and_packages(on_linux):
    on_linux("dnf")
    pkg = {
        "sources": [
            {"type": "brew", "name": "x"},
            {"type": "dnf", "name": "x"},
            {"type": "apt", "name": "x"},
            {"type": "dmg", "url": "u", "os": ["macos"]},
            {"type": "script", "url": "s", "os": ["linux"]},
        ]
    }
    # brew stays only because _which("brew") is faked; apt is dropped on a dnf distro, dmg on linux
    assert [s["type"] for s in packages.ordered_sources(pkg, {}, packages.Opts())] == [
        "brew",
        "dnf",
        "script",
    ]
    mac_only = {"os": ["macos"], "check": {"cmd": "absent-cmd"}, "sources": []}
    assert (
        packages.install_package(
            core.Ctx(dry_run=True), "m", mac_only, {"defaults": {}}, packages.Opts()
        )
        == "unsupported"
    )


def test_native_installs_ask_once_and_apt_updates_once(on_linux, tmp_path):
    on_linux("apt")
    c = Rec(yes=True)
    data = {"defaults": {}}
    for n in ("a", "b"):
        pkg = {
            "check": {"cmd": "absent-cmd"},
            "sources": [{"type": "dnf", "name": n}, {"type": "apt", "name": n}],
        }
        assert packages.install_package(c, n, pkg, data, packages.Opts()) == "installed"
    assert c.cmds == [
        ["sudo", "apt-get", "update"],
        ["sudo", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "a"],
        ["sudo", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "b"],
    ]


def test_native_install_skipped_without_sudo_approval(on_linux, monkeypatch):
    on_linux("dnf")
    monkeypatch.setattr("sys.stdin.isatty", lambda: False, raising=False)
    c = Rec(yes=False)
    assert packages._dnf(c, {"name": "x"}, "x") is False and c.cmds == []


def test_cmd_check_accepts_alternatives():
    assert packages.is_installed({"cmd": ["absent-cmd", "present-cmd"]})
    assert not packages.is_installed({"cmd": ["absent-cmd", "nope"]})


def test_script_interpreter_follows_shebang(tmp_path):
    b = tmp_path / "b.sh"
    b.write_text("#!/bin/bash\necho\n")
    s = tmp_path / "s.sh"
    s.write_text("#!/bin/sh\necho\n")
    assert packages._interpreter(b) == "bash" and packages._interpreter(s) == "/bin/sh"
    assert packages._interpreter(tmp_path / "missing") == "/bin/sh"


def test_real_manifest_has_a_source_for_every_linux_package(monkeypatch):
    """Every package that applies on Fedora (dnf) and Ubuntu (apt) has a usable source."""
    monkeypatch.setattr(packages.platform, "os_name", lambda: "linux")
    monkeypatch.setattr(packages, "_which", lambda cmd: False)  # no brew on Linux
    data = packages.load_manifest()
    for manager in ("dnf", "apt"):
        monkeypatch.setattr(packages.platform, "pkg_manager", lambda release=None, m=manager: m)
        for name, pkg in data["packages"].items():
            if packages.platform.supported(pkg):
                assert packages.ordered_sources(pkg, data["defaults"], packages.Opts()), (
                    f"{name} on {manager}"
                )


def test_local_override_excludes_and_prefers(tmp_path):
    (tmp_path / "local").mkdir()
    (tmp_path / "packages.yaml").write_text(
        "packages:\n  a: {check: {cmd: a}, sources: []}\n  b: {check: {cmd: b}, sources: []}\n"
    )
    (tmp_path / "local" / "packages.local.yaml").write_text(
        "exclude: [b]\nprefer: [dmg]\ndefaults: {brew_casks: true}\n"
    )
    d = packages.load_manifest(tmp_path)
    assert (
        list(d["packages"]) == ["a"]
        and d["prefer"] == ["dmg"]
        and d["defaults"]["brew_casks"] is True
    )
