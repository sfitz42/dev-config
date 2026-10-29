"""The wizard's pages. Each one sits beside a step rail and ends in ← Back / Next → / Cancel.

Welcome → Choose a path (first time) or Grimoire (installed before)
        → [Spellbook → Enchantments] or [Scrying]
        → Incantation (review) → Casting (run) → Complete
"""

from __future__ import annotations

import argparse
import dataclasses
import subprocess
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, cast

from rich.console import Group
from rich.table import Table
from rich.text import Text
from rich.tree import Tree
from textual import on, work
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.markup import escape
from textual.screen import ModalScreen, Screen
from textual.widgets import (
    Button,
    Input,
    Label,
    ProgressBar,
    RadioButton,
    RadioSet,
    RichLog,
    SelectionList,
    Static,
    Switch,
    TabbedContent,
    TabPane,
)
from textual.widgets.selection_list import Selection

from dotfiles import cli, core, install, models, packages, platform, state, update
from dotfiles.wizard import anim, model, theme, widgets

if TYPE_CHECKING:
    from dotfiles.wizard.app import ConjureApp

Job = Callable[[core.Ctx], dict[str, bool]]


@dataclasses.dataclass
class RunSettings:
    dry_run: bool = False
    yes: bool = False  # approve unpinned vendor scripts without asking
    sudo: bool = True  # allow dnf/apt/.pkg installs (asks for the password up front)


@dataclasses.dataclass
class Session:
    """What has been chosen so far, shared by every page."""

    plat: platform.Platform
    saved: dict[str, Any] | None  # state.load(): the last install, if any
    choices: list[model.Choice]
    checked: set[str]
    opts: packages.Opts
    settings: RunSettings = dataclasses.field(default_factory=RunSettings)
    mode: str = "install"  # install | modify | update | repair | remove
    custom: bool = False
    incoming: update.Incoming | None = None
    touched: list[str] = dataclasses.field(default_factory=list)

    @property
    def pulls(self) -> bool:
        return self.mode == "update" and self.incoming is not None and self.incoming.behind > 0

    @property
    def restarts(self) -> bool:
        """The update changes the installer itself, so conjure restarts on the new code."""
        return self.pulls and "installer" in self.touched


STEP_LABELS = {
    "welcome": "Welcome",
    "path": "Choose a path",
    "grimoire": "The Grimoire",
    "spellbook": "Spellbook",
    "enchant": "Enchantments",
    "scrying": "Scrying",
    "incantation": "Incantation",
    "casting": "Casting",
    "done": "Complete",
}


def steps(s: Session) -> list[tuple[str, str]]:
    """The steps for the path chosen so far (the rail redraws as choices change it)."""
    keys = ["welcome", "grimoire" if s.saved else "path"]
    if s.mode == "update":
        keys.append("scrying")
    elif s.mode in ("install", "modify") and (s.custom or s.mode == "modify"):
        keys += ["spellbook", "enchant"]
    keys += ["incantation", "casting", "done"]
    return [(k, STEP_LABELS[k]) for k in keys]


# ---- dialog ---------------------------------------------------------------------------------


class ConfirmModal(ModalScreen[bool]):
    BINDINGS = [("y", "answer(True)", "Yes"), ("n,escape", "answer(False)", "No")]

    def __init__(self, question: str, yes: str = "Yes", no: str = "No") -> None:
        super().__init__()
        self.question, self.yes_label, self.no_label = question, yes, no

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Static(f"🔮 {escape(self.question.strip())}")
            with Horizontal():
                yield Button(self.no_label, id="no")
                yield Button(self.yes_label, id="yes", variant="primary")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "yes")

    def action_answer(self, value: bool) -> None:
        self.dismiss(value)


# ---- the page frame -------------------------------------------------------------------------


