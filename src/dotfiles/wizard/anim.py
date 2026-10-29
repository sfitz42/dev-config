"""Animation frames. Pure functions of a frame counter, so they can be tested without a terminal.

Scenes are SCENE_HEIGHT lines of Rich markup. Pages drive them from a timer (about 8 fps) and
skip them all in calm mode (--calm, CONJURE_CALM=1 or TERM=dumb).
"""

from __future__ import annotations

import os

from rich.markup import escape
from rich.text import Text

GOLD, VIOLET, GREEN, RED, MUTED, DIM = (
    "#f2c14e",
    "#9d7cff",
    "#7ee0a1",
    "#ff6b8b",
    "#a99fc8",
    "#5f5680",
)
SPARKS = "✦✧✶✷✸✹✷✶✧"
SCENE_HEIGHT = 5
FINALE_FRAMES = 18  # bursts, smoke and dissolves are over after this many frames


def block(lines: list[str]) -> Text:
    """Markup lines as one block, each padded to the widest, so centring keeps the art aligned."""
    texts = [Text.from_markup(line) for line in lines]
    width = max((t.cell_len for t in texts), default=0)
    out = Text()
    for i, t in enumerate(texts):
        t.pad_right(width - t.cell_len)
        out.append_text(t)
        if i < len(texts) - 1:
            out.append("\n")
    return out


def calm_from_env() -> bool:
    return bool(os.environ.get("CONJURE_CALM")) or os.environ.get("TERM") == "dumb"


def twinkle(markup: str, frame: int) -> str:
    """Swap each ✦ for a sparkle further along the cycle, staggered so they don't pulse together."""
    out, i = [], 0
    for ch in markup:
        if ch == "✦":
            out.append(SPARKS[(frame + 4 * i) % len(SPARKS)])
            i += 1
        else:
            out.append(ch)
    return "".join(out)


def typed_title(title: str, shown: int | None) -> str:
    """The title written out to `shown` characters, with the wand at the pen's position."""
    if shown is None or shown >= len(title):
        return title
    return title[:shown] + "🪄" + " " * (len(title) - shown)


def ball(frame: int) -> list[str]:
    """A crystal ball whose mist swirls round."""
    mist = ["◐", "◓", "◑", "◒"]
    m = mist[frame % 4]
    s1, s2 = SPARKS[frame % len(SPARKS)], SPARKS[(frame + 4) % len(SPARKS)]
    inner = [f" {m}  {s1} ", f" {s2}  {m} "] if frame % 2 else [f" {s1} {m}  ", f"  {m} {s2} "]
    return [
        f"[{VIOLET}]╭──────╮[/]",
        f"[{VIOLET}]│[/][{GOLD}]{inner[0]}[/][{VIOLET}]│[/]",
        f"[{VIOLET}]│[/][{GOLD}]{inner[1]}[/][{VIOLET}]│[/]",
        f"[{VIOLET}]╰──────╯[/]",
        f"[{MUTED}] ▔▔▔▔▔▔[/]",
    ]


# ---- casting stages -------------------------------------------------------------------------


def stage_of(step: str, current: str = "") -> str:
    """Which scene a `core.step` heading belongs to. Once the doctor starts, it keeps the stage
    (its own headings, "links" and "packages", would otherwise pick other scenes)."""
    if current == "doctor":
        return "doctor"
    table = [
        ("doctor", "doctor"),
        ("update repo", "pull"),
        ("packages", "packages"),
        ("external repos", "repos"),
        ("link:", "link"),
        ("agent:", "agents"),
        ("models", "models"),
        ("devbox", "devbox"),
        ("remove links", "banish"),
        ("restore", "banish"),
    ]
    for prefix, stage in table:
        if step.startswith(prefix):
            return stage
    return "sparkle"


def _pad(lines: list[str]) -> list[str]:
    return (lines + [""] * SCENE_HEIGHT)[:SCENE_HEIGHT]


