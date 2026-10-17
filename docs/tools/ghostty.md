# Ghostty

**Last reviewed: 2026-10-16.** Config: `config/ghostty/config` (linked to `~/.config/ghostty/config`).

**Platform:** macOS and Linux; the install steps below are macOS.

> [!NOTE]
> **Beyond macOS**
>
> The config file is the same on Linux (`~/.config/ghostty/config`). Only the DMG install, and the
> pinned `packages.yaml` entry for it, are macOS-specific; on Linux use your distribution's package or
> Ghostty's build instructions.

The terminal. The whole config is one line, `theme = Catppuccin Frappe`, which matches the
Starship palette. Everything else is Ghostty's defaults.

## Installing

Ghostty is installed from its notarized DMG, not Homebrew (casks fail on this Mac). `packages.yaml`
pins the DMG URL, its `sha256` and the Apple Team ID; the installer verifies all of it before
copying `Ghostty.app` to `/Applications`.

```sh
scripts/dotfiles packages ghostty          # install (skips if present)
ghostty +list-themes                       # browse themes
ghostty +show-config                       # effective config
```

> [!WARNING]
> **Gotchas**
>
> - Set the terminal font to a Nerd Font (MesloLGS NF) or the Starship icons will not render.
> - Updating means bumping the URL and `sha256` in `packages.yaml`; the app also updates itself.
