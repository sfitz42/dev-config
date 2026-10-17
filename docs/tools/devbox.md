# devbox

**Last reviewed: 2026-10-16.** Script: `devcontainers/devbox/devbox`. Full reference:
[`devcontainers/README.md`](../../devcontainers/README.md).

**Platform:** macOS (it drives Apple `container`); the images are ordinary Linux.

> [!NOTE]
> **Beyond macOS**
>
> The `devbox` script calls `container`, so it needs a Mac. The Dockerfiles in `devcontainers/images/`
> are plain Fedora images and should build with Docker or Podman elsewhere (not tested here), and they
> use the same portable zsh and Starship config.

One **persistent container per project**, built on [Apple `container`](apple-container.md), with
Docker-in-container, SSH for editors, and named volumes for the state that matters.

```sh
cd ~/projects/my-app
devbox up                        # create + start "devbox-my-app"
devbox shell                     # zsh in the project (mounted at ~/workspace)
devbox ssh-config --install      # writes ~/.ssh/config.d/devbox-my-app, for Zed / ssh
devbox stop                      # state is kept
devbox down                      # delete the container, keep volumes
devbox recreate                  # apply changed ports/memory/image/key
devbox purge                     # also delete volumes (asks first)
```

## Images

`dev-core` (Fedora, non-root `dev` user, git/ssh, Docker CLI, zsh with the shared config) and
`dev-fullstack` (core + Node via nvm, Python via uv, Docker daemon, sshd). Build with
`devcontainers/build.sh`. The images use the same zsh and Starship config as the Mac.

## Settings

Layered, later overriding earlier: defaults in `devbox`, then `~/.config/devbox/config` (this
machine: for example a proxy), then `<project>/.devbox.env` (ports, memory). A template is in
`local/devbox.config.example`.

> [!WARNING]
> **Gotchas**
>
> - Create-time settings only apply on creation: use `devbox recreate` after changing them.
> - The forwarded ssh-agent socket is fixed at creation: `devbox recreate` after a Mac restart.
> - A network that does TLS inspection needs its CA in `local/certificates/` before images build.
