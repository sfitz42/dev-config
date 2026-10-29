# Getting started

**Platform:** macOS, and Linux under WSL (tested on Fedora 43). Ubuntu/Debian (apt) is supported
but untested.

> [!NOTE]
> **Beyond macOS**
>
> On Linux, packages come from dnf or apt (the distro's own versions), or from the vendor script
> where a tool isn't packaged (starship, mise, claude, pi). Mac apps (Ghostty, Zed, Docker
> Desktop, oMLX, Apple `container`, the Nerd Font) and the `ghostty`/`zed` link modules are skipped
> and shown as "not for linux". Under WSL those apps belong on the Windows side.

## Fresh Mac

```sh
git clone <this repo> ~/.dev-config && cd ~/.dev-config
./scripts/bootstrap.sh --dry-run     # see everything it would do
./scripts/bootstrap.sh               # Command Line Tools -> Homebrew -> uv -> install
```

`bootstrap.sh` runs before Python exists, so it stays bash. Once `uv` exists, everything else is
Python (`scripts/dotfiles`). It is safe to re-run. Run on a terminal with no options, it finishes
in the wizard; with options (or `--dry-run`), it runs `scripts/dotfiles install` directly.

## The wizard 🪄

```sh
scripts/dotfiles            # on a terminal, with no command
scripts/dotfiles conjure    # the same, explicitly
uv run conjure              # the same, through uv
```

**conjure** is a step-by-step wizard over the same installer. A rail down the left shows each
step and where you are. Every page has **← Back**, **Next →** and **Cancel**, and nothing changes
until you cast.

1. **Welcome**: the machine it found (OS, distro, arch, package manager, container runtime), the
   last install and whether updates are waiting.
2. **Choose a path** (first run): *Quick cast*, the recommended setup for this machine, or *Open
   the spellbook* to choose everything yourself. If you've installed before, you get **The
   Grimoire** instead, with four options:
   - *Rewrite the spellbook*: change what's installed
   - *Update*: pull the latest changes, then re-apply
   - *Mend*: re-apply what you installed, then run `doctor`
   - *Banish*: remove the links and restore your backups
