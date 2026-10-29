import sys

import pytest

from dotfiles import core, models, platform

MAC = platform.Platform("macos", "arm64", False, "", None, True, None, ollama="native")
WSL = platform.Platform("linux", "x86_64", True, "Fedora", "dnf", False, None, ollama="windows")


@pytest.fixture
def said(monkeypatch):
    lines = []
    monkeypatch.setattr(core, "SINK", lambda level, msg: lines.append((level, msg)))
    return lines


@pytest.fixture
def wsl(monkeypatch, tmp_path):
    """WSL with ollama.exe on the Windows side and nothing else."""
    exe = tmp_path / "ollama.exe"
    exe.write_text("")
    monkeypatch.setattr(platform, "is_wsl", lambda: True)
    monkeypatch.setattr(platform, "describe", lambda: WSL)
    monkeypatch.setattr(models, "_windows_ollama", lambda: str(exe))
    monkeypatch.setattr(models, "linux_ollama", lambda: None)
    monkeypatch.setattr(models, "reachable", lambda *a: True)
    return exe


def test_manifest_lists_both_runtimes():
    data = models.load_manifest()
    assert models.names(data["omlx"]) and models.names(data["ollama"])
    assert all(":" in tag for tag in models.names(data["ollama"]))  # explicit tags, not `latest`
    assert all(size for _, size in models.entries(data["ollama"]))


def test_wsl_uses_windows_ollama_only(wsl, monkeypatch):
    found = models.find_ollama()
    assert found is not None and found.windows and found.exe == str(wsl)
    # a Linux ollama inside WSL is never picked, only warned about
    monkeypatch.setattr(models, "linux_ollama", lambda: "/usr/local/bin/ollama")
    assert models.find_ollama() == found
    assert any("inside WSL" in w for w in models.wsl_warnings())


def test_wsl_without_windows_ollama_says_where_to_install(monkeypatch):
    monkeypatch.setattr(platform, "is_wsl", lambda: True)
    monkeypatch.setattr(models, "_windows_ollama", lambda: None)
    monkeypatch.setattr(models, "linux_ollama", lambda: None)
    assert models.find_ollama() is None
    assert any("winget install Ollama.Ollama" in w for w in models.wsl_warnings())


def test_pull_ollama_dry_run(wsl, said):
    assert models.pull(core.Ctx(dry_run=True), "ollama", ["gpt-oss:20b"])
    assert ("dry", f"{wsl} pull gpt-oss:20b") in said
    assert any("Ollama on Windows" in msg for _, msg in said)


def test_pull_defaults_to_runtimes_found_here(wsl, said):
    assert models.pull(core.Ctx(dry_run=True))
    steps = [msg for level, msg in said if level == "step"]
    assert steps == ["models: ollama"]  # no oMLX off Apple silicon


def test_unknown_name_is_an_error(wsl, said):
    assert not models.pull(core.Ctx(dry_run=True), "ollama", ["nope:1b"])


def test_available():
    assert models.available("omlx", MAC)[0] and models.available("ollama", MAC)[0]
    assert not models.available("omlx", WSL)[0]
    assert models.available("ollama", WSL) == (True, "into Ollama on Windows")


def test_progress_bars_collapse(said):
    script = (
        "import sys\n"
        "print('pulling manifest')\n"
        "for p in (10, 50, 100):\n"
        "    print(f'\\x1b[2Kpulling 8a43277aac50:  {p}% ▕██▏ 1 GB')\n"
        "print('success')\n"
    )
    core.Ctx(stream=True).run([sys.executable, "-c", script], check=False)
    out = [msg for level, msg in said if level == "out"]
    assert out == ["pulling manifest", "pulling 8a43277aac50:  100% ▕██▏ 1 GB", "success"]


def test_redraws_without_newlines_stream_as_progress(said):
    """What ollama actually prints: no newlines, just 'cursor to column 1' and redraw."""
    script = (
        "import sys, time\n"
        "for s in '⠋⠙⠹':\n"
        "    sys.stdout.write(f'\\x1b[?25l\\x1b[1Gpulling manifest {s}\\x1b[K\\x1b[?25h')\n"
        "    sys.stdout.flush(); time.sleep(0.2)\n"
        "sys.stdout.write('\\x1b[1Gpulling manifest \\x1b[K\\n')\n"
        "print('Error: model requires ollama version v0.40.4 or newer')\n"
    )
    core.Ctx(stream=True).run([sys.executable, "-c", script], check=False)
    progress = [msg for level, msg in said if level == "progress"]
    out = [msg for level, msg in said if level == "out"]
    assert progress and progress[0] == "pulling manifest ⠋"  # live, before the command ended
    assert out == ["pulling manifest", "Error: model requires ollama version v0.40.4 or newer"]


def test_multi_line_redraws_log_each_bar_once(said):
    """Several bars redrawn together each frame (cursor up, then every bar again)."""
    frames = [("10%", "0%"), ("60%", "30%"), ("100%", "100%")]
    frame = "\\x1b[2A\\x1b[1Gpulling aaa: {}\\x1b[K\\npulling bbb: {}\\x1b[K\\n"
    script = (
        "import sys\n"
        + "".join(f"sys.stdout.write('{frame.format(a, b)}')\n" for a, b in frames)
        + "print('verifying sha256 digest')\nprint('success')\n"
    )
    core.Ctx(stream=True).run([sys.executable, "-c", script], check=False)
    out = [msg for level, msg in said if level == "out"]
    assert out == [
        "pulling aaa: 100%",
        "pulling bbb: 100%",
        "verifying sha256 digest",
        "success",
    ]


def test_too_old_ollama_gets_a_hint(wsl, said, monkeypatch):
    def fake_run(self, cmd, **kw):
        core.SINK("out", "Error: model requires ollama version v0.40.4 or newer")
        return __import__("subprocess").CompletedProcess(cmd, 1)

    monkeypatch.setattr(core.Ctx, "run", fake_run)
    monkeypatch.setattr(models, "installed", lambda rt, spec: set())
    monkeypatch.setattr(models, "ollama_version", lambda: "0.40.2")
    assert not models.pull(core.Ctx(), "ollama", ["gpt-oss:20b"])
    assert any(level == "warn" and "too old" in msg for level, msg in said)


def test_installed_reads_the_ollama_api(monkeypatch):
    spec = {"models": [{"name": "gpt-oss:20b"}, {"name": "nimble"}, {"name": "qwen3.8:27b"}]}
    monkeypatch.setattr(
        models,
        "_api",
        lambda path: {"models": [{"name": "gpt-oss:20b"}, {"name": "nimble:latest"}]},
    )
    assert models.installed("ollama", spec) == {"gpt-oss:20b", "nimble"}
    monkeypatch.setattr(models, "_api", lambda path: None)  # server not running
    assert models.installed("ollama", spec) is None
