"""The step rail down the left of every page."""

from __future__ import annotations

from rich.text import Text

from dotfiles.wizard import anim, theme


def rail(
    steps: list[tuple[str, str]],
    current: str,
    footer: str,
    frame: int | None = None,
    trail: int | None = None,
    popped: int | None = None,
) -> Text:
    """The monitor, then each step as done (✓), current (▸) or still to come (·).

    frame flickers the monitor; trail is the row the cursor is passing on its way down to the
    current step; popped is a step just completed, whose ✓ shows bright for a moment."""
    monitor = theme.RAIL_HAT if frame is None else anim.flicker(theme.RAIL_HAT, frame)
    out = Text.from_markup(monitor)
    out.append("\n\n")
    keys = [k for k, _ in steps]
    here = keys.index(current) if current in keys else 0
    for i, (_, label) in enumerate(steps):
        if trail is not None and i == trail and i != here:
            out.append(f" › {label}\n", style=f"bold {theme.GOLD}")
        elif i < here:
            style = f"bold {anim.GREEN}" if i == popped else theme.MUTED
            out.append(f" ✓ {label}\n", style=style)
        elif i == here:
            out.append(f"▌▸ {label}\n", style=f"bold {theme.GOLD}")
        else:
            out.append(f" · {label}\n", style="#5f5680")
    out.append(f"\nstep {here + 1} of {len(steps)}\n", style="dim")
    out.append(f"\n{footer}", style="dim italic")
    return out
