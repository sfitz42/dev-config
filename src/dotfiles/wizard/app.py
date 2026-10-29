"""conjure 🪄: the interactive installer, a step-by-step wizard.

scripts/dotfiles            # on a terminal, with no command
scripts/dotfiles conjure
uv run conjure
"""

from __future__ import annotations

import argparse
import os
import sys

from textual.app import App

from dotfiles import core, install, packages, platform, state, update
from dotfiles.wizard import anim, model, screens, theme


class ConjureApp(App[tuple[str, str] | None]):
    CSS = theme.CSS
    TITLE = "conjure"
    SUB_TITLE = "the dev-config installer"
    ENABLE_COMMAND_PALETTE = False

    def __init__(
        self,
        plat: platform.Platform | None = None,
        reapply: bool = False,
        touched: list[str] | None = None,
        calm: bool | None = None,
    ) -> None:
        super().__init__()
        # calm: no animation (--calm, CONJURE_CALM=1 or TERM=dumb)
        self.calm = anim.calm_from_env() if calm is None else calm
        self.intro_done = False  # the title is written out once, on first open
        self.last_step: int | None = None  # rail index of the last page shown, for the trail
        plat = plat or platform.describe()
        saved = state.load()
        choices = model.choices(plat, saved["selection"] if saved else None)
        opts = install.Selection.from_dict(saved["selection"]).opts if saved else packages.Opts()
        self.session = screens.Session(
            plat=plat,
            saved=saved,
            choices=choices,
            checked={c.value for c in choices if c.default and c.available},
            opts=opts,
        )
        self.reapply = reapply
        self.session.touched = touched or []

    def on_mount(self) -> None:
        self.register_theme(theme.ARCANE)
        self.theme = "arcane"
        self.push_screen(screens.WelcomePage())
        if self.reapply:
            # restarted after an update that changed conjure: go straight to re-applying
            self.session.mode = "update"
            self.push_screen(screens.IncantationPage())

    def saved_selection(self, touched: list[str]) -> install.Selection:
        """The last install's selection (or the defaults), with extras only where the update
        touched their inputs."""
        saved = state.load()
        if not saved:
            return install.Selection()
        sel = install.Selection.from_dict(saved["selection"])
        sel.extras = update.extras_to_rerun(sel.extras, touched)
        return sel


def run_wizard(reapply: bool = False, touched: list[str] | None = None, calm: bool = False) -> int:
    app = ConjureApp(reapply=reapply, touched=touched, calm=calm or None)
    result = app.run()
    if result and result[0] == "restart":
        # the update changed conjure itself: start again on the new code (uv syncs new deps)
        script = str(core.REPO_ROOT / "scripts" / "dotfiles")
        again = [script, "conjure", "--reapply", "--touched", result[1]]
        os.execv(script, again + (["--calm"] if app.calm else []))
    return 0


def main() -> int:
    """`uv run conjure` entry point."""
    p = argparse.ArgumentParser(prog="conjure", description="the dev-config installer wizard")
    p.add_argument("--reapply", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--touched", default="", help=argparse.SUPPRESS)
    p.add_argument("--calm", action="store_true", help="no animation (also CONJURE_CALM=1)")
    args = p.parse_args()
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        core.err("conjure needs a terminal; use `scripts/dotfiles install` in scripts")
        return 2
    return run_wizard(args.reapply, [t for t in args.touched.split(",") if t], args.calm)