class Page(Screen[None]):
    step = ""
    title_text = ""
    hint = ""

    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("ctrl+n", "next", "Next"),
        Binding("ctrl+c", "cancel", "Cancel", show=False),
    ]

    @property
    def session(self) -> Session:
        return cast("ConjureApp", self.app).session

    def next_text(self) -> str:
        return "Next →"

    def can_back(self) -> bool:
        return True

    def body(self) -> ComposeResult:
        yield from ()

    def compose(self) -> ComposeResult:
        with Horizontal(id="frame"):
            yield Static(id="rail")
            with Vertical(id="page"):
                if self.title_text:
                    yield Static(self.title_text, classes="title")
                    yield Static(self.hint, classes="hint")
                with Vertical(id="body"):
                    yield from self.body()
                with Horizontal(classes="nav"):
                    yield Button("← Back", id="back", disabled=not self.can_back())
                    yield Button("Cancel", id="cancel")
                    yield Button(self.next_text(), id="next", variant="primary")

    @property
    def calm(self) -> bool:
        return cast("ConjureApp", self.app).calm

    def _step_index(self) -> int:
        keys = [k for k, _ in steps(self.session)]
        return keys.index(self.step) if self.step in keys else 0

    def on_mount(self) -> None:
        self._frame = 0
        self._trail: int | None = None  # rail row the sparkle is passing
        self._popped: int | None = None  # step whose ✓ is showing bright
        self._pop_ticks = 0
        app = cast("ConjureApp", self.app)
        here = self._step_index()
        if not self.calm and app.last_step is not None and here > app.last_step:
            self._trail = app.last_step  # a sparkle runs down from the step we left
        app.last_step = here
        self.refresh_rail()
        self.query_one("#next", Button).focus()
        if not self.calm:
            self._ticker = self.set_interval(0.1, self._next_frame)

    def on_screen_suspend(self) -> None:
        if not self.calm:
            self._ticker.pause()

    def on_screen_resume(self) -> None:
        cast("ConjureApp", self.app).last_step = self._step_index()
        self.refresh_rail()
        if not self.calm:
            self._ticker.resume()

    def _next_frame(self) -> None:
        self._frame += 1
        if self._trail is not None:
            self._trail += 1
            if self._trail >= self._step_index():
                self._trail = None
                self._popped, self._pop_ticks = self._step_index() - 1, 6
        elif self._pop_ticks:
            self._pop_ticks -= 1
            if not self._pop_ticks:
                self._popped = None
        self.refresh_rail()
        self.animate_frame(self._frame)

    def animate_frame(self, frame: int) -> None:
        """Called about ten times a second (never in calm mode), for page-specific animation."""

    def refresh_rail(self) -> None:
        footer = self.session.plat.label
        frame = None if self.calm else getattr(self, "_frame", 0) // 3  # twinkle slowly
        rail = widgets.rail(
            steps(self.session),
            self.step,
            footer,
            frame=frame,
            trail=getattr(self, "_trail", None),
            popped=getattr(self, "_popped", None),
        )
        self.query_one("#rail", Static).update(rail)

    @on(Button.Pressed, "#back")
    def _back_pressed(self) -> None:
        self.action_back()

    @on(Button.Pressed, "#next")
    def _next_pressed(self) -> None:
        self.action_next()

    @on(Button.Pressed, "#cancel")
    def _cancel_pressed(self) -> None:
        self.action_cancel()

    def action_back(self) -> None:
        if not self.query_one("#back", Button).disabled:
            self.app.pop_screen()

    def action_next(self) -> None:
        if not self.query_one("#next", Button).disabled:
            self.go_next()

    def go_next(self) -> None:
        pass

    def action_cancel(self) -> None:
        if self.query_one("#cancel", Button).disabled:
            return

        def answered(leave: bool | None) -> None:
            if leave:
                self.app.exit()

        self.app.push_screen(
            ConfirmModal("Leave conjure? Nothing more will be changed.", yes="Leave", no="Stay"),
            answered,
        )


# ---- welcome --------------------------------------------------------------------------------


def platform_card(plat: platform.Platform, choices: list[model.Choice] | None = None) -> Table:
    t = Table.grid(padding=(0, 2))
    t.add_column(style=theme.MUTED)
    t.add_column()
    t.add_row(f"[b {theme.GOLD}]🔮 Your realm[/]", "")
    t.add_row("system", plat.label)
    t.add_row("arch", plat.arch)
    t.add_row("packages from", plat.pkg_manager or ("Homebrew" if plat.brew else "—"))
    if plat.os == "macos":
        t.add_row("Homebrew", "yes" if plat.brew else "not installed")
    t.add_row("containers", plat.container_runtime or "none found")
    ollama = {"windows": "on Windows", "native": "installed"}.get(plat.ollama or "", "—")
    version = models.ollama_version() if plat.ollama else None
    if version:
        ollama += f" · v{version}"
    elif plat.ollama:
        ollama += " · [dim]not running[/]"
    if plat.wsl_ollama:
        ollama += f" [{theme.GOLD}]! also inside WSL[/]"
    t.add_row("ollama", ollama)
    if choices is not None:
        t.add_row("models", models_row(choices))
    return t


def models_row(choices: list[model.Choice]) -> str:
    """'2 of 3 pulled' per runtime that is usable here, for the welcome card."""
    parts = []
    for rt, label in model.RUNTIME_LABEL.items():
        mine = [c for c in choices if c.value.startswith(f"model:{rt}:") and c.available]
        if not mine:
            continue
        if any(c.note.startswith("status unknown") for c in mine):
            parts.append(f"{label}: [dim]not running[/]")
        else:
            pulled = sum(c.note == "pulled" for c in mine)
            colour = "#7ee0a1" if pulled == len(mine) else theme.GOLD
            parts.append(f"{label}: [{colour}]{pulled} of {len(mine)} pulled[/]")
    return " · ".join(parts) or "—"


