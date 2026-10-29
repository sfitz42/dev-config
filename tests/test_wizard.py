import dataclasses

import pytest
from textual.widgets import Button, RadioButton, RichLog, SelectionList, Switch

from dotfiles import core, install, models, packages, platform, update
from dotfiles.wizard import app as wizard_app
from dotfiles.wizard import model, screens

LINUX = platform.Platform(
    os="linux",
    arch="x86_64",
    wsl=True,
    distro="Ubuntu 24.04 LTS",
    pkg_manager="apt",
    brew=False,
    container_runtime=None,
)
MAC = platform.Platform("macos", "arm64", False, "", None, True, "container", ollama="native")
# WSL with Ollama on Windows, and a stray Linux ollama inside WSL too
WSL = dataclasses.replace(LINUX, ollama="windows", wsl_ollama=True)


GPT = "model:ollama:gpt-oss:20b"
QWEN = "model:ollama:qwen3.8:27b-q4_K_M"
MLX = "model:omlx:Qwen3.8-27B-4bit"


def by_value(choices):
    return {c.value: c for c in choices}


def pulled(*names):
    """A stand-in for models.installed: these names are pulled, in every runtime."""
    return lambda runtime, spec: set(names)


def test_choices_follow_the_platform():
    linux = by_value(model.choices(LINUX, pulled=pulled()))
    assert not linux["link:ghostty"].available and not linux["link:ghostty"].default
    assert not linux["link:zed"].available
    assert linux["link:zsh"].available and linux["link:zsh"].default
    assert not linux[MLX].available
    assert not linux[GPT].available and "Windows" in linux[GPT].note
    assert not linux["extra:devbox:core"].available
    # Ollama the package is never installed inside WSL
    assert not linux["pkg:ollama"].available and "Windows" in linux["pkg:ollama"].note
    mac = by_value(model.choices(MAC, pulled=pulled()))
    assert mac["link:ghostty"].available
    assert mac[MLX].available and not mac[MLX].default
    assert mac["pkg:ollama"].available and not mac["pkg:ollama"].default  # optional


def test_models_show_their_status():
    wsl = by_value(model.choices(WSL, pulled=pulled("gpt-oss:20b")))
    assert wsl[GPT].available and wsl[GPT].note == "pulled"
    assert wsl[GPT].default  # already pulled: kept up to date by default
    assert wsl[QWEN].note == "not pulled · 18 GB" and not wsl[QWEN].default  # large: opt in
    unknown = by_value(model.choices(WSL, pulled=lambda rt, spec: None))
    assert unknown[GPT].note.startswith("status unknown") and not unknown[GPT].default


def test_choices_tick_the_saved_selection():
    saved = install.Selection(
        modules=["zsh", "agents"], agents=["pi"], models=["ollama:qwen3.8:27b-q4_K_M"]
    )
    chosen = by_value(model.choices(WSL, saved.to_dict(), pulled=pulled("gpt-oss:20b")))
    assert chosen["link:zsh"].default and not chosen["link:git"].default
    assert chosen["agent:pi"].default and not chosen["agent:claude"].default
    assert chosen[QWEN].default and not chosen[GPT].default  # the saved choice wins
    assert not any(c.default for c in chosen.values() if c.group == "packages")
    # an older record's "models:ollama" extra ticks every Ollama model
    old = by_value(
        model.choices(WSL, {"modules": [], "extras": ["models:ollama"]}, pulled=pulled())
    )
    assert old[GPT].default and old[QWEN].default


def test_selection_from_ticks():
    all_choices = model.choices(MAC, pulled=pulled())
    ticked = {"pkg:gh", "link:zsh", "repos", "agent:pi", GPT, MLX}
    ticked |= {"extra:devbox:core", "extra:devbox:fullstack"}
    sel = model.selection(ticked, all_choices, packages.Opts(prefer=["brew"]))
    assert sel.modules == ["packages", "repos", "zsh", "agents"]
    assert sel.opts.names == ["gh"] and sel.opts.prefer == ["brew"]
    assert sel.agents == ["pi"] and sel.extras == ["devbox:all"]
    assert sel.models_by_runtime() == {"omlx": ["Qwen3.8-27B-4bit"], "ollama": ["gpt-oss:20b"]}
    # unavailable choices are never selected, even if ticked
    linux_sel = model.selection({"link:zed", MLX}, model.choices(LINUX), packages.Opts())
    assert linux_sel.modules == [] and linux_sel.models == []


@pytest.fixture
def quiet_repo(monkeypatch, fake_home):
    """No network or real git state while the welcome screen gazes, and no Ollama to ask."""
    monkeypatch.setattr(models, "installed", lambda runtime, spec: set())
    monkeypatch.setattr(models, "ollama_version", lambda: None)
    monkeypatch.setattr(update, "is_checkout", lambda root=core.REPO_ROOT: True)
    monkeypatch.setattr(update, "fetch", lambda root=core.REPO_ROOT: True)
    monkeypatch.setattr(
        update,
        "incoming",
        lambda root=core.REPO_ROOT: update.Incoming("origin/main", [], [], [], 0),
    )


