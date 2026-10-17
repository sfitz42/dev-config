# Docs

How I set up and use this Mac. Start with [getting started](getting-started.md).

## Tools
[zsh](tools/zsh.md) · [Starship](tools/starship.md) · [Ghostty](tools/ghostty.md) ·
[Zed](tools/zed.md) · [Neovim](tools/neovim.md) · [gh and gh-stack](tools/gh-stack.md) ·
[Apple container](tools/apple-container.md) · [WSL containers](tools/wslc.md) · [devbox](tools/devbox.md)

## Local models on Apple silicon
[The basics](local-models/apple-silicon-basics.md) · [Quantisation and memory](local-models/quantisation-and-memory.md) ·
[Runtimes](local-models/runtimes.md) · [oMLX](local-models/omlx.md) · [Models](local-models/models.md)

## Coding agents
[Claude Code](agents/claude-code.md) · [Pi](agents/pi.md) ·
[Local versus hosted](agents/local-vs-hosted.md) · [Manifest format](../agents/schema.md)

## Platforms

Each page opens with a **Platform** line. The installer supports macOS and Linux (including WSL,
tested on Fedora 43), and `devbox` runs on Apple `container` or WSL's `wslc`. The Mac-specific
parts (Homebrew paths, DMG installs, Apple `container`, MLX/oMLX) are named in each page's
"Beyond macOS" panel.

## How to read the panels

Opinions live inline next to the facts they are about, in GitHub alert panels:

> [!NOTE]
> **My take** · reviewed 2026-10-16: a personal assessment. It carries its own review date and goes
> stale; trust the date.

> [!TIP]
> Practical advice that follows from the facts around it.

> [!WARNING]
> Gotchas: things that bite.

## Reading this repo

- `config/`: shell and app config, organised by app
- `agents/`: per-assistant manifests (settings, marketplaces, plugins, extensions)
- `devcontainers/`: dev container images and the `devbox` launcher
- `scripts/` and `src/dotfiles/`: the installer
- `packages.yaml`, `links.yaml`: what gets installed and linked
- `local/`: untracked, per-machine overrides
