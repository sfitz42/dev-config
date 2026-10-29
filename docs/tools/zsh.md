# zsh

**Last reviewed: 2026-10-16.** Config: `config/zsh/`. Installed by `scripts/dotfiles link --only zsh`.

**Platform:** any Unix (macOS and Linux).

> [!NOTE]
> **Beyond macOS**
>
> Everything here works on Linux with zsh and git installed. The macOS-specific parts are small:
> `.zprofile` looks for Homebrew at `/opt/homebrew` (it is skipped when absent), and `ce`, `cls` and
> `container-reset` wrap Apple's `container`.

## What it is

Oh My Zsh as a plugin loader (no theme), Starship for the prompt, and a handful of aliases and
functions. It is split into small files so you can take pieces rather than all of it.

| File | Read by | What it does |
|---|---|---|
| `.zshenv` | every zsh | Resolves `$DOTFILES` and `$ZSH_CONFIG_DIR` (through symlinks), puts `~/.local/bin` on `PATH`, sets `EDITOR` (nvim, else vi) |
| `.zprofile` | login shells | Homebrew `shellenv`, Docker Desktop CLI path (only if installed) |
| `.zshrc` | interactive | Thin: sources the modules below in order, then Starship, then mise |
| `completions.zsh` | `.zshrc` | Adds `completions/` to `fpath` (must run before `compinit`) |
| `plugins.zsh` | `.zshrc` | Oh My Zsh with `git`, `zsh-autosuggestions`, `zsh-syntax-highlighting` (kept last) |
| `options.zsh` | `.zshrc` | History size, `hist_ignore_space` |
| `aliases.zsh` | `.zshrc` | See below |
| `functions.zsh` | `.zshrc` | See below |

Load order matters: completions (fpath) → plugins (runs `compinit`) → options → aliases → functions →
prompt → runtimes → `local/zshrc.local`.

## Using one piece

Each file stands alone. To adopt only the aliases, copy `aliases.zsh` and `source` it. To adopt
the plugin loading, take `plugins.zsh` (it falls back to bare `compinit` plus Homebrew plugin copies
if Oh My Zsh is absent).

## Aliases and functions

| Name | Does |
|---|---|
| `ll`, `la` | `ls -lh`, `ls -lAh` |
| `c`, `cr` | `claude`, `claude -r` (resume) |
| `z.` | `zed .` |
| `ce`, `cls` | `container exec -it`, `container list --all` |
| `ez [file]`, `es`, `ess` | edit the zsh config, the Starship config, the ssh config |
| `reload` | `exec zsh -l` |
| `container-reset` | Kill Apple `container`'s helper processes after asking (see [apple-container](apple-container.md)) |

## Prompt, transient prompt

Starship draws the prompt ([starship](starship.md)). A small `zle` widget in `.zshrc` collapses each
finished prompt to just the `❯` character, which keeps scrollback readable.

## Node and Python runtimes

[mise](https://mise.jdx.dev) provides them and is activated in `.zshrc`. Global versions are in
`config/mise/config.toml` (Node LTS); a project's own `mise.toml`, `.tool-versions` or `.nvmrc`
overrides them. nvm is no longer used on the Mac (the dev container images still use it). Moving off
nvm, whose eager loading was the bulk of shell startup, took the shell from about 0.29s to about 0.09s.

## Machine-specific settings

Not committed. Create any of these in `local/` (see `local/zshrc.local.example`):
`zshenv.local`, `zprofile.local`, `zshrc.local`, `plugins.local.zsh`.

> [!WARNING]
> **Gotchas**
>
> - `.zshenv` runs for every zsh, scripts included, so it stays tiny and has no output.
> - Oh My Zsh's own updater is set to "reminder"; update it with `omz update`. The installer only
>   clones it when missing: `scripts/dotfiles update` updates this repo, not Oh My Zsh.
> - `~/.zshrc` is a symlink into the repo. Tools that append to it (Docker Desktop installers, for example)
>   will write into the repo file; move such lines to `local/zshrc.local` instead.
