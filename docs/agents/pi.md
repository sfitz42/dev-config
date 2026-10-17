# Pi

**Last reviewed: 2026-10-16.** Manifest: `agents/pi/agent.yaml`. Sync with
`scripts/dotfiles agents --only pi`. Pi 1.3.0 when reviewed.

**Platform:** any Unix (macOS and Linux).

> [!NOTE]
> **Beyond macOS**
>
> Pi and its config are platform-neutral. The local provider in `models.json` points at oMLX, which is
> macOS-only; on another platform point `baseUrl` at whatever OpenAI-compatible server you run.

Pi is a small terminal coding agent (read, write, edit, bash tools). It talks to any
OpenAI-compatible endpoint, which makes it the natural front end for a local model.

## What this repo manages

| Thing | How |
|---|---|
| The CLI | `packages.yaml` → vendor script `https://pi.dev/install.sh` (unpinned), installs to `~/.local/bin/pi` |
| Settings | `agents/pi/settings.json` merged into `~/.pi/agent/settings.json`: default provider `omlx`, default model `Qwen3.6-35B-A3B-4bit` |
| Providers and models | `agents/pi/models.json.tmpl` rendered to `~/.pi/agent/models.json` |
| Extensions | `extensions:` in the manifest, installed with `pi install` (none yet) |

## The local provider

`models.json` points Pi at oMLX: base URL `http://127.0.0.1:8000/v1`, OpenAI-completions API, and
the model's declared context window (262,144 tokens) and max output (32,768). The API key is not in the
template: it is `${OMLX_API_KEY}`, filled from the environment or the untracked `local/agents.env`.
If the key is missing the sync leaves your existing file untouched and says so.

Check the context window against the server's own limit; see
[quantisation and memory](../local-models/quantisation-and-memory.md#context-length-costs-memory).

## Extensions

Pi installs extensions from npm or git, and **pins** a version by adding it to the source:

```sh
pi install npm:@scope/pi-tools@1.2.3            # npm, pinned to 1.2.3
pi install git:github.com/owner/pi-ext@v1       # git, pinned to a tag or commit
pi install npm:@scope/pi-tools                  # unpinned (floats)
pi list                                         # installed packages and their pinned source
pi update --extensions                          # update installed packages
pi remove <source>
```

Pi's docs say versioned npm specs and git tags/commits are pinned, and that updating a git package
does not move a configured ref. They do not say whether `pi update --extensions` skips a pinned npm
package, so check `pi list` after an update. Pi records the pinned string in `packages` in
`~/.pi/agent/settings.json`; `pi list` shows the same string.

To make them reproducible, list the sources, pinned, in `agents/pi/agent.yaml`:

```yaml
extensions:
  - npm:pi-claude-marketplace@0.20.1
```

`scripts/dotfiles agents` runs `pi install` for any whose exact source string `pi list` does not
show. Browse packages at <https://pi.dev/packages>.

> [!WARNING]
> Packages can execute code and influence the agent. Pin a version, and skim the source before
> installing: `npm pack <pkg>@<version> --ignore-scripts` into a scratch directory, read it, and
> check its dependencies for install-time scripts.

### Installed: `pi-claude-marketplace`

[`pi-claude-marketplace`](https://pi.dev/packages/pi-claude-marketplace) (0.20.1, MIT) lets Pi use
**Claude Code plugin marketplaces**: commands, skills, agents, MCP servers and (partly) hooks. It is
the route to the same `defra-aice` plugins that Claude Code gets. In a Pi session it is driven with
`/claude:plugin ...` and `/reload`.

> [!NOTE]
> **What I checked before installing** · reviewed 2026-10-16
>
> - No install-time scripts in the package or in its 65 dependencies.
> - Clones over HTTPS only; no `eval`/dynamic code loading.
> - It calls `git credential fill/approve/reject`, so it can read and store git credentials in the
>   macOS keychain.
> - It bridges plugin **hooks**: shell commands a plugin declares will run inside Pi, so only add
>   marketplaces you trust.
> - Agents need the optional `pi-subagents`; its README names `pi-mcp-adapter` as the optional MCP
>   companion. Pi now has native MCP, so check whether the adapter is still needed.
>
> This was a skim of the source, not a full audit.

## Running

```sh
pi                       # uses the default provider/model from settings
omlx launch pi           # starts it against the oMLX server (configures it for you)
pi --model <pattern>     # pick a model for this run
```

> [!WARNING]
> **Gotchas**
>
> - `~/.pi/agent/auth.json` and sessions are never tracked.
> - `pi` needs `node` on `PATH`. mise provides it in interactive shells; in a bare environment (a
>   script, a GUI-launched tool) `pi` fails with `env: node: No such file or directory`. When
>   `pi list` fails, the sync skips extensions with a warning instead of reinstalling.
> - The sync matches the exact source string in `pi list` output, pinned version included; if Pi
>   changes that output format, a package could be reinstalled (harmless but noisy).
