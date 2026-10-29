# dev-config

Dev setup in one repo: shell and app config, an idempotent installer, coding-agent setup
(Claude Code and Pi, with plugins opt-in), dev containers, and notes on running local models.
Built to be taken in pieces.

```sh
git clone <this repo> ~/.dev-config && cd ~/.dev-config
./scripts/bootstrap.sh --dry-run      # preview, changes nothing
./scripts/bootstrap.sh                # Command Line Tools -> Homebrew -> uv -> the wizard
```

After that, `scripts/dotfiles` (or `uv run conjure`) opens **conjure** 🪄, an interactive installer
that detects the platform, lets you choose what to install and handles updates. Every step is
also a plain command for scripts: `scripts/dotfiles install|update|doctor …`
([getting started](docs/getting-started.md#the-wizard-)).

Linux and WSL use the same two commands (dnf/apt instead of Homebrew; clone inside the distro). On
Windows, `scripts\bootstrap.ps1` checks WSL and installs uv, and `devbox` runs on
[WSL containers](docs/tools/wslc.md). See [getting started](docs/getting-started.md#windows-with-wsl).

Existing files are backed up to `~/.config-backups/` before anything is replaced;
`scripts/dotfiles uninstall` puts them back.

| | |
|---|---|
| `config/` | zsh (split into modules), Starship, ssh, git, Ghostty, Zed, gh, mise |
| `agents/` | per-assistant manifests: settings, marketplaces, plugins, extensions |
| `pi-extensions/` | Pi extensions audited and reimplemented here instead of installed from npm ([how](pi-extensions/README.md)) |
| `devcontainers/` | dev container images and the `devbox` launcher (Apple `container` or WSL `wslc`) |
| `packages.yaml` | every tool, with ordered install sources (brew, DMG, pkg, dnf/apt, script) |
| `local/` | git-ignored overrides for hosts, keys, proxies and certificates |
| `docs/` | how I use it all, including [local models](docs/local-models/apple-silicon-basics.md) and my dated [model assessments](docs/local-models/models.md) |

## Tools

Everything `packages.yaml` installs, with where it is documented. Tools without a page of their own
link to the page that covers them.

| Area | Tool | Docs |
|---|---|---|
| Shell | zsh with Oh My Zsh | [zsh](docs/tools/zsh.md) |
| | Starship (prompt) | [Starship](docs/tools/starship.md) |
| | Ghostty (terminal) | [Ghostty](docs/tools/ghostty.md) |
| | MesloLGS NF (Nerd Font) | [Starship](docs/tools/starship.md), [Ghostty](docs/tools/ghostty.md) |
| | ripgrep, fd | [Neovim](docs/tools/neovim.md#prerequisites-on-a-fresh-mac) |
| | jq | [devbox](docs/tools/devbox.md) (used inside the images) |
| Editors | Neovim | [Neovim](docs/tools/neovim.md) |
| | Zed | [Zed](docs/tools/zed.md) |
| Git and GitHub | gh, gh-stack | [gh and gh-stack](docs/tools/gh-stack.md) |
| Runtimes | mise (Node, Python) | [zsh: runtimes](docs/tools/zsh.md#node-and-python-runtimes) |
| | uv (runs the installer) | [Getting started](docs/getting-started.md) |
| Containers | Apple `container` | [Apple container](docs/tools/apple-container.md) |
| | WSL containers (`wslc`, Windows) | [wslc](docs/tools/wslc.md) |
| | devbox, tinyproxy | [devbox](docs/tools/devbox.md), [proxy notes](devcontainers/README.md#proxy) |
| | Docker Desktop | [Apple container](docs/tools/apple-container.md) |
| Local models | oMLX | [oMLX](docs/local-models/omlx.md), [models](docs/local-models/models.md) |
| Coding agents | Claude Code | [Claude Code](docs/agents/claude-code.md) |
| | Pi | [Pi](docs/agents/pi.md) |

Start with [docs/getting-started.md](docs/getting-started.md). Take just one piece with, for
example, `scripts/dotfiles link --only zsh`, or copy a file out of `config/`.
