import json
from pathlib import Path

import pytest

from dotfiles.devbox import build, cli, config
from dotfiles.devbox.runtime import AppleContainer, Wslc, select

# One line of `wslc list --all --format json` as captured from wslc 3.0.3 (Labels trimmed)
WSLC_LIST = (
    '{"Command":"\\"/usr/local/bin/devb…\\"","ID":"54c3381683b4","Image":"dev-fullstack:0.1.0",'
    '"Names":"devbox-my-app","Networks":"bridge","Ports":"127.0.0.1:2299->2299/tcp","State":"running",'
    '"Status":"Up 15 seconds"}\n'
    '{"ID":"aa","Names":"devbox-other","State":"exited","Status":"Exited (143) 2 seconds ago"}\n'
)


@pytest.fixture
def project(tmp_path, fake_home, monkeypatch):
    p = tmp_path / "My App"
    p.mkdir()
    monkeypatch.setenv("DEVBOX_CONFIG", str(tmp_path / "machine-config"))
    return p


def test_env_file_parsing():
    text = ('# comment\nDEVBOX_PORTS="3000 8085"\nexport DEVBOX_MEMORY=8G  # trailing\n'
            "DEVBOX_PROXY='http://x:1'\nEMPTY=\nnot a line\n1BAD=x\n")
    assert config.parse_env_file(text) == {"DEVBOX_PORTS": "3000 8085", "DEVBOX_MEMORY": "8G",
                                           "DEVBOX_PROXY": "http://x:1", "EMPTY": ""}


def test_windows_paths_keep_backslashes():
    text = 'DEVBOX_SSH_KEY=C:\\Users\\me\\.ssh\\devbox\nQ="C:\\Program Files\\x"  # c\n'
    assert config.parse_env_file(text, windows=True) == {"DEVBOX_SSH_KEY": "C:\\Users\\me\\.ssh\\devbox",
                                                         "Q": "C:\\Program Files\\x"}
    assert config.parse_env_file('A="x \\"y\\""\n', windows=False) == {"A": 'x "y"'}


def test_layering_project_overrides_machine(project, tmp_path):
    (tmp_path / "machine-config").write_text("DEVBOX_MEMORY=8G\nDEVBOX_PROXY=http://p:8888\n")
    (project / ".devbox.env").write_text("DEVBOX_MEMORY=12G\n")
    cfg = config.settings(project)
    assert cfg["DEVBOX_MEMORY"] == "12G" and cfg["DEVBOX_PROXY"] == "http://p:8888" and cfg["DEVBOX_CPUS"] == "4"


def test_cksum_matches_posix_and_ports_are_stable():
    # values from `printf %s <name> | cksum` (GNU coreutils)
    assert config.cksum(b"devbox-my-app") == 1739217117
    assert config.cksum(b"devbox-dev-config") == 2729352507
    assert config.cksum(b"devbox-a-much-longer-project-name_with.dots") == 821580055
    assert config.cksum(b"") == 4294967295


def test_name_slug_and_ssh_port(project):
    cfg = config.settings(project)
    assert cfg.name == "devbox-my-app"
    assert cfg.ssh_port == 2200 + 1739217117 % 800


def test_size_bytes():
    assert config.size_bytes("40G") == 40 * 1024 ** 3
    assert config.size_bytes("512m") == 512 * 1024 ** 2
    assert config.size_bytes("10GB") == 10 * 1024 ** 3
    with pytest.raises(ValueError):
        config.size_bytes("lots")


def test_apple_run_args_match_the_bash_version(project, tmp_path):
    (project / ".devbox.env").write_text('DEVBOX_PORTS="3000 8080:3000"\nDEVBOX_PROXY=http://192.168.64.1:8888\n'
                                         "DEVBOX_NO_PROXY=floci\n")
    cfg = config.settings(project)
    port = cfg.ssh_port
    n = "devbox-my-app"
    no = "localhost,127.0.0.1,::1,172.16.0.0/12,floci"
    assert AppleContainer().run_args(cfg, pubkey="ssh-ed25519 AAA x", agent=True) == [
        "run", "-d", "--name", n, "-m", "6G", "-c", "4",
        "--cap-add", "CAP_NET_ADMIN", "--cap-add", "CAP_SYS_ADMIN", "--ssh",
        "-p", "127.0.0.1:3000:3000", "-p", "127.0.0.1:8080:3000", "-p", f"127.0.0.1:{port}:{port}",
        "-e", "DEVBOX_DOCKER=1", "-e", "DEVBOX_SSHD=1", "-e", f"DEVBOX_SSHD_PORT={port}",
        "-e", "DEVBOX_PROXY_INJECT=off", "-e", "TERM=xterm-256color", "-e", "DEVBOX_SSH_PUBKEY=ssh-ed25519 AAA x",
        "-e", "HTTP_PROXY=http://192.168.64.1:8888", "-e", "HTTPS_PROXY=http://192.168.64.1:8888",
        "-e", "http_proxy=http://192.168.64.1:8888", "-e", "https_proxy=http://192.168.64.1:8888",
        "-e", f"NO_PROXY={no}", "-e", f"no_proxy={no}",
        "-v", f"{project}:/home/dev/workspace",
        "-v", f"{n}-docker:/var/lib/docker", "-v", f"{n}-zed:/home/dev/.zed_server",
        "-v", f"{n}-uv:/home/dev/.cache/uv", "-v", f"{n}-npm:/home/dev/.npm",
        "dev-fullstack:0.1.0", "sleep", "infinity"]


