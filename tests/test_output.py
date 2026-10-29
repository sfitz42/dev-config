import sys

from dotfiles import core


def test_sink_receives_every_level(monkeypatch):
    seen = []
    monkeypatch.setattr(core, "SINK", lambda level, msg: seen.append((level, msg)))
    core.info("i")
    core.ok("o")
    core.warn("w")
    core.err("e")
    core.step("s")
    core.Ctx(dry_run=True).say("d")
    core.Ctx().say("plain")
    assert seen == [
        ("info", "i"),
        ("ok", "o"),
        ("warn", "w"),
        ("err", "e"),
        ("step", "s"),
        ("dry", "d"),
        ("info", "plain"),
    ]


def test_default_sink_prints_like_before(capsys):
    core.ok("fine")
    core.warn("careful")
    core.Ctx(dry_run=True).say("echo hi")
    out, err = capsys.readouterr()
    assert "✓ fine" in out and "[dry-run] echo hi" in out
    assert "! careful" in err


def test_streamed_run_sends_lines_and_keeps_returncode(monkeypatch):
    seen = []
    monkeypatch.setattr(core, "SINK", lambda level, msg: seen.append((level, msg)))
    cmd = [sys.executable, "-c", "import sys; print('one'); print('two', file=sys.stderr); exit(3)"]
    cp = core.Ctx(stream=True).run(cmd, check=False)
    assert cp is not None and cp.returncode == 3
    assert ("out", "one") in seen and ("out", "two") in seen


def test_ask_answers_confirm():
    questions = []

    def ask(q):
        questions.append(q)
        return True

    assert core.Ctx(ask=ask).confirm("go?")
    assert questions == ["go?"]
    # --yes still wins without asking
    assert core.Ctx(yes=True, ask=lambda q: False).confirm("go?")
