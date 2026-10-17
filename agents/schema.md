# Agent manifests

Each coding assistant has a folder with an `agent.yaml`. `scripts/dotfiles agents` reads them all
(or `--only claude`) and makes the machine match. Everything is idempotent: it only changes what
differs, snapshots a file into `~/.config-backups/` before changing it, and supports `--dry-run`.

```yaml
agent: pi                         # name, used by --only and local/agents.pi.yaml

install: {package: pi}            # a package from packages.yaml; installed if missing

settings:                         # keys merged into the app's own settings file (JSON)
  file: agents/pi/settings.json   #   repo file holding ONLY the keys you want managed
  target: ~/.pi/agent/settings.json   # other keys in the target are left alone

models:                           # a file rendered from a template (secrets come from the environment)
  template: agents/pi/models.json.tmpl
  target: ~/.pi/agent/models.json
  env: [OMLX_API_KEY]             # taken from the environment or local/agents.env; if any is
                                  #   missing the file is left untouched with a warning

links:                            # same entry kinds as links.yaml (skills, commands, instructions)
  - {src: agents/claude/CLAUDE.md, dst: ~/.claude/CLAUDE.md}

marketplaces:                     # claude only. Adding one does NOT install its plugins
  - {name: claude-plugins-official, source: anthropics/claude-plugins-official}
  - {name: defra-aice, source: DEFRA/aice-team, install_all: true}   # opt in: install everything it publishes
plugins:                          # claude only: explicit opt-ins, plugin@marketplace
  - code-review@claude-plugins-official

extensions:                       # pi only: sources exactly as `pi install <source>` takes them
  - npm:@scope/pi-tools
  - git:github.com/owner/pi-extension
```

## Plugins are opt-in

A marketplace only makes plugins *available*. A plugin is installed when it is listed under
`plugins`, or when its marketplace sets `install_all: true` (read from the marketplace's own
`marketplace.json` once it has been added). Leave the flag off for any marketplace you only want to
browse.

## Local overrides

`local/agents.<agent>.yaml` (git-ignored) is merged over the tracked file: lists are appended, dicts
are merged. Use it for private marketplaces or extensions. Secrets for `models.env` go in
`local/agents.env` as `NAME=value` lines (never committed).

## Never touched

Auth files, session history, caches, and `managed-settings.json` (organisation policy).

## Inspecting a machine

`scripts/dotfiles agents --export` prints what each CLI reports as installed, to seed or check a manifest.
