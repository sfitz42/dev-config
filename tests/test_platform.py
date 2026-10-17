from dotfiles import platform


def test_pkg_manager_from_os_release(tmp_path):
    f = tmp_path / "os-release"
    f.write_text('NAME="Fedora Linux"\nID=fedora\nVERSION_ID=43\n')
    assert platform.pkg_manager(platform.os_release(f)) == "dnf"
    assert platform.pkg_manager({"ID": "ubuntu", "ID_LIKE": "debian"}) == "apt"
    assert platform.pkg_manager({"ID": "pop", "ID_LIKE": "ubuntu debian"}) == "apt"
    assert platform.pkg_manager({"ID": "arch"}) is None
    assert platform.os_release(tmp_path / "missing") == {}


def test_supported():
    assert platform.supported({}, "linux")
    assert platform.supported({"os": ["linux"]}, "linux")
    assert not platform.supported({"os": ["macos"]}, "linux")
    assert platform.supported({"os": None}, "macos")
