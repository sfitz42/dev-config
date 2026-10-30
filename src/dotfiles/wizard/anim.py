"""Animation frames. Pure functions of a frame counter, so they can be tested without a terminal.

Scenes are SCENE_HEIGHT lines of Rich markup. Pages drive them from a timer (about 8 fps) and
skip them all in calm mode (--calm, DEVCONFIG_CALM=1 or TERM=dumb).
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
SHADES = "░▒▓█▓▒"  # a CRT phosphor flicker, one step per frame
SCENE_HEIGHT = 5
FINALE_FRAMES = 24  # wand waves, error boxes and dissolves are over after this many frames


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
    return bool(os.environ.get("DEVCONFIG_CALM")) or os.environ.get("TERM") == "dumb"


def flicker(markup: str, frame: int) -> str:
    """Swap each ▒ for a shade further along the cycle, staggered so the screen shimmers rather
    than blinks."""
    out, i = [], 0
    for ch in markup:
        if ch == "▒":
            out.append(SHADES[(frame + 3 * i) % len(SHADES)])
            i += 1
        else:
            out.append(ch)
    return "".join(out)


def typed_title(title: str, shown: int | None) -> str:
    """The title typed out to `shown` characters, with the cursor at the end."""
    if shown is None or shown >= len(title):
        return title
    return title[:shown] + "▌" + " " * (len(title) - shown - 1)


def connecting(frame: int) -> list[str]:
    """Your computer dialling the update server: packets hopping along to a globe."""
    k = frame % 5
    wire = "".join(f"[{GOLD}]●[/]" if i == k else f"[{DIM}]·[/]" for i in range(5))
    return [
        f"[{VIOLET}]┌────┐[/]",
        f"[{VIOLET}]│[/][{GOLD}]{SHADES[frame % len(SHADES)] * 4}[/][{VIOLET}]│[/] {wire} 🌐",
        f"[{VIOLET}]└─┬┬─┘[/]",
        f"[{MUTED}] ▔▔▔▔[/]",
        "",
    ]


# ---- installing stages ----------------------------------------------------------------------


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
        ("remove links", "remove"),
        ("restore", "remove"),
    ]
    for prefix, stage in table:
        if step.startswith(prefix):
            return stage
    return "idle"


def _cells(width: int, fill: str = " ") -> list[str]:
    return [fill] * width


def _put(row: list[str], x: int, glyph: str, wide: bool = True) -> None:
    """Put glyph at column x; a wide one swallows the cell after it."""
    if 0 <= x < len(row):
        row[x] = glyph
        if wide and x + 1 < len(row):
            row[x + 1] = ""


def _pad(lines: list[str]) -> list[str]:
    return (lines + [""] * SCENE_HEIGHT)[:SCENE_HEIGHT]


def packages_scene(f: int) -> list[str]:
    """A page flying from one folder to the other, forever. The classic. Every fourth one
    misses and lands on the floor; nobody goes to pick it up."""
    k, trip = f % 8, f // 8
    x, y = 2 + k * 2, [2, 1, 0, 0, 0, 0, 1, 2][k]
    if trip % 4 == 3 and k >= 4:
        x, y = 10, k - 3  # down it goes
    rows = [_cells(20) for _ in range(3)] + [_cells(20), _cells(20, "▔")]
    _put(rows[3], 0, "📁")
    _put(rows[3], 18, "📂")
    _put(rows[y], x, "📄")
    out = ["".join(r) for r in rows]
    out[3] = out[3].replace("📁", f"[{GOLD}]📁[/]").replace("📂", f"[{GOLD}]📂[/]")
    out[4] = f"[{DIM}]{out[4]}[/]".replace("📄", "[/]📄[" + DIM + "]")
    return out


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
    """A little robot booting up (and blinking), then offering to help whether you like it or
    not."""
    eyes = "- -" if f % 12 in (0, 1) else "◕ ◕"
    booted = f % 24 >= 6
    boot = "▮" * min(f % 24, 5) + "▯" * (5 - min(f % 24, 5))
    bubble = "< It looks like you're installing an agent!"
    say = f"[{MUTED}]{bubble}[/]" if booted else " " * len(bubble)  # same width: no jumping
    return [
        f"[{VIOLET}]┌─────┐[/]",
        f"[{VIOLET}]│[/] [{GOLD}]{eyes}[/] [{VIOLET}]│[/]  {say}",
        f"[{VIOLET}]│[/]  {'◡' if booted else '‿'}  [{VIOLET}]│[/]",
        f"[{VIOLET}]└─┬─┬─┘[/]",
        f"[{MUTED}]booting[/] [{GREEN}]{boot}[/]",
    ]


TOKENS = [
    "Sure! Great question.",
    "You're absolutely right!",
    "As a large language model",
    "Let me think step by step",
    "Hello, world.",
    "I'd be happy to help!",
]
TOKEN_WIDTH = max(len(t) for t in TOKENS) + 1


def models_scene(f: int) -> list[str]:
    """Weights raining down into a neural net whose layers light up in turn, until the output
    spark starts talking. It says what they all say."""
    lit = (f // 2) % 4  # layer 0, 1, 2, then the output spark
    layers = [{1, 2, 3}, {0, 1, 2, 3, 4}, {1, 2, 3}]
    said = TOKENS[(f // 30) % len(TOKENS)]
    shown = said[: max(0, f % 30 - 3)]  # a beat of thinking, then it types
    cursor = "▌" if f % 30 < 27 else " "
    rows = []
    for r in range(SCENE_HEIGHT):
        rain = "".join(
            f"[{GOLD if (f + c) % 7 == 0 else DIM}]{'01'[(f + r + c) % 2]}[/]"
            if (r - f + c * 3) % 4 == 0
            else " "
            for c in range(6)
        )
        has = [r in rows_with_node for rows_with_node in layers]
        cells = [
            (f"[{GOLD}]●[/]" if lit == i else f"[{VIOLET}]○[/]") if has[i] else " "
            for i in range(len(layers))
        ]
        # a wire only where there's a node at both ends
        wire = [" ── " if has[i] and has[i + 1] else "    " for i in range(len(layers) - 1)]
        net = f"{cells[0]}{wire[0]}{cells[1]}{wire[1]}{cells[2]}"
        out = " " * (5 + TOKEN_WIDTH)
        if r == 2:
            spark = f"[{GOLD}]✦[/]" if lit == 3 else "·"
            words = escape((shown + cursor).ljust(TOKEN_WIDTH))
            out = f" ─ {spark} [{GREEN}]{words}[/]"
        rows.append(f"{rain} {net}{out}")
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
    """Downloading the update onto a floppy, one block at a time. It never fits on one disk."""
    k = f % 20
    w = min(k, 10)
    bar = f"[{GREEN}]{'█' * w}[/][{DIM}]{'░' * (10 - w)}[/]"
    disk = (f // 20) % 3 + 2  # 2, 3, then 4 of 3
    ask = f"[{GOLD}]Please insert Disk {disk} of 3[/]" if k > 10 else " " * 25
    return [
        "",
        f"🌐 [{VIOLET}]───▶[/] 💾",
        f"[{VIOLET}][[/]{bar}[{VIOLET}]][/] [{MUTED}]{w * 10:>3}%[/]",
        ask,
        "",
    ]


ECG = "──────╱╲╱──╲╱───────────"


def doctor_scene(f: int) -> list[str]:
    """A heartbeat line scrolling past."""
    i = f % len(ECG)
    line = (ECG[i:] + ECG[:i]) * 2
    heart = "♥" if f % 4 < 2 else "♡"
    return ["", "", f"[{RED}]{heart}[/] [{GREEN}]{line[:30]}[/]", "", ""]


def remove_scene(f: int) -> list[str]:
    """Files dropping into the Recycle Bin, which keeps count."""
    y = f % 4
    rows = [""] * SCENE_HEIGHT
    if y < 3:
        rows[y] = "  📄"
    rows[3] = "  🗑" + (f"[{MUTED}] ·[/]" if y == 3 else "")
    rows[4] = f"[{MUTED}]Recycle Bin ({f // 4 + 1:>3})[/]"
    return rows


def idle_scene(f: int) -> list[str]:
    """For steps without a scene of their own: the hourglass, turning. Now and then it stops
    responding, then thinks better of it."""
    glass = "⏳" if (f // 4) % 2 else "⌛"
    if f % 50 >= 42:
        return ["", "", f"{glass} [{MUTED}]Please wait   [/][{RED}](Not Responding)[/]", "", ""]
    dots = "." * (f % 4)
    return ["", "", f"{glass} [{MUTED}]Please wait{dots:<3}[/]{' ' * 16}", "", ""]


SCENES = {
    "packages": packages_scene,
    "repos": repos_scene,
    "link": link_scene,
    "agents": agents_scene,
    "models": models_scene,
    "devbox": devbox_scene,
    "pull": pull_scene,
    "doctor": doctor_scene,
    "remove": remove_scene,
    "idle": idle_scene,
}


def scene(stage: str, frame: int) -> list[str]:
    return _pad(SCENES.get(stage, idle_scene)(frame))


# ---- quips: the line under the scene -------------------------------------------------------

QUIPS = {
    "packages": [
        "Asking Homebrew nicely",
        "Untangling dependency hell",
        "Downloading more RAM",
        "Reticulating splines",
        "Convincing apt it isn't 2004 any more",
        "One of the files fell down the back of the sofa",
    ],
    "repos": [
        "Cloning repositories, and their opinions",
        "Resolving merge conflicts you haven't had yet",
    ],
    "link": [
        "Backing up your dotfiles (you're welcome)",
        "Symlinking things that were fine before",
        "Pointing ~ at things",
    ],
    "agents": [
        "Teaching the robots some manners",
        "Agreeing to terms and conditions on your behalf",
        "📎 Would you like help with that?",
    ],
    "models": [
        "Downloading several gigabytes of opinions",
        "Quantising: rounding off the weights, and expectations",
        "Your fans are about to meet each other",
        "Teaching sand to think",
    ],
    "devbox": [
        "Putting containers inside containers",
        "It works on my machine, which is now your machine",
    ],
    "pull": [
        "Please do not unplug your modem",
        "Downloading the internet (abridged)",
    ],
    "doctor": [
        "Dr. Watson is examining your system",
        "Have you tried turning it off and on again?",
    ],
    "remove": [
        "Putting everything back exactly as we found it",
        "Are you sure? Too late",
    ],
    "idle": [
        "Applying the finishing touches",
        "Polishing the progress bar",
        "Moving the progress bar back a bit, for realism",
    ],
}

# the estimate, as accurate as it ever was
ESTIMATES = [
    "calculating…",
    "about 4 minutes",
    "about 2 hours",
    "12 seconds",
    "about 3 days",
    "about 1 minute",
    "about 47 minutes",
    "2 seconds",
    "about a fortnight",
]
QUIP_FRAMES = 30  # a new quip about every three seconds; the estimate changes twice as often


def quip(stage: str, frame: int) -> str:
    lines = QUIPS.get(stage) or QUIPS["idle"]
    return lines[(frame // QUIP_FRAMES) % len(lines)] + "…"


def time_remaining(frame: int) -> str:
    return ESTIMATES[(frame // (QUIP_FRAMES // 2)) % len(ESTIMATES)]


# ---- finales --------------------------------------------------------------------------------

WIDTH = 41  # finale grid width; the centre is column 20


def _grid() -> list[list[str]]:
    return [[" "] * WIDTH for _ in range(SCENE_HEIGHT)]


def _render(grid: list[list[str]], colour: str) -> list[str]:
    """Rows kept full width, so the centred block doesn't drift sideways as things move."""
    return [f"[{colour}]{''.join(row)}[/]" if "".join(row).strip() else "" for row in grid]