def packages_scene(f: int) -> list[str]:
    """A cauldron bubbling while boxes drop in."""
    drop = f % 6
    box = "   📦"
    bubbles = ["  °  o  ° ", " o  °  o  ", "°  o   °  "][f % 3]
    ripple = ("~≈" * 8)[f % 2 : f % 2 + 10]
    flames = ["^ ^ ^ ^", " ^ ^ ^ "][f % 2]
    return [
        box if drop == 0 else "",
        box if drop == 1 else f"[{GREEN}]{bubbles}[/]",
        f"[{VIOLET}]╲[/][{GREEN}]{ripple}[/][{VIOLET}]╱[/]",
        f"[{VIOLET}] ╲________╱ [/]",
        f"[{GOLD if f % 2 else RED}]  {flames}  [/]",
    ]


def repos_scene(f: int) -> list[str]:
    """A git branch growing node by node, forking halfway."""
    n = f % 9 + 1
    main = min(n, 6)
    trunk = "─".join(["●"] * main) + ("─◌" if main < 6 else "─✦")
    fork = ""
    if n > 3:
        k = min(n - 3, 4)
        fork = "      ╰─" + "─".join(["●"] * k)
    return ["", f"[{VIOLET}]{trunk}[/]", f"[{GOLD}]{fork}[/]", "", ""]


def link_scene(f: int) -> list[str]:
    """A chain being forged from the repo to your home directory."""
    k = f % 8
    chain = "─o" * k + "  " * (7 - k)
    end = f"[{GREEN}]⇢ ~[/]" if k == 7 else f"[{DIM}]⇢ ~[/]"
    return ["", "", f"[{VIOLET}]repo[/] [{GOLD}]{chain}[/] {end}", "", ""]


def agents_scene(f: int) -> list[str]:
    """A little robot booting up (and blinking)."""
    eyes = "- -" if f % 12 in (0, 1) else "◕ ◕"
    boot = "▮" * (f % 6) + "▯" * (5 - f % 6)
    return [
        f"[{VIOLET}]┌─────┐[/]",
        f"[{VIOLET}]│[/] [{GOLD}]{eyes}[/] [{VIOLET}]│[/]",
        f"[{VIOLET}]│[/]  ‿  [{VIOLET}]│[/]",
        f"[{VIOLET}]└─┬─┬─┘[/]",
        f"[{MUTED}]booting[/] [{GREEN}]{boot}[/]",
    ]


