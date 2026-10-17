# devbox

**Last reviewed: 2026-10-17.** Code: `src/dotfiles/devbox/` (Python, run through uv by the
`devcontainers/devbox/devbox` and `devbox.ps1` shims). Full reference:
[`devcontainers/README.md`](../../devcontainers/README.md).

**Platform:** macOS with [Apple `container`](apple-container.md), and Windows (or a WSL distro) with
[`wslc`](wslc.md). The images are ordinary Linux.

> [!NOTE]
> **Beyond macOS**
>
> On Windows, devbox drives `wslc`. Everything works except Docker inside the container and
> ssh-agent forwarding into `devbox shell`; [wslc](wslc.md) explains why. Plain Linux has no
> supported runtime yet. The Dockerfiles should build with Docker or Podman there, but that is not
> tested.

One **persistent container per project**, with sshd for editors and named volumes for the state
that matters. Docker-in-container is available on Apple `container` only.

```sh
cd ~/projects/my-app             # Windows: cd C:\src\my-app; ...\devbox.ps1 up
devbox up                        # create + start "devbox-my-app"
devbox shell                     # zsh in the project (mounted at ~/workspace)
devbox ssh-config --install      # writes ~/.ssh/config.d/devbox-my-app, for Zed / ssh
devbox stop                      # state is kept
devbox down                      # delete the container, keep volumes
devbox recreate                  # apply changed ports/memory/image/key
devbox purge                     # also delete volumes (asks first)
devbox build                     # build the images (was devcontainers/build.sh)
```

## Images

`dev-core` (Fedora, non-root `dev` user, git/ssh, Docker CLI, zsh with the shared config) and
`dev-fullstack` (core + Node via nvm, Python via uv, Docker daemon, sshd). Build with
`devbox build` (`devcontainers/build.sh` and `build.ps1` call it). The images use the same zsh and
Starship config as the host.

## Settings

Layered, later overriding earlier: defaults in `src/dotfiles/devbox/config.py`, then
`~/.config/devbox/config` (this machine, for example a proxy), then `<project>/.devbox.env`
(ports, memory). A template is in `local/devbox.config.example`. `DEVBOX_RUNTIME=container|wslc`
overrides the runtime choice.

> [!WARNING]
> **Gotchas**
>
> - Create-time settings only apply on creation: use `devbox recreate` after changing them.
> - The config files are now **parsed**, not sourced: `KEY=value` with shell quoting and comments,
>   but no `$VAR` or `$(...)`. On Windows, backslashes in values are kept as-is (paths).
> - The forwarded ssh-agent socket (Apple `container`) is fixed at creation: `devbox recreate` after a
>   Mac restart.
> - A network that does TLS inspection needs its CA in `local/certificates/` before images build.
> - `ssh-config --install` writes `~/.ssh/config.d/devbox-<project>`. The bash version wrote
>   `devbox-devbox-<project>`, so delete that old file if you have one.