# the wand swinging on its handle at (4, 12): back, up, then forward. Each pose is its shaft
# cells (row, column, glyph) and where the star on its tip goes
WAND_POSES = [
    ([(4, 12, "╲"), (3, 11, "╲"), (2, 10, "╲")], (1, 9)),
    ([(4, 12, "│"), (3, 12, "│"), (2, 12, "│")], (1, 12)),
    ([(4, 12, "╱"), (3, 13, "╱"), (2, 14, "╱")], (1, 15)),
]
WAVE_FRAMES = 2 * len(WAND_POSES)  # two frames a pose
BOLT = [(1, 17), (2, 19)]  # the spark flying off the tip to the middle, where it goes off


def burst(f: int) -> list[str]:
    """A wave of the wand, a spark flying off it, and ticks bursting out where it lands and
    fading: the closest Setup gets to a party."""
    if f >= FINALE_FRAMES:
        return [""] * SCENE_HEIGHT
    grid = _grid()
    pose = min(f // 2, len(WAND_POSES) - 1)
    if f < FINALE_FRAMES - 8:  # the wand hangs about for the start of the burst, then goes
        shaft, (ty, tx) = WAND_POSES[pose]
        wood = VIOLET if f < WAVE_FRAMES + 4 else DIM
        for y, x, glyph in shaft:
            grid[y][x] = f"[{wood}]{glyph}[/]"
        if f < WAVE_FRAMES + len(BOLT):
            grid[ty][tx] = "✦✧"[f % 2]
        for back, glyph in ((1, "*"), (2, "·")):  # the trail where the tip has just been
            if 0 <= pose - back and f < WAVE_FRAMES:
                y, x = WAND_POSES[pose - back][1]
                grid[y][x] = glyph
    b = f - WAVE_FRAMES - len(BOLT)  # frames since the spark landed
    if 0 <= f - WAVE_FRAMES < len(BOLT):
        y, x = BOLT[f - WAVE_FRAMES]
        grid[y][x] = "✸"
    elif b >= 0:
        glyph = "✓•∙·"[min(b // 4, 3)]
        directions = [(-1, -2), (-1, 0), (-1, 2), (0, -3), (0, 3), (1, -2), (1, 0), (1, 2)]
        r = b / 3 + 0.4
        for dy, dx in directions:
            y, x = 2 + round(dy * min(r, 2)), 20 + round(dx * r * 2)
            if 0 <= y < SCENE_HEIGHT and 0 <= x < WIDTH and grid[y][x] == " ":
                grid[y][x] = glyph
    return _render(grid, GOLD if b < 8 else MUTED)


ERROR_BOX = [
    "┌─ dev-config Setup ─────────────┐",
    "│ ⚠  Setup encountered a problem │",
    "│    and needs to close.         │",
    "│                       [  OK  ] │",
    "└────────────────────────────────┘",
]


def error_box(f: int) -> list[str]:
    """The error dialog, shaking for a moment, then dismissing itself. Nobody reads them anyway."""
    if f >= FINALE_FRAMES:
        return [""] * SCENE_HEIGHT
    shift = " " if f < 6 and f % 2 else ""
    colour = RED if f < 12 else DIM
    return [f"[{colour}]{shift}{escape(line)}[/]" for line in ERROR_BOX]


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