def status_card(saved: dict[str, Any] | None, inc: update.Incoming | None) -> Table:
    t = Table.grid(padding=(0, 2))
    t.add_column(style=theme.MUTED)
    t.add_column()
    t.add_row(f"[b {theme.GOLD}]📜 Grimoire[/]", "")
    if saved:
        commit = (saved.get("commit") or "?")[:7]
        t.add_row("last cast", f"{commit} · {saved.get('updated_at', '?')[:16].replace('T', ' ')}")
    else:
        t.add_row("last cast", "never on this machine")
    t.add_row("repo at", state.git("rev-parse", "--short", "HEAD") or "?")
    if inc is None:
        t.add_row("updates", "[dim]gazing…[/]")
    elif inc.upstream is None:
        t.add_row("updates", "no upstream branch")
    elif inc.behind:
        t.add_row("updates", f"[b {theme.GOLD}]{inc.behind} new commit(s)[/] on {inc.upstream}")
    else:
        t.add_row("updates", f"[#7ee0a1]up to date[/] with {inc.upstream}")
    return t


class WelcomePage(Page):
    step = "welcome"

    def can_back(self) -> bool:
        return False

    def body(self) -> ComposeResult:
        app = cast("ConjureApp", self.app)
        # the first time the wizard opens, the wand writes the title out
        self._typed: int | None = None if self.calm or app.intro_done else 0
        app.intro_done = True
        title = anim.typed_title(theme.TITLE, self._typed)
        yield Static(theme.banner(title), id="banner")
        with Horizontal(id="cards"):
            yield Static(platform_card(self.session.plat, self.session.choices), classes="card")
            yield Static(status_card(self.session.saved, None), id="status", classes="card")
        yield Static(
            "This wizard sets up your development environment: command-line tools, shell and "
            "editor config, and coding agents. Files it replaces are backed up first, and "
            "nothing changes until you cast on the last step.",
            classes="text",
        )
        yield Static("Press Next to begin.", classes="hint")

    def on_mount(self) -> None:
        super().on_mount()
        self.gaze()

    def on_key(self) -> None:
        self._typed = None  # any key finishes the title at once

    def animate_frame(self, frame: int) -> None:
        if self._typed is not None:
            self._typed += 2
            if self._typed >= len(theme.TITLE):
                self._typed = None
        title = anim.typed_title(theme.TITLE, self._typed)
        banner = anim.twinkle(theme.banner(title), frame // 3)
        self.query_one("#banner", Static).update(banner)

    @work(thread=True, exclusive=True)
    def gaze(self) -> None:
        if update.is_checkout():
            update.fetch()
            inc = update.incoming()
        else:
            inc = update.Incoming(None, [], [], [], 0)
        self.app.call_from_thread(self._show_status, inc)

    def _show_status(self, inc: update.Incoming) -> None:
        self.query_one("#status", Static).update(status_card(self.session.saved, inc))

    def go_next(self) -> None:
        self.app.push_screen(GrimoirePage() if self.session.saved else PathPage())


# ---- choosing a path ------------------------------------------------------------------------


class ChoicePage(Page):
    """Radio buttons, with a description of the selected one. Choosing redraws the rail."""

    OPTIONS: list[tuple[str, str]] = []  # (label, description)

    def body(self) -> ComposeResult:
        with RadioSet(id="choice"):
            for i, (label, _) in enumerate(self.OPTIONS):
                yield RadioButton(label, value=i == self.initial())
        box = Static(self.OPTIONS[self.initial()][1], id="choice-help", classes="describe")
        box.border_title = "What this does"
        yield box

    def initial(self) -> int:
        return 0

    def chosen(self) -> int:
        return self.query_one("#choice", RadioSet).pressed_index

    def apply(self, index: int) -> None:
        """Record the choice in the session (so the rail shows the right steps)."""

    def on_mount(self) -> None:
        self.apply(self.initial())
        super().on_mount()

    @on(RadioSet.Changed)
    def _changed(self, event: RadioSet.Changed) -> None:
        self.query_one("#choice-help", Static).update(self.OPTIONS[event.index][1])
        self.apply(event.index)
        self.refresh_rail()


class PathPage(ChoicePage):
    step = "path"
    title_text = "🧭 Choose a path"
    hint = "How much of the spellbook do you want to see?"
    OPTIONS = [
        (
            "✨ Quick cast — the recommended setup for this machine",
            "Installs every required package for this platform, links all the config that "
            "applies here and sets up both coding agents. Models you've already pulled are "
            "checked for updates; new models (they're large) are only downloaded if you tick them "
            "in the spellbook. Optional packages and extras are left out. You'll still see "
            "everything on the review step before anything changes.",
        ),
        (
            "📖 Open the spellbook — choose every component",
            "Pick packages, config modules, coding agents and extras (local models, devbox "
            "images) one by one, then set how they're installed: sudo, source preference, "
            "optional packages.",
        ),
    ]

    def initial(self) -> int:
        return 1 if self.session.custom else 0

    def apply(self, index: int) -> None:
        self.session.mode = "install"
        self.session.custom = index == 1

    def go_next(self) -> None:
        s = self.session
        if s.custom:
            self.app.push_screen(SpellbookPage())
        else:
            s.checked = {c.value for c in s.choices if c.default and c.available}
            self.app.push_screen(IncantationPage())


class GrimoirePage(ChoicePage):
    step = "grimoire"
    title_text = "📜 The Grimoire"
    hint = "conjure has been cast on this machine before. What next?"
    MODES = ["modify", "update", "repair", "remove"]
    OPTIONS = [
        (
            "📖 Rewrite the spellbook — change what's installed",
            "Opens the spellbook with your last choices ticked, so you can add or drop components.",
        ),
        (
            "📜 Update — pull the latest changes and re-apply",
            "Fetches dev-config, shows the incoming commits and the components they touch, then "
            "fast-forwards and re-applies what you installed.",
        ),
        (
            "🩺 Mend — re-apply and check",
            "Re-applies what you installed (missing packages, broken or moved links), then runs "
            "the doctor to report anything still wrong.",
        ),
        (
            "🧹 Banish — remove links and restore backups",
            "Removes every link conjure made and moves your backed-up files back. Installed "
            "packages are left alone.",
        ),
    ]

    def initial(self) -> int:
        mode = self.session.mode
        return self.MODES.index(mode) if mode in self.MODES else 0

    def apply(self, index: int) -> None:
        self.session.mode = self.MODES[index]
        self.session.custom = index == 0

    def go_next(self) -> None:
        mode = self.session.mode
        if mode == "modify":
            self.app.push_screen(SpellbookPage())
        elif mode == "update":
            self.app.push_screen(ScryingPage())
        else:
            self.app.push_screen(IncantationPage())


# ---- spellbook: choose ----------------------------------------------------------------------


def _prompt(c: model.Choice) -> str:
    marks = {
        "installed": "[#7ee0a1]✓ installed[/]",
        "pulled": "[#7ee0a1]✓ pulled[/]",
        "missing": "[#f2c14e]• missing[/]",
        "optional": "[dim]optional[/]",
    }
    note = marks.get(c.note, f"[dim]{escape(c.note)}[/]" if c.note else "")
    if c.available and c.note.startswith("not pulled"):
        note = f"[#f2c14e]• {escape(c.note)}[/]"
    return f"{escape(c.label)}  {note}".rstrip()


class SpellbookPage(Page):
    step = "spellbook"
    title_text = "📖 The Spellbook"
    hint = "Space toggles · a/x tick all/none in the tab · greyed out: not for this machine"

    BINDINGS = [("a", "all", "All in tab"), ("x", "none", "None in tab")]

    def body(self) -> ComposeResult:
        s = self.session
        with TabbedContent():
            for group, title in model.GROUPS.items():
                with TabPane(title, id=f"tab-{group}"):
                    yield SelectionList[str](
                        *(
                            Selection(
                                _prompt(c), c.value, c.value in s.checked, disabled=not c.available
                            )
                            # what this machine can't use goes to the bottom
                            for c in sorted(s.choices, key=lambda c: not c.available)
                            if c.group == group
                        ),
                        id=f"list-{group}",
                    )
        yield Static("", id="selected-count")

    def on_mount(self) -> None:
        super().on_mount()
        self._count()

    def checked(self) -> set[str]:
        return {v for lst in self.query(SelectionList) for v in lst.selected}

    @on(SelectionList.SelectedChanged)
    def _count(self) -> None:
        available = sum(1 for c in self.session.choices if c.available)
        self.query_one("#selected-count", Static).update(
            f"{len(self.checked())} of {available} components ticked"
        )

    def _active_list(self) -> SelectionList[str]:
        active = self.query_one(TabbedContent).active
        return self.query_one(f"#list-{active.removeprefix('tab-')}", SelectionList)

    def action_all(self) -> None:
        lst = self._active_list()
        for i in range(lst.option_count):
            opt = lst.get_option_at_index(i)
            if not opt.disabled:
                lst.select(opt)

    def action_none(self) -> None:
        self._active_list().deselect_all()

    def go_next(self) -> None:
        self.session.checked = self.checked()
        self.app.push_screen(EnchantPage())


# ---- enchantments: options ------------------------------------------------------------------


class EnchantPage(Page):
    step = "enchant"
    title_text = "🧪 Enchantments"
    hint = "How the spell should be cast."

    def _option(self, id_: str, value: bool, text: str) -> Horizontal:
        return Horizontal(Switch(value=value, id=id_), Label(text), classes="option")

    def body(self) -> ComposeResult:
        s = self.session
        with VerticalScroll():
            yield self._option(
                "sudo",
                s.settings.sudo,
                "Allow sudo for system packages (dnf/apt/.pkg); asks once up front",
            )
            yield self._option(
                "yes",
                s.settings.yes,
                "Approve unpinned vendor install scripts without asking each time",
            )
            yield self._option(
                "with_optional",
                s.opts.with_optional,
                "Include optional packages that aren't ticked",
            )
            if s.plat.os == "macos":
                yield self._option("no_brew", s.opts.no_brew, "Never use Homebrew")
            yield Label("Prefer these sources first (comma-separated, e.g. dmg,web or brew):")
            yield Input(",".join(s.opts.prefer), placeholder="manifest order", id="prefer")

    def _switch(self, id_: str, default: bool = False) -> bool:
        found = self.query(f"#{id_}")
        return bool(found.first(Switch).value) if found else default

    def go_next(self) -> None:
        s = self.session
        prefer = [p.strip() for p in self.query_one("#prefer", Input).value.split(",") if p.strip()]
        s.opts = dataclasses.replace(
            s.opts,
            prefer=prefer,
            with_optional=self._switch("with_optional"),
            no_brew=self._switch("no_brew"),
        )
        s.settings = dataclasses.replace(
            s.settings, sudo=self._switch("sudo", True), yes=self._switch("yes")
        )
        self.app.push_screen(IncantationPage())


# ---- scrying: updates -----------------------------------------------------------------------


def vision(inc: update.Incoming, touched: list[str]) -> Group:
    parts: list[Any] = []
    if inc.upstream is None:
        parts.append(Text("This branch has no upstream to update from.", style="#ff6b8b"))
        return Group(*parts)
    if not inc.behind:
        parts.append(Text(f"✓ Already up to date with {inc.upstream}.", style="#7ee0a1"))
        parts.append(Text("Next re-applies what you installed.", style="dim"))
    else:
        commits = Table(title=f"{inc.behind} new commit(s) on {inc.upstream}", title_justify="left")
        commits.add_column("commit", style=theme.GOLD, no_wrap=True)
        commits.add_column("message")
        for line in inc.commits:
            sha, _, msg = line.partition(" ")
            commits.add_row(sha, msg)
        files = Table(title="Changed files", title_justify="left")
        files.add_column("", width=1)
        files.add_column("path")
        colours = {"A": "#7ee0a1", "D": "#ff6b8b", "M": theme.GOLD, "R": theme.VIOLET}
        for status, p in inc.files:
            files.add_row(Text(status, style=colours.get(status, "")), p)
        parts += [commits, Text(""), files, Text("")]
        parts.append(Text(f"Touches: {', '.join(touched) or 'nothing you install'}", style="b"))
        if "installer" in touched:
            parts.append(
                Text("The installer itself changed: conjure restarts after the pull.", style="i")
            )
    why = update.blocker(inc)
    if why:
        parts.append(Text(f"\n✗ Can't update: {why}", style="bold #ff6b8b"))
    return Group(*parts)


class ScryingPage(Page):
    step = "scrying"
    title_text = "🔮 Scrying"
    hint = "What has changed upstream."

    def body(self) -> ComposeResult:
        self._gazing = True
        with Horizontal(id="gaze-row"):
            yield Static(anim.block(anim.ball(0)), id="ball")
            yield Static("gazing into the remote…", id="gazing")
        with VerticalScroll(id="vision"):
            yield Static("", id="vision-body")

    def on_mount(self) -> None:
        super().on_mount()
        self.query_one("#next", Button).disabled = True
        self.gaze()

    def animate_frame(self, frame: int) -> None:
        if self._gazing:
            self.query_one("#ball", Static).update(anim.block(anim.ball(frame // 2)))

    @work(thread=True, exclusive=True)
    def gaze(self) -> None:
        if not update.is_checkout():
            inc, fetched = update.Incoming(None, [], [], [], 0), True
        else:
            fetched = update.fetch()
            inc = update.incoming()
        self.app.call_from_thread(self._show, inc, fetched)

    def _show(self, inc: update.Incoming, fetched: bool) -> None:
        self._gazing = False
        self.query_one("#gaze-row").display = False
        s = self.session
        s.incoming = inc
        s.touched = update.affected([p for _, p in inc.files])
        body: Any = vision(inc, s.touched)
        if not fetched:
            warning = Text("! git fetch failed: showing what was already fetched", theme.GOLD)
            body = Group(warning, body)
        self.query_one("#vision-body", Static).update(body)
        nxt = self.query_one("#next", Button)
        nxt.disabled = inc.upstream is None or update.blocker(inc) is not None
        if not nxt.disabled:
            nxt.focus()

    def go_next(self) -> None:
        self.app.push_screen(IncantationPage())


# ---- incantation: review --------------------------------------------------------------------


def selection_tree(s: Session, sel: install.Selection) -> Tree:
    if s.mode == "remove":
        tree = Tree(f"[b {theme.GOLD}]🧹 This spell will[/]")
        tree.add("remove every link conjure created")
        tree.add("move backed-up files (~/.config-backups) back into place")
        tree.add("[dim]leave installed packages, clones and agent settings alone[/]")
        return tree
    tree = Tree(f"[b {theme.GOLD}]🪄 This spell will[/]")
    if s.pulls and s.incoming is not None:
        tree.add(f"📜 pull {s.incoming.behind} commit(s) from {s.incoming.upstream}")
    if s.restarts:
        tree.add("🔁 restart conjure (the installer changed), then re-apply what you installed")
        return tree
    if "packages" in sel.modules:
        node = tree.add("📦 install missing packages")
        node.add(", ".join(sel.opts.names) if sel.opts.names else "every package for this machine")
    if "repos" in sel.modules:
        tree.add("📚 clone external repos (left alone if already there)")
    linked = [m for m in sel.modules if m in install.LINK_MODULES]
    if linked:
        node = tree.add("📜 link config (existing files are backed up first)")
        node.add(", ".join(linked))
    if "agents" in sel.modules:
        tree.add(f"🤖 sync agents: {', '.join(sel.agents) or 'all'}")
    status = {c.value: c.note for c in s.choices}
    for rt, names in sel.models_by_runtime().items():
        where = "Ollama on Windows" if rt == "ollama" and s.plat.ollama == "windows" else rt
        node = tree.add(f"🧠 pull models into {where}")
        for name in names:
            note = status.get(f"model:{rt}:{name}", "")
            node.add(f"{name}  [dim]{escape(note)}[/]" if note else name)
        if rt == "ollama" and s.plat.wsl_ollama:
            node.add(f"[{theme.GOLD}]! a Linux ollama inside WSL is ignored[/]")
    for extra in sel.extras:
        if extra == "models" or extra.startswith("models:"):
            tree.add(f"🧠 pull every model for {extra.partition(':')[2] or 'each runtime found'}")
        else:
            tree.add(f"✨ build devbox image(s): {extra.split(':', 1)[1]}")
    if s.mode == "repair":
        tree.add("🩺 then run the doctor")
    if not (sel.modules or sel.extras or s.pulls):
        tree.add("[dim]nothing: go back and tick something[/]")
    o, opts = sel.opts, []
    if o.prefer:
        opts.append(f"prefer {', '.join(o.prefer)}")
    if o.with_optional:
        opts.append("include optional packages")
    if o.no_brew:
        opts.append("never use Homebrew")
    if s.settings.yes:
        opts.append("approve unpinned scripts")
    if not s.settings.sudo:
        opts.append("no sudo")
    if opts:
        node = tree.add("⚙ options")
        for line in opts:
            node.add(line)
    return tree


class IncantationPage(Page):
    step = "incantation"
    title_text = "📜 The Incantation"
    hint = "Review before casting. Nothing has changed yet."

    def next_text(self) -> str:
        return "🧹 Banish" if self.session.mode == "remove" else "🪄 Cast"

    def selection(self) -> install.Selection:
        s = self.session
        if s.mode in ("update", "repair"):
            app = cast("ConjureApp", self.app)
            # extras (image builds, model downloads) only re-run when an update touched them
            return app.saved_selection(s.touched if s.mode == "update" else [])
        return model.selection(s.checked, s.choices, s.opts)

    def body(self) -> ComposeResult:
        yield Static(selection_tree(self.session, self.selection()), id="tree")
        yield Horizontal(
            Switch(value=self.session.settings.dry_run, id="dry"),
            Label("Rehearsal (dry run): show every step, change nothing"),
            classes="option",
        )

    def go_next(self) -> None:
        s = self.session
        s.settings = dataclasses.replace(s.settings, dry_run=self.query_one("#dry", Switch).value)
        sel = self.selection()
        job, count = build_job(s, sel)
        sudo = (
            s.mode != "remove"
            and s.settings.sudo
            and not s.settings.dry_run
            and not s.restarts
            and model.needs_sudo(sel)
        )
        self.app.push_screen(CastingPage(job, count, sudo_first=sudo))


def build_job(s: Session, sel: install.Selection) -> tuple[Job, int]:
    """The work for the chosen mode, and how many steps it reports for the progress bar."""
    if s.mode == "remove":

        def banish(ctx: core.Ctx) -> dict[str, bool]:
            ns = argparse.Namespace(dry_run=ctx.dry_run, yes=True)
            return {"banish": cli.cmd_uninstall(ns) == 0}

        return banish, 2

    inc = s.incoming
    pulls, restarts, repair = s.pulls, s.restarts, s.mode == "repair"

    def job(ctx: core.Ctx) -> dict[str, bool]:
        results: dict[str, bool] = {}
        if pulls and inc is not None:
            core.step("update repo")
            results["pull"] = update.fast_forward(ctx, inc)
            if restarts or not results["pull"]:
                return results
        results.update(install.run(ctx, sel))
        ctx.summary()
        if repair:
            core.step("doctor: checking the result")
            results["doctor"] = cli.cmd_doctor(argparse.Namespace()) == 0
        return results

    if restarts:
        return job, 1
    return job, model.step_count(sel) + int(pulls) + (5 if repair else 0)


# ---- casting: run ---------------------------------------------------------------------------


class CastingPage(Page):
    step = "casting"
    title_text = "🪄 Casting"
    hint = "Output streams below. Prompts appear as dialogs."

    BINDINGS = [Binding("escape", "noop", show=False)]

    def __init__(self, job: Job, steps: int, sudo_first: bool = False) -> None:
        super().__init__()
        self.job, self.steps, self.sudo_first = job, max(steps, 1), sudo_first
        self.finished = False
        self.good = False
        self.results: dict[str, bool] = {}
        self.ctx: core.Ctx | None = None
        self._current = "gathering power"
        self._stage = "sparkle"  # which anim scene plays while this step runs
        self._finale: str | None = None  # burst | fizzle | dissolve, once the job is done
        self._finale_start = 0
        self._banished: list[str] = []  # paths unlinked/restored, for the dissolve
        self._stop_keepalive = threading.Event()

    def can_back(self) -> bool:
        return False

    def body(self) -> ComposeResult:
        yield Static(Text(f"casting {self._current}…"), id="casting-status")
        yield Static("", id="scene", classes="calm" if self.calm else "")
        yield ProgressBar(total=self.steps, show_eta=False, id="progress")
        yield Static("", id="live")  # the current download bar, redrawn in place
        yield RichLog(id="log", wrap=True, markup=False, highlight=False)

    def on_mount(self) -> None:
        super().on_mount()
        self.query_one("#next", Button).disabled = True
        self.query_one("#cancel", Button).disabled = True
        approved = self.session.settings.sudo
        if self.sudo_first:
            approved = self._sudo_login()
        self.cast(approved)

    def action_noop(self) -> None:
        pass

    def _sudo_login(self) -> bool:
        """sudo reads the password from a terminal, so hand it the real one for a moment, then
        keep the timestamp fresh while the job runs without one."""
        with self.app.suspend():
            print("\n🪄 conjure needs sudo for system packages.\n")
            ok_ = subprocess.run(["sudo", "-v"]).returncode == 0
        if ok_:
            threading.Thread(target=self._sudo_keepalive, daemon=True).start()
        return ok_

    def _sudo_keepalive(self) -> None:
        while not self._stop_keepalive.wait(60):
            subprocess.run(["sudo", "-n", "-v"], capture_output=True)

    def animate_frame(self, frame: int) -> None:
        scene = self.query_one("#scene", Static)
        if self._finale is not None:
            f = frame - self._finale_start
            if self._finale == "burst":
                lines = anim.burst(f)
            elif self._finale == "fizzle":
                lines = anim.fizzle(f)
            else:
                lines = anim.dissolve(self._banished, f)
            scene.update(anim.block(lines))
            return
        spark = theme.SPINNER[frame % len(theme.SPINNER)]
        status = Text.assemble((f"{spark} ", theme.GOLD), (f"casting {self._current}…", "#ece6ff"))
        self.query_one("#casting-status", Static).update(status)
        scene.update(anim.block(anim.scene(self._stage, frame)))

    # these two run on the worker thread
    def _sink(self, level: str, msg: str) -> None:
        self.app.call_from_thread(self._write, level, msg)

    def _ask(self, question: str) -> bool:
        answer: dict[str, bool] = {}
        done = threading.Event()

        def got(value: bool | None) -> None:
            answer["v"] = bool(value)
            done.set()

        self.app.call_from_thread(self.app.push_screen, ConfirmModal(question), got)
        done.wait()
        return answer["v"]

    @work(thread=True, exclusive=True)
    def cast(self, sudo_approved: bool) -> None:
        settings = self.session.settings
        previous = core.SINK
        core.SINK = self._sink
        ctx = core.Ctx(dry_run=settings.dry_run, yes=settings.yes, ask=self._ask, stream=True)
        ctx.once["sudo"] = sudo_approved or settings.dry_run
        try:
            results = self.job(ctx)
        except Exception as e:  # show it in the log rather than tearing down the TUI
            core.err(f"{type(e).__name__}: {e}")
            results = {"error": False}
        finally:
            core.SINK = previous
            self._stop_keepalive.set()
        self.app.call_from_thread(self._finish, results, ctx)

    def _write(self, level: str, msg: str) -> None:
        live = self.query_one("#live", Static)
        if level == "progress":  # a download bar or spinner redrawing: one live line, no log
            live.update(Text(f"  {msg}", style=theme.MUTED))
            return
        live.update("")
        log = self.query_one("#log", RichLog)
        if level == "step":
            log.write(Text(""))
            self._current = msg
            self._stage = anim.stage_of(msg, self._stage)
            self.query_one("#progress", ProgressBar).advance(1)
            if self.calm:
                self.query_one("#casting-status", Static).update(Text(f"casting {msg}…"))
        if msg.startswith(("unlink ", "restore ")):
            self._banished.append(msg.split(" ", 1)[1].replace(str(core.home()), "~"))
        prefix = theme.LEVEL_PREFIX.get(level, "")
        log.write(Text(prefix + msg, style=theme.LEVEL_STYLE.get(level, "")))

    def _finish(self, results: dict[str, bool], ctx: core.Ctx) -> None:
        self.finished, self.results, self.ctx = True, results, ctx
        self.good = all(results.values())
        self.query_one("#progress", ProgressBar).update(progress=self.steps)
        if not self.good:
            head = Text("✗ Part of the spell fizzled — see the log.", style="bold #ff6b8b")
        elif ctx.dry_run:
            head = Text("✨ Rehearsal complete: this is what the spell would do.", "bold #7ee0a1")
        else:
            head = Text("✨ The spell took hold.", style="bold #7ee0a1")
        self.query_one("#casting-status", Static).update(head)
        if not self.good:
            self._finale = "fizzle"
        elif self.session.mode == "remove" and self._banished:
            self._finale = "dissolve"  # the removed links crumble away
        else:
            self._finale = "burst"
        self._finale_start = self._frame
        nxt = self.query_one("#next", Button)
        nxt.disabled = False
        nxt.focus()

    def go_next(self) -> None:
        if self.ctx is not None:
            self.app.push_screen(DonePage(self.results, self.ctx, self.good))


# ---- complete -------------------------------------------------------------------------------


class DonePage(Page):
    step = "done"
    hint = ""

    def __init__(self, results: dict[str, bool], ctx: core.Ctx, good: bool) -> None:
        super().__init__()
        self.results, self.ctx, self.good = results, ctx, good
        self.title_text = "✨ Complete" if good else "✗ The spell fizzled"

    def can_back(self) -> bool:
        return False

    def next_text(self) -> str:
        return "Finish"

    def restarting(self) -> bool:
        return self.session.restarts and self.good and not self.ctx.dry_run

    def body(self) -> ComposeResult:
        lines: list[Text] = []
        for name, ok_ in self.results.items():
            mark = ("✓", "#7ee0a1") if ok_ else ("✗", "#ff6b8b")
            lines.append(Text.assemble(mark, f" {name}"))
        if self.ctx.backed_up and not self.ctx.dry_run:
            lines.append(Text(f"backups: {self.ctx.backup_dir}", style="dim"))
        yield Static(Group(*lines), id="summary")
        if self.ctx.dry_run:
            yield Static(
                "That was a rehearsal: nothing changed. Run the wizard again without "
                "rehearsal to cast it for real.",
                classes="text",
            )
        elif not self.good:
            yield Static(
                "Some steps failed; the log on the previous step has the details. Fix the cause "
                "and run conjure again, or choose Mend from the Grimoire.",
                classes="text",
            )
        elif self.restarting():
            yield Static(
                "The update changed conjure itself, so it needs to restart to re-apply what "
                "you installed.",
                classes="text",
            )
            with RadioSet(id="restart"):
                yield RadioButton("🔁 Restart conjure now", value=True)
                yield RadioButton("Later: I'll run scripts/dotfiles update myself")
        elif self.session.mode != "remove":
            yield Static("Open a new terminal to start using the new config.", classes="text")
        yield Static("Press Finish to leave.", classes="hint")

    def on_mount(self) -> None:
        super().on_mount()
        self.query_one("#cancel", Button).disabled = True

    def go_next(self) -> None:
        if self.restarting() and self.query_one("#restart", RadioSet).pressed_index == 0:
            self.app.exit(("restart", ",".join(self.session.touched)))
        else:
            self.app.exit()
