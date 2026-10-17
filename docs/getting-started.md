# Getting started

**Platform:** written for macOS; most of the config is portable.

> [!NOTE]
> **Beyond macOS**
>
> Today `bootstrap.sh` and the package sources (`dmg`, `pkg`, `app:` checks) are macOS-only. The rest of
> the installer is plain Python: with `uv` installed, `scripts/dotfiles link` and `scripts/dotfiles agents`
> should work on Linux too (not tested there). Everything under `config/` can be copied by hand on any
> Unix.

## Fresh Mac

```sh
git clone <this repo> ~/.dev-config && cd ~/.dev-config
./scripts/bootstrap.sh --dry-run     # see everything it would do
./scripts/bootstrap.sh               # Command Line Tools -> Homebrew -> uv -> install
```

`bootstrap.sh` is the only bash; once `uv` exists, everything else is Python
(`scripts/dotfiles`). It is safe to re-run.

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

`packages.yaml` lists each tool with ordered sources (Homebrew formula, DMG, pkg, vendor script, or a
manual link). Casks are off by default because they fail on some managed Macs; DMGs are verified by
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
scripts/dotfiles update          # git pull, then install what is missing
uv run pytest                    # the installer's tests
```

## Where next

[Tools](tools/zsh.md) · [Local models](local-models/apple-silicon-basics.md) ·
[Agents](agents/claude-code.md) · [Models](local-models/models.md)