async def test_cast_flow_streams_into_the_log(quiet_repo, monkeypatch):
    ran = []

    def fake_run(ctx, sel, root=core.REPO_ROOT, record=True):
        ran.append((ctx.dry_run, ctx.stream, sel.modules))
        core.step("link: zsh")
        ctx.run(["echo", "hello"])
        return {"links": True}

    monkeypatch.setattr(install, "run", fake_run)
    app = wizard_app.ConjureApp(plat=LINUX)
    async with app.run_test(size=(120, 45)) as pilot:
        await pilot.pause()
        assert isinstance(app.screen, screens.WelcomePage)
        assert app.screen.query_one("#back", Button).disabled
        await pilot.click("#next")
        await pilot.pause()
        # first time here: choose a path; picking the spellbook adds its steps to the rail
        path = app.screen
        assert isinstance(path, screens.PathPage)
        assert [k for k, _ in screens.steps(app.session)] == [
            "welcome",
            "path",
            "incantation",
            "casting",
            "done",
        ]
        path.query("RadioButton").last(RadioButton).value = True
        await pilot.pause()
        assert app.session.custom
        assert "spellbook" in [k for k, _ in screens.steps(app.session)]
        await pilot.click("#next")
        await pilot.pause()
        spellbook = app.screen
        assert isinstance(spellbook, screens.SpellbookPage)
        config = spellbook.query_one("#list-config", SelectionList)
        zed = next(
            config.get_option_at_index(i)
            for i in range(config.option_count)
            if config.get_option_at_index(i).value == "link:zed"
        )
        assert zed.disabled
        await pilot.click("#next")
        await pilot.pause()
        assert isinstance(app.screen, screens.EnchantPage)
        await pilot.click("#next")
        await pilot.pause()
        assert isinstance(app.screen, screens.IncantationPage)
        app.screen.query_one("#dry", Switch).value = True
        await pilot.click("#next")
        await pilot.pause()
        casting = app.screen
        assert isinstance(casting, screens.CastingPage)
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert casting.finished and casting.good
        assert casting._finale == "burst"
        assert casting._stage == "link"  # the scene followed the step
        lines = [str(line.text) for line in casting.query_one("#log", RichLog).lines]
        assert any("link: zsh" in line for line in lines)
        assert any("[dry-run] echo hello" in line for line in lines)
        assert ran and ran[0][0] is True and ran[0][1] is True
        assert casting.query_one("#back", Button).disabled
        await pilot.click("#next")
        await pilot.pause()
        assert isinstance(app.screen, screens.DonePage)
        await pilot.click("#next")
        await pilot.pause()
    assert app.return_value is None  # Finish leaves the wizard
    assert core.SINK is core.print_sink  # restored after the cast


async def test_installed_before_opens_the_grimoire(quiet_repo, fake_home):
    from dotfiles import state

    state.save(install.Selection(modules=["zsh"]).to_dict())
    app = wizard_app.ConjureApp(plat=LINUX)
    async with app.run_test(size=(120, 45)) as pilot:
        await pilot.pause()
        await pilot.click("#next")
        await pilot.pause()
        grimoire = app.screen
        assert isinstance(grimoire, screens.GrimoirePage)
        grimoire.query("RadioButton")[1].value = True  # Update
        await pilot.pause()
        assert app.session.mode == "update"
        assert "scrying" in [k for k, _ in screens.steps(app.session)]
        await pilot.click("#next")
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert isinstance(app.screen, screens.ScryingPage)
        assert not app.screen.query_one("#next", Button).disabled  # up to date: re-apply
        await pilot.click("#cancel")
        await pilot.pause()
        assert isinstance(app.screen, screens.ConfirmModal)
        await pilot.press("y")
        await pilot.pause()
    assert app.return_value is None


async def test_prompts_become_dialogs(quiet_repo):
    answers = []

    def job(ctx):
        answers.append(ctx.confirm("run the unpinned script?"))
        return {"asked": True}

    app = wizard_app.ConjureApp(plat=LINUX)
    async with app.run_test(size=(120, 45)) as pilot:
        await pilot.pause()
        app.push_screen(screens.CastingPage(job, 1))
        await pilot.pause(0.2)
        assert isinstance(app.screen, screens.ConfirmModal)
        await pilot.press("y")
        await app.workers.wait_for_complete()
        await pilot.pause()
    assert answers == [True]


async def test_banish_dissolves_and_failures_fizzle(quiet_repo):
    def banish(ctx):
        core.step("remove links created by this tool")
        ctx.say(f"unlink {core.home()}/.zshrc")
        return {"banish": True}

    def broken(ctx):
        core.step("packages")
        return {"packages": False}

    app = wizard_app.ConjureApp(plat=LINUX)
    async with app.run_test(size=(120, 45)) as pilot:
        await pilot.pause()
        app.session.mode = "remove"
        page = screens.CastingPage(banish, 1)
        app.push_screen(page)
        await app.workers.wait_for_complete()
        await pilot.pause(0.3)
        assert page._finale == "dissolve" and page._banished == ["~/.zshrc"]
        app.session.mode = "install"
        failed = screens.CastingPage(broken, 1)
        app.push_screen(failed)
        await app.workers.wait_for_complete()
        await pilot.pause(0.3)
        assert failed._finale == "fizzle"


async def test_calm_mode_has_no_animation(quiet_repo):
    app = wizard_app.ConjureApp(plat=LINUX, calm=True)
    async with app.run_test(size=(120, 45)) as pilot:
        await pilot.pause()
        welcome = app.screen
        assert not hasattr(welcome, "_ticker")
        assert welcome._typed is None  # the title is there at once
        page = screens.CastingPage(lambda ctx: {"ok": True}, 1)
        app.push_screen(page)
        await app.workers.wait_for_complete()
        await pilot.pause()
        assert page.query_one("#scene").has_class("calm")