def models_scene(f: int) -> list[str]:
    """Weights raining into a neural net whose layers light up in turn, out to a spark."""
    lit = (f // 2) % 4  # layer 0, 1, 2, then the output spark
    layers = [{1, 2, 3}, {0, 1, 2, 3, 4}, {1, 2, 3}]
    rows = []
    for r in range(SCENE_HEIGHT):
        rain = "".join(
            "01"[(f + r * 3 + c) % 2] if (f + r + c * 2) % 4 == 0 else " " for c in range(5)
        )
        has = [r in rows_with_node for rows_with_node in layers]
        cells = [
            (f"[{GOLD}]●[/]" if lit == i else f"[{VIOLET}]○[/]") if has[i] else " "
            for i in range(len(layers))
        ]
        # a wire only where there's a node at both ends
        wire = [" ── " if has[i] and has[i + 1] else "    " for i in range(len(layers) - 1)]
        out = (f" ─ [{GOLD}]✦[/]" if lit == 3 else " ─ ·") if r == 2 else ""
        net = f"{cells[0]}{wire[0]}{cells[1]}{wire[1]}{cells[2]}{out}"
        rows.append(f"[{DIM}]{rain}[/]  {net}")
    return rows


def devbox_scene(f: int) -> list[str]:
    """Container blocks stacking up."""
    height = (f // 3) % 4
    falling = f % 3
    rows = [""] * SCENE_HEIGHT
    for level in range(height):
        rows[SCENE_HEIGHT - 1 - level] = f"[{VIOLET if level % 2 else GOLD}]▣▣▣▣[/]"
    top = SCENE_HEIGHT - 1 - height
    if falling < top:
        rows[falling] = f"[{GREEN}] ▣▣ [/]"
    return rows


def pull_scene(f: int) -> list[str]:
    """A scroll unrolling."""
    w = f % 14 + 1
    words = ("~ " * 10)[:w]
    return [
        "",
        f"[{GOLD}]📜[/][{VIOLET}]╭{'─' * w}╮[/]",
        f"  [{VIOLET}]│[/][{MUTED}]{words}[/][{VIOLET}]│[/]",
        f"  [{VIOLET}]╰{'─' * w}╯[/]",
        "",
    ]


ECG = "──────╱╲╱──╲╱───────────"


def doctor_scene(f: int) -> list[str]:
    """A heartbeat line scrolling past."""
    i = f % len(ECG)
    line = (ECG[i:] + ECG[:i]) * 2
    heart = "♥" if f % 4 < 2 else "♡"
    return ["", "", f"[{RED}]{heart}[/] [{GREEN}]{line[:30]}[/]", "", ""]


def banish_scene(f: int) -> list[str]:
    """A broom sweeping dust along."""
    x = f % 22
    dust = "·∴·:·∴"
    line = " " * x + "🧹" + f"[{MUTED}]{dust[: max(0, 22 - x)]}[/]"
    return ["", "", line, f"[{DIM}]{'▔' * 30}[/]", ""]


def sparkle_scene(f: int) -> list[str]:
    """For steps without a scene of their own."""
    row = "  ".join(SPARKS[(f + i * 2) % len(SPARKS)] for i in range(7))
    return ["", "", f"[{GOLD}]{row}[/]", "", ""]


SCENES = {
    "packages": packages_scene,
    "repos": repos_scene,
    "link": link_scene,
    "agents": agents_scene,
    "models": models_scene,
    "devbox": devbox_scene,
    "pull": pull_scene,
    "doctor": doctor_scene,
    "banish": banish_scene,
    "sparkle": sparkle_scene,
}


def scene(stage: str, frame: int) -> list[str]:
    return _pad(SCENES.get(stage, sparkle_scene)(frame))


# ---- finales --------------------------------------------------------------------------------

WIDTH = 41  # finale grid width; the centre is column 20


def _grid() -> list[list[str]]:
    return [[" "] * WIDTH for _ in range(SCENE_HEIGHT)]


def _render(grid: list[list[str]], colour: str) -> list[str]:
    return [f"[{colour}]{''.join(row).rstrip()}[/]" if "".join(row).strip() else "" for row in grid]


def burst(f: int) -> list[str]:
    """Sparkles flying out from the centre and fading."""
    if f >= FINALE_FRAMES:
        return [""] * SCENE_HEIGHT
    grid = _grid()
    glyph = "✦✧⋆·"[min(f // 5, 3)]
    directions = [(-1, -2), (-1, 0), (-1, 2), (0, -3), (0, 3), (1, -2), (1, 0), (1, 2)]
    r = f / 3
    for dy, dx in directions:
        y, x = 2 + round(dy * min(r, 2)), 20 + round(dx * r * 2)
        if 0 <= y < SCENE_HEIGHT and 0 <= x < WIDTH:
            grid[y][x] = glyph
    if f < 4:
        grid[2][20] = "✺"
    return _render(grid, GOLD if f < 10 else MUTED)


def fizzle(f: int) -> list[str]:
    """A puff of smoke rising off a failed spell."""
    if f >= FINALE_FRAMES:
        return [""] * SCENE_HEIGHT
    grid = _grid()
    puff = "≈∽~·"[min(f // 5, 3)]
    y = SCENE_HEIGHT - 1 - f // 4
    for k, dx in enumerate((-2, 0, 2)):
        x = 20 + dx + (1 if (f + k) % 3 == 0 else 0)
        if 0 <= y < SCENE_HEIGHT:
            grid[y][x] = puff
    return _render(grid, MUTED if f < 10 else DIM)


def dissolve(lines: list[str], f: int) -> list[str]:
    """Lines crumbling to dust: characters turn to dots, then vanish."""
    if f >= FINALE_FRAMES:
        return [""] * SCENE_HEIGHT
    out = []
    for j, line in enumerate(lines[:SCENE_HEIGHT]):
        chars = []
        for i, ch in enumerate(line):
            t = (i * 7 + j * 3) % 10  # each character's own moment
            if f > t + 6:
                chars.append(" ")
            elif f > t:
                chars.append("·" if ch != " " else " ")
            else:
                chars.append(ch)
        text = "".join(chars).rstrip()
        out.append(f"[{MUTED}]{escape(text)}[/]" if text else "")
    return _pad(out)
