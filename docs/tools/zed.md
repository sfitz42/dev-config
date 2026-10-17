# Zed

**Last reviewed: 2026-10-16.** Config: `config/zed/settings.json` (copied once to `~/.config/zed/settings.json`).

**Platform:** macOS and Linux; the install steps below are macOS.

> [!NOTE]
> **Beyond macOS**
>
> Zed also runs on Linux, where settings live under `~/.config/zed/` (check Zed's docs for your
> version). The DMG install is macOS-only. The copy-not-link reasoning for `settings.json` applies on
> any platform.

## What it is

My editor for project work and for editing inside dev containers over SSH. Settings kept: One
Dark/One Light themes, VS Code base keymap, Copilot for edit predictions, the GitHub Copilot CLI as
an agent server, and the terminal font (MesloLGS NF).

## Why it is copied, not linked

Zed rewrites `settings.json` itself, including `ssh_connections` (which hold private hosts and key
paths). A symlink would let those leak into the repo, so the installer copies the file once and then
leaves it alone. The tracked copy deliberately has no `ssh_connections`.

## Editing a dev container

```sh
devbox ssh-config --install      # writes ~/.ssh/config.d/devbox-<project>
# Zed: Connect via SSH -> devbox-<project> -> open /home/dev/workspace
```

See [devbox](devbox.md). Setting `"upload_binary_over_ssh": true` on the connection makes Zed push its
remote server from the Mac, so the container needs no internet for it.

## Installing

DMG, pinned in `packages.yaml`. The `zed` CLI is at `~/.local/bin/zed` (`z.` alias opens the current
directory).
