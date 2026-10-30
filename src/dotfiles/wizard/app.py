"""dev-config Setup: the interactive installer, a step-by-step wizard of the old school.

scripts/dotfiles            # on a terminal, with no command
scripts/dotfiles wizard
uv run wizard
"""

from __future__ import annotations

import argparse
import os
import sys

from textual.app import App

from dotfiles import core, install, packages, platform, state, update
from dotfiles.wizard import anim, demo, model, screens, theme


class SetupApp(App[tuple[str, str] | None]):
    CSS = theme.CSS
    TITLE = "dev-config Setup"
    SUB_TITLE = "Setup Wizard"
    ENABLE_COMMAND_PALETTE = False

    def __init__(
        self,
        plat: platform.Platform | None = None,
        reapply: bool = False,
        touched: list[str] | None = None,
        calm: bool | None = None,
        demo: str | None = None,
        pace: float = 6,
    ) -> None:
        super().__init__()
        # calm: no animation (--calm, DEVCONFIG_CALM=1 or TERM=dumb)
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
        self.demo, self.pace = demo, pace  # --demo: play the installing page, change nothing
        self.session.touched = touched or []

    def on_mount(self) -> None:
        self.register_theme(theme.CLASSIC)
        self.theme = "classic"
        self.push_screen(screens.WelcomePage())
        if self.reapply:
            # restarted after an update that changed Setup: go straight to re-applying
            self.session.mode = "update"
            self.push_screen(screens.ReadyPage())
        elif self.demo:
            if self.demo == "remove":
                self.session.mode = "remove"
            self.session.settings.dry_run = True  # so every page says it was a simulation
            job, count = demo.job(self.demo, self.pace)
            self.push_screen(screens.InstallingPage(job, count))

    def saved_selection(self, touched: list[str]) -> install.Selection:
        """The last install's selection (or the defaults), with extras only where the update
        touched their inputs."""
        saved = state.load()
        if not saved:
            return install.Selection()
        sel = install.Selection.from_dict(saved["selection"])
        sel.extras = update.extras_to_rerun(sel.extras, touched)
        return sel


def run_wizard(
    reapply: bool = False,
    touched: list[str] | None = None,
    calm: bool = False,
    demo: str | None = None,
    pace: float = 6,
) -> int:
    app = SetupApp(reapply=reapply, touched=touched, calm=calm or None, demo=demo, pace=pace)
    result = app.run()
    if result and result[0] == "restart":
        # the update changed Setup itself: start again on the new code (uv syncs new deps)
        script = str(core.REPO_ROOT / "scripts" / "dotfiles")
        again = [script, "wizard", "--reapply", "--touched", result[1]]
        os.execv(script, again + (["--calm"] if app.calm else []))
    return 0


def main() -> int:
    """`uv run wizard` entry point."""
    p = argparse.ArgumentParser(prog="wizard", description="the dev-config Setup Wizard")
    p.add_argument("--reapply", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--touched", default="", help=argparse.SUPPRESS)
    p.add_argument("--calm", action="store_true", help="no animation (also DEVCONFIG_CALM=1)")
    demo.add_demo_args(p)
    args = p.parse_args()
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        core.err("Setup needs a terminal; use `scripts/dotfiles install` in scripts")
        return 2
    touched = [t for t in args.touched.split(",") if t]
    return run_wizard(args.reapply, touched, args.calm, args.demo, args.pace)