def test_wslc_run_args_drop_caps_agent_and_docker_volume(project, monkeypatch):
    monkeypatch.setattr("dotfiles.platform.is_wsl", lambda: False)
    cfg = config.settings(project)
    args = Wslc().run_args(cfg, pubkey="k", agent=True)
    assert "--cpus" in args and "-c" not in args
    assert "--cap-add" not in args and "--ssh" not in args
    assert "DEVBOX_DOCKER=0" in args
    assert not any(a.endswith(":/var/lib/docker") for a in args)
    assert args[-3:] == ["dev-fullstack:0.1.0", "sleep", "infinity"]


def test_volume_and_delete_args():
    assert AppleContainer().volume_create_args("v", "40G") == ["volume", "create", "-s", "40G", "v"]
    assert Wslc().volume_create_args("v", "40G") == ["volume", "create", "-d", "vhd", "-o", f"SizeBytes={40 * 1024 ** 3}", "v"]
    assert Wslc().volume_create_args("v", None) == ["volume", "create", "v"]
    assert AppleContainer().delete_args("x") == ["delete", "x"] and Wslc().delete_args("x") == ["remove", "x"]


def test_state_parsing():
    w = Wslc()
    assert w.parse_state(WSLC_LIST, "devbox-my-app") == "running"
    assert w.parse_state(WSLC_LIST, "devbox-other") == "stopped"
    assert w.parse_state(WSLC_LIST, "devbox-my") == ""
    assert w.parse_state("", "x") == ""
    apple = json.dumps([{"configuration": {"id": "devbox-a"}, "status": {"state": "running"}},
                        {"configuration": {"id": "devbox-b"}, "status": "stopped"}])
    a = AppleContainer()
    assert a.parse_state(apple, "devbox-a") == "running"
    assert a.parse_state(apple, "devbox-b") == "stopped"
    assert a.parse_state(apple, "devbox-c") == "" and a.parse_state("not json", "x") == ""


def test_ssh_block_per_runtime(project, fake_home):
    cfg = config.settings(project)
    apple = cli.Devbox(cfg, AppleContainer()).ssh_block()
    assert "HostName localhost" in apple and "ForwardAgent" not in apple
    assert "IdentityFile ~/.ssh/devbox" in apple
    w = cli.Devbox(cfg, Wslc()).ssh_block()
    assert "HostName 127.0.0.1" in w and "\n  ForwardAgent yes\n" in w
    assert f"Port {cfg.ssh_port}" in w


def test_ssh_path_quotes_outside_home(fake_home, tmp_path):
    assert cli.ssh_path(fake_home / ".ssh" / "devbox") == "~/.ssh/devbox"
    assert cli.ssh_path(tmp_path / "with space" / "k") == f'"{(tmp_path / "with space" / "k").as_posix()}"'


def test_install_ssh_config_names_file_after_container(project, fake_home, capsys):
    entry = cli.Devbox(config.settings(project), Wslc()).install_ssh_config()
    assert entry == fake_home / ".ssh" / "config.d" / "devbox-my-app"
    assert entry.read_text().startswith("Host devbox-my-app\n")
    assert "Include ~/.ssh/config.d/*" in capsys.readouterr().err   # no ~/.ssh/config yet


def test_runtime_selection(monkeypatch):
    assert isinstance(select("wslc"), Wslc) and isinstance(select("container"), AppleContainer)
    monkeypatch.setattr("dotfiles.platform.os_name", lambda: "macos")
    assert isinstance(select(), AppleContainer)
    monkeypatch.setattr("dotfiles.platform.os_name", lambda: "windows")
    assert isinstance(select(), Wslc)


def test_build_args_and_staging(tmp_path):
    assert build.build_args("t", "images/x.Dockerfile", "", ["--no-cache"]) == \
        ["build", "-t", "t", "-f", "images/x.Dockerfile", "--no-cache", "."]
    with_proxy = build.build_args("t", "f", "http://p:1", [])
    assert with_proxy[:3] == ["build", "--build-arg", "HTTP_PROXY=http://p:1"]
    assert "NO_PROXY=localhost,127.0.0.1" in with_proxy

    repo = tmp_path / "repo"
    (repo / "config" / "zsh").mkdir(parents=True)
    (repo / "config" / "zsh" / ".zshrc").write_text("z")
    (repo / "config" / "starship").mkdir()
    (repo / "config" / "starship" / "starship.toml").write_text("s")
    (repo / "local" / "certificates").mkdir(parents=True)
    (repo / "local" / "certificates" / "corp.crt").write_text("c")
    ctx = tmp_path / "ctx"
    (ctx / "certificates").mkdir(parents=True)
    (ctx / "certificates" / "stale.crt").write_text("old")
    build.stage(repo, ctx)
    assert (ctx / "config" / "zsh" / ".zshrc").read_text() == "z"
    assert (ctx / "config" / "starship.toml").read_text() == "s"
    assert sorted(p.name for p in (ctx / "certificates").glob("*.crt")) == ["corp.crt"]


def test_tinyproxy_setup_refused_on_wslc(tmp_path, monkeypatch):
    (tmp_path / "local" / "proxy").mkdir(parents=True)
    (tmp_path / "local" / "proxy" / "tinyproxy.conf").write_text("")
    monkeypatch.delenv("BUILD_PROXY", raising=False)
    monkeypatch.delenv("USE_PROXY", raising=False)
    with pytest.raises(Exception, match="BUILD_PROXY"):
        build.resolve_proxy(Wslc(), tmp_path)
    monkeypatch.setenv("USE_PROXY", "0")
    assert build.resolve_proxy(Wslc(), tmp_path) == ""
    monkeypatch.setenv("BUILD_PROXY", "http://host.wslc.internal:8888")
    assert build.resolve_proxy(Wslc(), tmp_path) == "http://host.wslc.internal:8888"


def test_help_and_unknown_command(capsys):
    assert cli.main(["help"]) == 0 and "Commands:" in capsys.readouterr().out
    assert cli.main(["frobnicate"]) == 1
