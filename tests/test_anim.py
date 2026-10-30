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
    assert anim.stage_of("remove links created by this tool") == "remove"
    assert anim.stage_of("something new") == "idle"
    # the doctor's own headings ("links", "packages") keep the doctor scene
    assert anim.stage_of("doctor: checking the result") == "doctor"
    assert anim.stage_of("packages", "doctor") == "doctor"


@pytest.mark.parametrize("finale", [anim.burst, anim.error_box])
def test_finales_play_then_clear(finale):
    assert any(finale(0)) or any(finale(2))
    assert all(line == "" for line in finale(anim.FINALE_FRAMES))
    for f in range(anim.FINALE_FRAMES):
        anim.block(finale(f))


def test_burst_waves_the_wand_then_bursts():
    poses = [anim.block(anim.burst(f)).plain for f in range(0, anim.WAVE_FRAMES, 2)]
    assert "╲" in poses[0] and "│" in poses[1] and "╱" in poses[2]
    assert "✸" in anim.block(anim.burst(anim.WAVE_FRAMES)).plain  # the spark flies off
    assert "✓" in anim.block(anim.burst(anim.WAVE_FRAMES + len(anim.BOLT))).plain
    widths = {anim.block(anim.burst(f)).cell_len for f in range(anim.FINALE_FRAMES - 1)}
    assert len(widths) == 1  # stays put while it's centred


def test_dissolve_crumbles_and_escapes_markup():
    lines = ["~/.zshrc", "~/odd [dir]/file"]
    assert "~/.zshrc" in anim.block(anim.dissolve(lines, 0)).plain
    assert "[dir]" in anim.block(anim.dissolve(lines, 0)).plain  # not eaten as a markup tag
    middle = anim.block(anim.dissolve(lines, 8)).plain
    assert "·" in middle
    assert anim.block(anim.dissolve(lines, anim.FINALE_FRAMES)).plain.strip() == ""


def test_flicker_and_typed_title():
    assert anim.flicker("a ▒ b ▒", 0) != anim.flicker("a ▒ b ▒", 1)
    assert anim.flicker("no screen", 5) == "no screen"
    assert anim.typed_title("abc", 1) == "a▌ "
    assert anim.typed_title("abc", None) == "abc"
    assert "dev-config Setup" in theme.banner()


def test_connecting_and_error_box_render():
    frames = {tuple(anim.connecting(f)) for f in range(10)}
    assert len(frames) > 1
    for f in range(10):
        anim.block(anim.connecting(f))
    assert {len(line) for line in anim.ERROR_BOX} == {len(anim.ERROR_BOX[0])}


def test_every_stage_has_quips():
    assert set(anim.SCENES) <= set(anim.QUIPS)
    assert anim.quip("something new", 0).endswith("…")  # falls back to the idle ones
    estimates = {anim.time_remaining(f) for f in range(200)}
    assert len(estimates) > 3  # as reliable as it ever was


def test_calm_from_env(monkeypatch):
    monkeypatch.delenv("DEVCONFIG_CALM", raising=False)
    monkeypatch.setenv("TERM", "xterm-256color")
    assert not anim.calm_from_env()
    monkeypatch.setenv("DEVCONFIG_CALM", "1")
    assert anim.calm_from_env()
    monkeypatch.delenv("DEVCONFIG_CALM")
    monkeypatch.setenv("TERM", "dumb")
    assert anim.calm_from_env()


def test_rail_trail_and_pop():
    steps = [("a", "Alpha"), ("b", "Beta"), ("c", "Gamma")]
    plain = widgets.rail(steps, "c", "here").plain
    assert "✓ Alpha" in plain and "▸ Gamma" in plain and "step 3 of 3" in plain
    assert "› Beta" in widgets.rail(steps, "c", "here", trail=1).plain
    popped = widgets.rail(steps, "c", "here", popped=1)
    assert any("bold" in str(span.style) for span in popped.spans)
