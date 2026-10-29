import pytest
from rich.text import Text

from dotfiles.wizard import anim, theme, widgets


@pytest.mark.parametrize("stage", sorted(anim.SCENES))
def test_every_scene_renders_every_frame(stage):
    for f in range(60):
        lines = anim.scene(stage, f)
        assert len(lines) == anim.SCENE_HEIGHT
        assert isinstance(anim.block(lines), Text)  # valid markup


def test_scenes_move():
    for stage in anim.SCENES:
        frames = {tuple(anim.scene(stage, f)) for f in range(12)}
        assert len(frames) > 1, f"{stage} never changes"


def test_stage_of():
    assert anim.stage_of("packages") == "packages"
    assert anim.stage_of("link: zsh") == "link"
    assert anim.stage_of("agent: pi") == "agents"
    assert anim.stage_of("models: ollama") == "models"
    assert anim.stage_of("devbox build core") == "devbox"
    assert anim.stage_of("update repo") == "pull"
    assert anim.stage_of("remove links created by this tool") == "banish"
    assert anim.stage_of("something new") == "sparkle"
    # the doctor's own headings ("links", "packages") keep the doctor scene
    assert anim.stage_of("doctor: checking the result") == "doctor"
    assert anim.stage_of("packages", "doctor") == "doctor"


@pytest.mark.parametrize("finale", [anim.burst, anim.fizzle])
def test_finales_play_then_clear(finale):
    assert any(finale(0)) or any(finale(2))
    assert all(line == "" for line in finale(anim.FINALE_FRAMES))
    for f in range(anim.FINALE_FRAMES):
        anim.block(finale(f))


def test_dissolve_crumbles_and_escapes_markup():
    lines = ["~/.zshrc", "~/odd [dir]/file"]
    assert "~/.zshrc" in anim.block(anim.dissolve(lines, 0)).plain
    assert "[dir]" in anim.block(anim.dissolve(lines, 0)).plain  # not eaten as a markup tag
    middle = anim.block(anim.dissolve(lines, 8)).plain
    assert "·" in middle
    assert anim.block(anim.dissolve(lines, anim.FINALE_FRAMES)).plain.strip() == ""


def test_twinkle_and_typed_title():
    assert anim.twinkle("a ✦ b ✦", 0) != anim.twinkle("a ✦ b ✦", 1)
    assert anim.twinkle("no sparkles", 5) == "no sparkles"
    assert anim.typed_title("abc", 1) == "a🪄  "
    assert anim.typed_title("abc", None) == "abc"
    assert "c o n j u r e" in theme.banner()


def test_calm_from_env(monkeypatch):
    monkeypatch.delenv("CONJURE_CALM", raising=False)
    monkeypatch.setenv("TERM", "xterm-256color")
    assert not anim.calm_from_env()
    monkeypatch.setenv("CONJURE_CALM", "1")
    assert anim.calm_from_env()
    monkeypatch.delenv("CONJURE_CALM")
    monkeypatch.setenv("TERM", "dumb")
    assert anim.calm_from_env()


def test_rail_trail_and_pop():
    steps = [("a", "Alpha"), ("b", "Beta"), ("c", "Gamma")]
    plain = widgets.rail(steps, "c", "here").plain
    assert "✓ Alpha" in plain and "✦ Gamma" in plain and "step 3 of 3" in plain
    assert "✧ Beta" in widgets.rail(steps, "c", "here", trail=1).plain
    popped = widgets.rail(steps, "c", "here", popped=1)
    assert any("bold" in str(span.style) for span in popped.spans)
