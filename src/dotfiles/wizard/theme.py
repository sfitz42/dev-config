"""The arcane look: palette, banner and stylesheet."""

from __future__ import annotations

from textual.theme import Theme

ARCANE = Theme(
    name="arcane",
    primary="#9d7cff",  # violet
    secondary="#5b3fa8",
    accent="#f2c14e",  # gold
    warning="#f2c14e",
    error="#ff6b8b",
    success="#7ee0a1",
    foreground="#ece6ff",
    background="#120d24",
    surface="#1b1433",
    panel="#261c47",
    dark=True,
)

GOLD, VIOLET, MUTED = "#f2c14e", "#9d7cff", "#a99fc8"

TITLE = "c o n j u r e"

# a backslash right before "[" escapes the tag in markup, so each "\" is followed by a space.
# {title} is filled in by banner(), so the wizard can write it out letter by letter.
BANNER_TEMPLATE = r"""[#f2c14e]        ✦[/]
[#9d7cff]       /\ [/]       [b #f2c14e]{title}[/]
[#9d7cff]      /  \ [/]      [#ece6ff]the dev-config installer[/]
[#9d7cff]     / [#f2c14e]✦[/]  \ [/]     [dim]packages · config · agents · extras[/]
[#9d7cff]    /______\ [/] [#f2c14e]🪄[/]"""


def banner(title: str = TITLE) -> str:
    return BANNER_TEMPLATE.replace("{title}", title)


BANNER = banner()

# the smaller hat at the top of the step rail
RAIL_HAT = r"""[#f2c14e]   ✦[/]
[#9d7cff]  /\ [/]  [b #f2c14e]conjure[/]
[#9d7cff] /[#f2c14e]✦[/] \ [/]
[#9d7cff]/____\ [/]"""

SPINNER = "✦✧✶✷✸✹✺✹✸✷✶✧"

# style per core.SINK level, for the casting log
LEVEL_STYLE = {
    "ok": "#7ee0a1",
    "warn": "#f2c14e",
    "err": "bold #ff6b8b",
    "step": "bold #9d7cff",
    "dry": "italic #a99fc8",
    "out": "#8a80a8",
    "info": "#ece6ff",
}
LEVEL_PREFIX = {"ok": "✓ ", "warn": "! ", "err": "✗ ", "step": "✦ ", "dry": "[dry-run] "}

CSS = """
Screen {
    background: $background;
    padding: 1 2;
}
#frame {
    height: 1fr;
}
#rail {
    width: 30;
    height: 100%;
    border: round $secondary;
    padding: 1 1;
    margin-right: 1;
}
#page {
    width: 1fr;
    height: 100%;
}
.title {
    text-style: bold;
    color: $accent;
}
.hint {
    color: $text-muted;
    margin-bottom: 1;
}
#body {
    height: 1fr;
}
#banner {
    height: auto;
    margin-bottom: 1;
}
#cards {
    height: auto;
    margin-bottom: 1;
}
.card {
    width: 1fr;
    height: auto;
    border: round $primary;
    padding: 0 1;
    margin-right: 1;
}
.text {
    margin-bottom: 1;
}
.nav {
    height: auto;
    dock: bottom;
    align-horizontal: right;
}
.nav Button {
    width: auto;
    min-width: 10;
    margin-left: 2;
}
RadioSet {
    width: 100%;
    margin-bottom: 1;
}
.describe {
    height: auto;
    border: round $secondary;
    border-title-color: $accent;
    padding: 0 1;
}
TabbedContent {
    height: 1fr;
}
SelectionList {
    height: 1fr;
    border: round $secondary;
}
#selected-count {
    height: 1;
    color: $text-muted;
}
.option {
    height: auto;
    margin-bottom: 1;
}
.option Switch {
    margin-right: 2;
}
.option Label {
    padding-top: 1;
}
#prefer {
    width: 40;
}
#tree, #vision {
    height: 1fr;
    border: round $primary;
    padding: 0 1;
}
#casting-status {
    height: auto;
    margin-bottom: 1;
}
#scene {
    height: 5;
    width: 100%;
    content-align: center middle;
    margin-bottom: 1;
}
#scene.calm {
    display: none;
}
#live {
    height: 1;
}
#ball {
    width: auto;
    height: 5;
    margin-right: 2;
}
#gazing {
    height: 5;
    content-align: left middle;
}
#gaze-row {
    height: auto;
}
#log {
    height: 1fr;
    border: round $secondary;
    background: $surface;
}
ProgressBar {
    margin-bottom: 1;
}
#summary {
    height: auto;
    border: round $accent;
    padding: 0 1;
    margin-bottom: 1;
}
ConfirmModal {
    align: center middle;
    background: $background 70%;
}
#dialog {
    width: 70;
    height: auto;
    border: thick $accent;
    background: $panel;
    padding: 1 2;
}
#dialog Horizontal {
    height: auto;
    margin-top: 1;
    align-horizontal: right;
}
#dialog Button {
    margin-left: 2;
}
"""
