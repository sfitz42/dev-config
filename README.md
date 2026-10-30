# dev-config

Dev setup in one repo: shell and app config, an idempotent installer with an interactive wizard,
coding-agent setup (Claude Code and Pi, with plugins opt-in), local models (oMLX and Ollama), dev
containers, and notes on running models locally. Built to be taken in pieces.

```sh
git clone <this repo> ~/.dev-config && cd ~/.dev-config
./scripts/bootstrap.sh --dry-run      # preview, changes nothing
./scripts/bootstrap.sh                # Command Line Tools -> Homebrew -> uv -> the wizard
```

Linux and WSL use the same two commands (dnf/apt instead of Homebrew; clone inside the distro). On
Windows, `scripts\bootstrap.ps1` checks WSL and installs uv, and `devbox` runs on
[WSL containers](docs/tools/wslc.md). See [getting started](docs/getting-started.md#windows-with-wsl).

## The wizard

`scripts/dotfiles` with no command (or `scripts/dotfiles wizard`, or `uv run wizard`) opens the
**dev-config Setup Wizard** 💾, a step-by-step installer in the terminal, done in the style of a
2000s Windows setup wizard:

1. It detects the platform: OS, distro, arch, package manager, container runtime, and Ollama
   (on Windows, when you're in WSL).
2. You pick a setup type: *Typical*, the recommended setup, or *Custom*, where you tick
   packages, config, agents, models and extras one by one. Anything that doesn't apply to this
   machine is greyed out with the reason.
3. You review it, optionally as a simulation (dry run), then click Install. Output streams live,
   prompts appear as dialogs, and sudo asks for your password once.

Run it again after an install and you get Program Maintenance: modify, update, repair (re-apply,
then check), or remove. Updates show the incoming commits and the components they touch before
fast-forwarding, then re-apply what you installed. It's animated; `--calm` (or
`DEVCONFIG_CALM=1`) turns that off, and `--demo` plays the installing page with pretend output
so you can watch it without installing anything. More in
[getting started](docs/getting-started.md#the-wizard-).

## Scripted

Everything the wizard does is also a plain command, through `scripts/dotfiles` or `uv run dotfiles`:

```sh
scripts/dotfiles install --dry-run                 # everything, previewed
scripts/dotfiles install --only zsh,git            # just some modules
scripts/dotfiles update --check                    # commits behind (exit 1 if behind)
scripts/dotfiles update                            # show changes, fast-forward, re-apply
scripts/dotfiles models --runtime ollama           # pull the models in models.yaml
scripts/dotfiles doctor                            # check links, packages, local/
scripts/dotfiles uninstall                         # remove links, restore backups
```

Existing files are backed up to `~/.config-backups/` before anything is replaced; `uninstall`
puts them back. What you installed, and from which commit, is recorded in
`~/.local/state/dotfiles/install.json`, so `update` re-applies the same selection.

## What's here

| | |
|---|---|
| `config/` | zsh (split into modules), Starship, ssh, git, Ghostty, Zed, gh, mise |
| `agents/` | per-assistant manifests: settings, marketplaces, plugins, extensions |
| `pi-extensions/` | Pi extensions audited and reimplemented here instead of installed from npm ([how](pi-extensions/README.md)) |
| `devcontainers/` | dev container images and the `devbox` launcher (Apple `container` or WSL `wslc`) |
| `packages.yaml` | every tool, with ordered install sources (brew, DMG, pkg, dnf/apt, script) |
| `links.yaml` | which config files are linked where, one module per app |
| `models.yaml` | local models to pull, per runtime (oMLX on Apple silicon, Ollama anywhere) |
| `src/dotfiles/` | the installer (Python, run through uv) and the wizard (`wizard/`, Textual) |
| `scripts/` | `bootstrap.sh`/`.ps1` for a fresh machine, and `dotfiles`, the entry point |
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
| Local models | oMLX (Apple silicon) | [oMLX](docs/local-models/omlx.md), [models](docs/local-models/models.md) |
| | Ollama (optional; under WSL, the Windows install is used) | [models](docs/local-models/models.md#ollama-any-platform), [WSL note](docs/getting-started.md#local-models-and-extras) |
| Coding agents | Claude Code | [Claude Code](docs/agents/claude-code.md) |
| | Pi | [Pi](docs/agents/pi.md) |

Start with [docs/getting-started.md](docs/getting-started.md). Take just one piece with the
wizard's Custom setup, with `scripts/dotfiles link --only zsh`, or by copying a file out of
`config/`.
