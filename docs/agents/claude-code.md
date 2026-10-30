# Claude Code

**Last reviewed: 2026-10-30.** Manifest: `agents/claude/agent.yaml`. Sync with
`scripts/dotfiles agents --only claude`.

**Platform:** any Unix (macOS and Linux).

> [!NOTE]
> **Beyond macOS**
>
> The manifest, settings merge and plugin rules are platform-neutral. Only `omlx launch claude` (local
> models through oMLX) is macOS-specific.

## What this repo manages

| Thing | How |
|---|---|
| The CLI | `packages.yaml` → vendor install script (unpinned; the vendor URL moves) |
| Settings | `agents/claude/settings.json` is **merged** into `~/.claude/settings.json`: only `model` and `theme` are managed; every other key is left alone. A snapshot goes to `~/.config-backups/` before any change |
| Marketplaces | `claude-plugins-official`, `defra-aice` (`DEFRA/aice-team`) and `defra-ai-plugins` (`DEFRA/defra-ai-plugins`) |
| Plugins | Opt-in (see below) |
| Skills, commands, `CLAUDE.md` | Supported via `links:` in the manifest; none are tracked yet (my personal skills stay untracked until they have a git remote) |

## Install on a new machine

In the wizard, tick **🤖 Agents → claude** (on by default), or run it directly:

```sh
scripts/dotfiles agents --only claude --dry-run   # preview
scripts/dotfiles agents --only claude             # install CLI, settings, marketplaces, plugins
```

Then restart Claude Code and sign in; auth is never touched.

Never touched: login/auth, history, sessions, caches, and the organisation-managed
`/Library/Application Support/ClaudeCode/managed-settings.json`.

## Plugins are opt-in

Adding a marketplace only makes its plugins *available*. A plugin is installed when it is listed under
`plugins:` (as `plugin@marketplace`), or when its marketplace sets `install_all: true`. Only
`defra-aice` does:

| Plugin (from `defra-aice`) | Purpose |
|---|---|
| `aice-python` | Python style guide skill, code writer and reviewer agents |
| `aice-javascript` | JavaScript style, testing, design-language and review standards |
| `aice-github-actions` | GitHub Actions style guide |

Because of `install_all`, plugins the AICE team adds later are installed on the next sync.

`defra-ai-plugins` is added as a marketplace only; these are the plugins I opt in to under `plugins:`:

| Plugin (from `defra-ai-plugins`) | Purpose |
|---|---|
| `ticket-writer` | JIRA story and task ticket writing |
| `defra-shared` | Branching, commit messages, quality gates, security/PII and accessibility skills |

Others it publishes (for example `frontend-developer`) can be added the same way. To opt in to a
single plugin from any marketplace, add it to `plugins:`:

```yaml
plugins:
  - code-review@claude-plugins-official
```

## Everyday commands

```sh
claude plugin list                       # what is installed
claude plugin marketplace list
scripts/dotfiles agents --dry-run        # what a sync would change
scripts/dotfiles agents --export         # what each CLI reports, to seed a manifest
```

Aliases: `c` = `claude`, `cr` = `claude -r` (resume a session).

## Using Claude Code with a local model

`omlx launch claude` configures Claude Code to talk to the local oMLX server instead of the hosted
API (see [oMLX](../local-models/omlx.md)). See [local vs hosted](local-vs-hosted.md) for when I would.

## Private additions

Put private marketplaces or plugins in `local/agents.claude.yaml` (git-ignored); it is merged over the
tracked manifest.

> [!WARNING]
> **Gotchas**
>
> - Plugins can run code and shape agent behaviour. Only enable marketplaces you trust.
> - A new plugin applies after restarting Claude Code.
