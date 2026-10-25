import os
import tempfile

import pytest


def _can_symlink() -> bool:
    with tempfile.TemporaryDirectory() as d:
        try:
            os.symlink(__file__, os.path.join(d, "l"))
            return True
        except OSError:  # Windows without Developer Mode / admin
            return False


# The linker targets macOS and Linux/WSL; on Windows these tests need symlink rights
needs_symlinks = pytest.mark.skipif(
    not _can_symlink(), reason="symlinks not available (Windows without Developer Mode)"
)


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """A throwaway $HOME so nothing real is touched."""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    monkeypatch.setenv("USERPROFILE", str(h))  # what expanduser reads on Windows
    monkeypatch.delenv("XDG_STATE_HOME", raising=False)
    return h


@pytest.fixture
def repo(tmp_path):
    """A minimal fake repo root with a links.yaml and config files."""
    r = tmp_path / "repo"
    (r / "config").mkdir(parents=True)
    (r / "config" / "zshrc").write_text("new zshrc\n")
    (r / "config" / "settings.json").write_text("{}\n")
    (r / "local" / "ssh.d").mkdir(parents=True)
    (r / "local" / "ssh.d" / "hostA").write_text("Host hostA\n")
    (r / "local" / "ssh.d" / "host.example").write_text("Host <HOST>\n")
    (r / "links.yaml").write_text(
        "modules:\n"
        "  zsh:\n"
        "    - {src: config/zshrc, dst: ~/.zshrc}\n"
        "  ssh:\n"
        "    - {mkdir: ~/.ssh, mode: '700'}\n"
        "    - {glob: 'local/ssh.d/*', dst_dir: ~/.ssh/config.d, exclude: '*.example'}\n"
        "  zed:\n"
        "    - {src: config/settings.json, dst: ~/.config/zed/settings.json, copy: if-missing}\n"
    )
    return r
