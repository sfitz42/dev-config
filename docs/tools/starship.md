# Starship

**Last reviewed: 2026-10-16.** Config: `config/starship/starship.toml` (linked to `~/.config/starship.toml`).

**Platform:** any Unix (macOS and Linux).

> [!NOTE]
> **Beyond macOS**
>
> Nothing here is macOS-specific. On Linux, install Starship from your package manager or its
> install script, and use a Nerd Font in your terminal.

## What it is

A two-line prompt with powerline-style caps: OS icon, user, directory (repo root highlighted),
git branch and status, language versions (Node, Python, Rust, Go and others, shown only when
relevant), then a fill, command duration, and the time. The palette is **Catppuccin Frappe**, defined
at the bottom of the file, matching the Ghostty theme.

## Using it

```sh
brew install starship          # or: scripts/dotfiles packages starship
# zsh: eval "$(starship init zsh)"   (done in config/zsh/.zshrc)
starship print-config          # the effective config
```

To take just the look: copy `starship.toml`. It needs a Nerd Font in the terminal (MesloLGS NF here;
installed via `packages.yaml`).

## One copy, two places

The same file is used on the Mac and inside the dev container images. `devcontainers/build.sh` stages
it into the build context, so there is a single source of truth.

> [!WARNING]
> **Gotchas**
>
> - Without a Nerd Font the icons render as boxes.
> - `$directory` and the language modules use `fg:crust` text on coloured backgrounds; switching
>   palette means editing the `[palettes.*]` block and the `palette = ...` line only.
> - Command-duration notifications are enabled for commands longer than 45 seconds.