3. **Spellbook** and **Enchantments** (if you're choosing yourself):
   - **Spellbook**: tick packages, config modules, agents and extras. Anything that doesn't apply
     to this machine is greyed out with the reason, so you can't select it.
   - **Enchantments**: set sudo, unpinned vendor scripts, optional packages and source
     preference.
4. **Scrying** (update): the incoming commits, the changed files and which components they touch.
5. **Incantation**: review what will happen, optionally as a rehearsal (dry run), then cast.
6. **Casting**: output streams into the window. Prompts appear as dialogs, and sudo asks for your
   password once, up front.
7. **Complete**: a summary of each step, plus a restart prompt if an update changed conjure
   itself.

It's animated: a twinkling hat, a sparkle that runs down the step rail, a crystal ball while it
fetches, a scene for each stage while casting (a cauldron for packages, a neural net for models,
and so on), and a burst, a puff of smoke or a dissolve at the end. `--calm` (or `CONJURE_CALM=1`,
or `TERM=dumb`) turns all of it off.

Everything the wizard does can also be scripted with the commands below.

**Models** have their own tab in the wizard's spellbook. Each model in `models.yaml` is listed with
its size and whether it's already pulled ([models](local-models/models.md)):
- Models you've already pulled are ticked by default, so every install, update or Mend checks them
  for updates (a quick manifest check).
- New models are only downloaded if you tick them.
- While pulling, the download bar shows live under the progress bar.

From a script: `scripts/dotfiles models [--runtime ollama|omlx] [names]`.

The extras are not part of a plain `install`. Select them in the wizard or pass `--extras`:
`devbox:core|fullstack|all` builds the [devbox](tools/devbox.md) images, and `models`,
`models:omlx` or `models:ollama` pull every listed model for those runtimes.

> [!WARNING]
> **Ollama under WSL belongs on Windows.** From WSL, models are pulled into Ollama on Windows
> through `ollama.exe`. Ollama on Windows uses the GPU through the Windows driver, whereas WSL's
> GPU passthrough depends on the driver and WSL versions matching and can break after updates. It
> also means one model store and one server on `localhost:11434`. A Linux
> `ollama` inside WSL is never used. It would keep a second copy of every model, and with mirrored
> networking it would compete for the same port, so the installer warns if it finds one and skips
> the `ollama` package there. Tools in WSL reach Windows Ollama at `localhost:11434` only with
> `networkingMode=mirrored` in `.wslconfig`; the pull warns if it can't connect, and suggests an
> update if Ollama is too old for a model.

## Windows with WSL

On Windows, `scripts\bootstrap.ps1` checks for WSL 2.9.3+ (needed for [wslc](tools/wslc.md)),
installs uv with winget (for `devbox.ps1`) and lists your distros. Then, **inside the distro**:

```sh
git clone <this repo> ~/.dev-config && cd ~/.dev-config     # the Linux filesystem, not /mnt/c
./scripts/bootstrap.sh --dry-run     # git, curl, zsh via dnf/apt (sudo) -> uv -> install
./scripts/bootstrap.sh
chsh -s "$(command -v zsh)"
```

> [!WARNING]
> **Keep the clone inside the distro.** A clone under `/mnt/c` is slow, the links cross
> filesystems, and drvfs makes every directory look world-writable, which trips zsh's compinit
> check (the config skips it there, so you lose that check). `dotfiles doctor` warns about this.
>
> System package installs ask for sudo once per run (`--yes` approves).

## Take only some of it

```sh
scripts/dotfiles install --dry-run                       # full plan
scripts/dotfiles link --only zsh,starship                # just the shell
scripts/dotfiles install --only packages,agents          # tools and coding agents
scripts/dotfiles install --skip ssh,git                  # everything except these
```

Modules: `packages`, `repos`, `zsh`, `starship`, `ssh`, `git`, `ghostty`, `gh`, `mise`, `zed`, `agents`.
Or just copy a single file out of `config/`; each stands alone.

## What it does to your files

- Existing files are **moved** to `~/.config-backups/<timestamp>/` (with a `manifest.tsv`) before a
  symlink replaces them. Nothing is deleted.
- Re-running changes nothing that is already right.
- `scripts/dotfiles uninstall` removes the links and restores the backups.

## Packages and where they come from

`packages.yaml` lists each tool with ordered sources (Homebrew formula, DMG, pkg, dnf/apt, vendor
script, or a manual link). Only the sources for this OS and distro are tried (`os:` on a package
or source). Casks are off by default because they fail on some managed Macs; DMGs are verified by
`sha256` and Apple Team ID.

```sh
scripts/dotfiles packages --check          # what is installed / missing
scripts/dotfiles packages ghostty --prefer dmg
```

Turn casks on, exclude tools or reorder sources for one machine in `local/packages.local.yaml`:

```yaml
defaults: {brew_casks: true}
exclude: [docker-desktop]
prefer: [brew, dmg]
```

## Private and machine-specific settings

Everything under `local/` is git-ignored except `README.md` and `*.example` templates:

| You want to | Put it in |
|---|---|
| Real ssh hosts | `local/ssh.d/<name>` (linked into `~/.ssh/config.d/`) |
| Shell tweaks for this Mac | `local/zshrc.local`, `zshenv.local`, `zprofile.local` |
| A corporate CA for container builds | `local/certificates/*.crt` |
| A proxy for container builds | `local/proxy/tinyproxy.conf` |
| API keys used by agent config | `local/agents.env` |
| Package overrides | `local/packages.local.yaml` |
| Private plugins for an agent | `local/agents.<agent>.yaml` |

## Checking and updating

```sh
scripts/dotfiles doctor          # links, packages, nothing private tracked under local/
scripts/dotfiles update --check  # commits behind the upstream (exit 1 if behind)
scripts/dotfiles update          # show incoming changes, fast-forward, re-apply your selection
uv run pytest                    # the installer's tests
```

Every install records what was selected and the commit it came from in
`~/.local/state/dotfiles/install.json`. `update` fetches first and lists the incoming commits, the
changed files and the modules they touch. After you confirm, it fast-forwards and re-applies that
saved selection; `--only` or `--skip` overrides it for one run. Extras re-run only when their
inputs changed: devbox images when `devcontainers/` changes, models when the installer does.
`update` refuses to pull over local edits to tracked files or a branch that has diverged. If the
pull changes the installer itself, it restarts on the new code before re-applying.

## Where next

[Tools](tools/zsh.md) · [Local models](local-models/apple-silicon-basics.md) ·
[Agents](agents/claude-code.md) · [Models](local-models/models.md)
