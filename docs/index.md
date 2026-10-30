# Docs

How I set up and use my machines: a Mac, and a Windows PC through WSL. Start with
[getting started](getting-started.md), which also covers the [wizard](getting-started.md#the-wizard-).

## Tools
[zsh](tools/zsh.md) · [Starship](tools/starship.md) · [Ghostty](tools/ghostty.md) ·
[Zed](tools/zed.md) · [Neovim](tools/neovim.md) · [gh and gh-stack](tools/gh-stack.md) ·
[Apple container](tools/apple-container.md) · [WSL containers](tools/wslc.md) · [devbox](tools/devbox.md)

## Local models
[The basics on Apple silicon](local-models/apple-silicon-basics.md) · [Quantisation and memory](local-models/quantisation-and-memory.md) ·
[Runtimes](local-models/runtimes.md) · [oMLX](local-models/omlx.md) · [Models (oMLX and Ollama)](local-models/models.md) ·
[Ollama under WSL](getting-started.md#local-models-and-extras)

## Coding agents
[Claude Code](agents/claude-code.md) · [Pi](agents/pi.md) ·
[Local versus hosted](agents/local-vs-hosted.md) · [Manifest format](../agents/schema.md)

## Platforms

Each page opens with a **Platform** line. The installer supports macOS and Linux (including WSL,
tested on Fedora 43), and `devbox` runs on Apple `container` or WSL's `wslc`. The Mac-specific
parts (Homebrew paths, DMG installs, Apple `container`, MLX/oMLX) are named in each page's
"Beyond macOS" panel. Under WSL, GUI apps and Ollama run on the Windows side.

## How to read the panels

Advice and gotchas live inline next to the facts they are about, in GitHub alert panels:

> [!TIP]
> Practical advice that follows from the facts around it.

> [!WARNING]
> Gotchas: things that bite.

## Reading this repo

- `config/`: shell and app config, organised by app
- `agents/`: per-assistant manifests (settings, marketplaces, plugins, extensions)
- `devcontainers/`: dev container images and the `devbox` launcher
- `pi-extensions/`: audited Pi extensions, reimplemented here
- `scripts/` and `src/dotfiles/`: the installer, and the wizard in `src/dotfiles/wizard/`
- `packages.yaml`, `links.yaml`, `models.yaml`: what gets installed, linked and pulled
- `local/`: untracked, per-machine overrides
