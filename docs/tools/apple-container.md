# Apple `container`

**Last reviewed: 2026-10-16.** Version 1.5.0 when reviewed. Installed from Apple's signed `.pkg`
(needs admin; pinned in `packages.yaml`).

**Platform:** macOS only (Apple silicon).

## What it is

Apple's open-source tool for running Linux containers as lightweight VMs on a Mac. Each container
is its own VM. Apple silicon only; the project's README states the required macOS version (this
Mac runs macOS 26).

```sh
container system start            # start the services (needed after a reboot)
container build -t name:tag -f Dockerfile .
container run -it --rm name:tag
container list --all              # alias: cls
container exec -it <id> zsh       # alias: ce
container image list
container system df               # disk use
```

## How I use it

Per-project persistent dev containers via [devbox](devbox.md), built from the images in
`devcontainers/`. Docker Desktop is also installed on this Mac (it is still needed).

## When it wedges

If `container` hangs or reports the API server is unreachable, `container-reset` (a function in
`config/zsh/functions.zsh`) kills the helper processes after asking, then:

```sh
container system start
```

> [!WARNING]
> **Gotchas**
>
> - **Networking:** containers get addresses on a host bridge (`192.168.64.0/24` by default). On a
>   network that blocks that traffic (for example a TLS-inspecting proxy), builds need the
>   host-side proxy described in `devcontainers/README.md`.
> - **Memory:** a container VM defaults to 1 GB; devbox sets 6 GB / 4 CPUs.
> - **No GPU access:** containers cannot use the Mac's GPU, so local models run on the host (see
>   [local models](../local-models/apple-silicon-basics.md)), not inside a container.
> - **Docker inside:** devbox runs a real Docker daemon inside the container VM when a project needs
>   `docker`/`compose` (`DEVBOX_DOCKER=1`).
