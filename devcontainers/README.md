# devcontainers

Project-blind dev images for [Apple `container`](https://github.com/apple/container) on macOS and
[WSL containers (`wslc`)](../docs/tools/wslc.md) on Windows, plus a launcher (`devbox`) that runs one
**persistent container per project**.

| | Apple `container` | `wslc` |
|---|---|---|
| Build images, persistent container, volumes, sshd/Zed, ports | ✅ | ✅ |
| Docker inside the container (`DEVBOX_DOCKER`) | ✅ | ❌ no capability flags; turned off |
| ssh-agent forwarding into the container | ✅ `--ssh` | ❌ only over SSH sessions (`ForwardAgent yes`) |
| Proxy host for builds/containers | `192.168.64.1` (tinyproxy) | `host.wslc.internal` |

- **Images know nothing about projects.** No proxy settings, ports or project paths are baked
  in. Those are applied when the container is created (by `devbox`, or by your own `container run`).
- **One container per project**, kept between sessions, with Docker-in-container, SSH for
  editors such as Zed, and named volumes for the state that matters.

## Contents

| Path | Purpose |
| --- | --- |
| `images/core.Dockerfile` | `dev-core`: Fedora, non-root `dev` user (passwordless sudo), build tools, git/ssh, Docker CLI, zsh (Oh My Zsh + Starship). No language runtimes. |
| `images/dev-fullstack.Dockerfile` | `dev-fullstack`: `dev-core` + Node (nvm), Python (uv via pipx), Docker daemon, sshd. |
| `images/entrypoint.sh` | Image entrypoint: starts dockerd / sshd on request, shuts them down cleanly on stop. |
| `config/` | Git-ignored staging dir. `devbox build` copies the shared `../config/zsh/` and `../config/starship/starship.toml` here, so the images use the same shell config as the host. |
| `certificates/` | Empty in git. `devbox build` copies `local/certificates/*.crt` here and the image trusts them (optional; for TLS-inspecting corporate proxies). |
| `proxy/tinyproxy.conf.example` | Host-side proxy for networks that block the container VM, e.g. Zscaler (see [Proxy](#proxy)). Copy to `local/proxy/tinyproxy.conf` to enable. |
| `build.sh`, `build.ps1` | Shims for `devbox build`: build the images (with tinyproxy on Apple `container` when configured). |
| `devbox/devbox`, `devbox/devbox.ps1` | Shims that run the launcher (`src/dotfiles/devbox/`, Python via uv). |

## Prerequisites

- `uv` (installed by `scripts/bootstrap.sh` / `bootstrap.ps1`); it runs the Python launcher
- macOS: Apple's `container` CLI (`container system start`); `tinyproxy` (`brew install tinyproxy`)
  only if you use the proxy (see [Proxy](#proxy))
- Windows: WSL 2.9.3+ (`wsl --update`; check with `wslc version`). Run devbox from PowerShell
  (`devbox.ps1`), or from inside a distro (`devbox` calls `wslc.exe` through interop and converts
  paths with `wslpath`)

## Build the images

```sh
./build.sh                 # dev-core, then dev-fullstack      (Windows: .\build.ps1)
./build.sh fullstack       # just dev-fullstack (core must already exist)
./build.sh core --no-cache # extra args are passed to `container build` / `wslc build`
```

Tags default to `dev-core:0.1.0` and `dev-fullstack:0.1.0` (override with `CORE_TAG`,
`FULLSTACK_TAG`). Version pins are build args on the Dockerfiles:

| Arg | Default | Meaning |
| --- | --- | --- |
| `NODE_VERSION` | `lts/*` | Default Node installed via nvm |
| `NVM_VERSION` | `0.40.3` | nvm release |
| `PYTHON_VERSION` | `3.14` | Default Python pre-installed by uv |
| `UV_VERSION` | empty (latest) | Exact uv release to install with pipx |

e.g. `./build.sh fullstack --build-arg NODE_VERSION=22`.

With Apple `container`, the build starts the container system and builder. If
`local/proxy/tinyproxy.conf` exists (or `USE_PROXY=1`), it also starts tinyproxy on the VM bridge
address (`192.168.64.1:8888`) and passes it to the build as proxy build args. On either runtime,
`BUILD_PROXY=http://host:port` uses a proxy you run yourself (with wslc the Windows host is
`host.wslc.internal`). Proxy args are only used while building; they are not stored in the image.

## Quick start

```sh
cd ~/projects/my-app
devbox up                        # creates + starts container "devbox-my-app" (first run creates an SSH key)
devbox shell                     # zsh in the project (mounted at ~/workspace)
devbox ssh-config --install      # once: writes ~/.ssh/config.d/devbox-my-app (needs `Include ~/.ssh/config.d/*` in ~/.ssh/config)
devbox stop                      # stop it; `devbox up` starts it again with its state intact
```

On Windows, the same commands are `...\devcontainers\devbox\devbox.ps1 up` and so on. Add a
profile function such as `function devbox { & "<repo>\devcontainers\devbox\devbox.ps1" @args }`.
Keep projects on the Windows drive: with wslc it is about 5× faster than a `\\wsl.localhost` path
(see [wslc](../docs/tools/wslc.md)).

Run `devbox help` for the command list.

| Command | What it does |
| --- | --- |
| `up` | Create the container if missing (with volumes), start it if stopped, wait until ready |
| `shell` | `container exec -it` a zsh in the workspace (starts the container if needed) |
| `exec <cmd>` | Run a command in the container |
| `stop` | Graceful stop (dockerd is shut down cleanly); state is kept |
| `down` | Stop and delete the container; volumes are kept |
| `recreate` | `down` + `up`: use after changing ports, memory, image or SSH key |
| `status` | State, address, ports, volumes |
| `logs` | Container logs (the entrypoint logs service start / stop here) |
| `ssh-config [--install]` | Print, or write to `~/.ssh/config.d/devbox-<project>`, the host entry for this project |
| `purge` | `down` and delete this project's volumes (asks first) |

`devbox -C <dir> <command>` runs against another project directory.

## Configuration

Settings are layered, later overriding earlier:

1. Built-in defaults (`src/dotfiles/devbox/config.py`)
2. **Machine-level** `~/.config/devbox/config` (or `$DEVBOX_CONFIG`): things specific to this machine, such as the proxy
3. **Project-level** `<project>/.devbox.env`: ports, memory, extra `NO_PROXY` hosts

Both files are `KEY=value` lines with shell quoting and `#` comments. They are parsed, not sourced,
so `$VAR` and `$(...)` are not expanded. On Windows, backslashes are kept (for paths). Example:

```sh
# ~/.config/devbox/config
DEVBOX_PROXY=http://192.168.64.1:8888

# my-app/.devbox.env
DEVBOX_PORTS="3000 8085"
DEVBOX_MEMORY=8G
DEVBOX_NO_PROXY=floci,backend
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEVBOX_IMAGE` | `dev-fullstack:0.1.0` | Image to run |
| `DEVBOX_NAME` | `devbox-<project dir>` | Container name; also prefixes the volume names |
| `DEVBOX_WORKSPACE` | `/home/dev/workspace` | Where the project directory is mounted (matches `dev-core`'s `WORKDIR`) |
| `DEVBOX_MEMORY` / `DEVBOX_CPUS` | `6G` / `4` | VM resources. Apple `container` defaults to 1 GB, which is too little for Docker + a compose stack |
| `DEVBOX_PORTS` | none | Space-separated ports to publish, bound to `127.0.0.1`. `3000` = `3000:3000`; `8080:3000` = host 8080 to container 3000 |
| `DEVBOX_RUNTIME` | by platform | `container` (Apple) or `wslc`; also read from the environment |
| `DEVBOX_DOCKER` | `1` | Run dockerd inside the container (Apple `container` only; off under wslc, which also skips the `-docker` volume) |
| `DEVBOX_SSHD` | `1` | Run sshd inside the container |
| `DEVBOX_SSH_PORT` | derived from the name (2200-2999) | Host and container port for SSH; unique per project |
| `DEVBOX_SSH_KEY` | `~/.ssh/devbox` | Key pair used to log in; created (no passphrase) if missing |
| `DEVBOX_FORWARD_AGENT` | `1` | Forward the Mac's ssh-agent into the container (`--ssh`); under wslc, adds `ForwardAgent yes` to the ssh entry instead |
| `DEVBOX_PROXY` | empty | Proxy URL; empty means no proxy |
| `DEVBOX_NO_PROXY` | empty | Extra hosts exempt from the proxy, added to `localhost,127.0.0.1,::1,172.16.0.0/12` |
| `DEVBOX_PROXY_INJECT` | `off` | `off`/`all`: whether the Docker CLI injects the proxy into builds and containers (see [Proxy](#proxy)) |
| `DEVBOX_DOCKER_VOLUME_SIZE` | `40G` | Size of the Docker store volume (Apple `container`) |

Create-time settings (ports, memory, CPUs, image, proxy, key) only apply when the container is
created. After changing them, run `devbox recreate`.

### Without `devbox`

The image works on its own and nothing in it is project specific:

```sh
container run -it --rm dev-fullstack:0.1.0                      # a zsh shell
container run --rm dev-fullstack:0.1.0 node --version           # any command
container run -d --name x --cap-add CAP_NET_ADMIN --cap-add CAP_SYS_ADMIN \
  -e DEVBOX_DOCKER=1 -p 127.0.0.1:3000:3000 dev-fullstack:0.1.0 sleep infinity
```

Entrypoint variables:

| Variable | Meaning |
| --- | --- |
| `DEVBOX_DOCKER=1` | Start dockerd (needs `--cap-add CAP_NET_ADMIN --cap-add CAP_SYS_ADMIN`) |
| `DEVBOX_SSHD=1` | Start sshd; requires `DEVBOX_SSH_PUBKEY` (the public key to allow) |
| `DEVBOX_SSHD_PORT` | sshd port (default 2222) |
| `DEVBOX_PROXY_INJECT` | `off` (default) or `all` |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Used by dockerd for pulls, and by tools in the container |

## Persistence

The container itself persists (stop/start keeps its filesystem). Per-project named volumes hold
the state worth keeping when the container is recreated:

| Volume | Mounted at | Holds |
| --- | --- | --- |
| `<name>-docker` | `/var/lib/docker` | Nested Docker images, layers, volumes |
| `<name>-zed` | `~/.zed_server` | Zed's remote server |
| `<name>-uv` | `~/.cache/uv` | uv cache |
| `<name>-npm` | `~/.npm` | npm cache |

The Docker store must be a named volume, not a Mac directory: overlay storage needs a real Linux
filesystem. Use one daemon per volume at a time. `devbox purge` removes the volumes;
`container system df` shows disk use.

Anything else written outside the project mount or these volumes lives only in the container and
is lost on `down`/`recreate`.

## Editors over SSH (Zed)

`devbox up` starts sshd on a per-project port, key-only, published on `127.0.0.1` only.

1. `devbox ssh-config --install` writes the host entry to `~/.ssh/config.d/devbox-<project>` (`UserKnownHostsFile ~/.ssh/known_hosts_devbox`,
   `StrictHostKeyChecking accept-new`). The host key persists with the container, so it is
   verified across restarts. `devbox down` removes the old entry so a recreated container is accepted.
2. Check `ssh devbox-<project>` works.
3. In Zed: connect to the `devbox-<project>` host and open `/home/dev/workspace`. Setting
   `"upload_binary_over_ssh": true` on the connection makes Zed push its remote server from the Mac,
   so the container needs no internet for that.

The login key is `~/.ssh/devbox`. Rotating it means deleting it and running `devbox recreate`.

### Git and other SSH from inside the container

`devbox` forwards your Mac's ssh-agent (`--ssh`). No private keys are copied into the container or its
volumes. Keys must be loaded in your agent (`ssh-add -L`). The forwarded socket is fixed when the
container is created, so after a Mac restart or logout run `devbox recreate`.

## Docker inside the container

Apple `container` only. wslc gives containers Docker's default capabilities with no way to add
more, so dockerd fails there (iptables and the `/proc/sys` remount are denied) and devbox turns it
off.

`DEVBOX_DOCKER=1` runs a real dockerd inside the container's VM, which isolates it from the Mac's
other Docker state and avoids exposing a host daemon. The entrypoint:

- remounts `/proc/sys` read-write (it is read-only by default and dockerd needs to enable IP forwarding)
- starts dockerd, waits until it responds, and stops it on SIGTERM

It needs `CAP_NET_ADMIN` and `CAP_SYS_ADMIN`. This is a weaker boundary than the default
capability set, inside a VM that already runs your project's dependencies; only use it for
projects that need Docker. Ports of compose services must be published to the container
(`ports:` in the compose file) and then to the Mac (`DEVBOX_PORTS`).

## Proxy

The container VM cannot reach the internet directly through Zscaler, but the Mac can, so a
tinyproxy on the Mac (`proxy/tinyproxy.conf.example`, copied to `local/proxy/tinyproxy.conf`; `192.168.64.1:8888`) makes the connections.

- **Image builds:** `devbox build` starts tinyproxy and passes it as build args (not stored in the image).
- **Running containers:** `DEVBOX_PROXY` sets `HTTP_PROXY`/`HTTPS_PROXY` (both cases) and `NO_PROXY`.
  Localhost, `127.0.0.1`, `::1` and `172.16.0.0/12` are always exempt.
- **dockerd** pulls images through the proxy.
- **Nested builds and containers:** by default the Docker CLI does *not* inject the proxy
  (`DEVBOX_PROXY_INJECT=off`). Many Node apps read `HTTP_PROXY` and ignore `NO_PROXY`, so injecting it
  into every container sends their `localhost`/service-to-service calls through the proxy, where
  they fail. Docker cannot inject into builds only. Options:
  - pass it per build: `docker build --build-arg HTTP_PROXY --build-arg HTTPS_PROXY ...`, or `build.args`
    in compose
  - set `DEVBOX_PROXY_INJECT=all` for a project (injects into builds *and* containers) and clear it per
    service where it causes trouble, e.g. `environment: { HTTP_PROXY: "", HTTPS_PROXY: "" }`
- Add compose service names to `DEVBOX_NO_PROXY` when containers call each other by name.

## Troubleshooting

- **`container` commands hang / the VM is unresponsive.** Possibly out of memory (the 1 GB
  default is too small for dockerd plus a compose stack; this was never confirmed for the earlier
  hang). Check `container stats <name>`. Recover with `container stop`/`kill`; if the CLI itself
  hangs, stop the helper processes (`pkill -f container-runtime-linux`, `container-network-vmnet`,
  `container-core-images`, `container-apiserver`) and run `container system start`.
- **`localhost:<port>` fails between containers.** Usually the proxy catching it; see [Proxy](#proxy).
  Test with and without `--noproxy '*'`.
- **Server not reachable from the Mac.** It must listen on `0.0.0.0` (for Hapi, `host`/`address` must not
  be `localhost`) and the port must be in `DEVBOX_PORTS` (then `devbox recreate`).
- **`Connection reset` on the SSH port.** sshd isn't running: check `devbox logs` and
  `devbox exec cat ~/.sshd/sshd.log`; `DEVBOX_SSH_PUBKEY` must be set.
- **TLS errors from uv / Python / Node.** The images set `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and
  `NODE_EXTRA_CA_CERTS` to `/etc/ssl/certs/ca-bundle.crt` (`/etc/pki/tls/certs/` is empty on this
  base image).
- **Compose won't stop on Ctrl+C.** Node as PID 1 ignores SIGTERM; add `init: true` or a short
  `stop_grace_period` to the service, or run detached (`docker compose up -d`).
- **Zombie state after a kill.** If a container was killed rather than stopped, the nested Docker
  store may need attention; `devbox purge` gives a clean slate.

## Security notes

- Passwordless sudo for `dev`; root and `dev` have no passwords. sshd allows key login only and
  listens on `127.0.0.1` on the Mac.
- Docker-in-container needs two added capabilities, and the project directory is writable from the
  container. Third-party dependencies you install run in that VM.
- Pointing the container at a Docker daemon on the Mac instead would give it root-equivalent control
  of that daemon and any Mac directories shared into its VM; this setup deliberately avoids that.

## Status of this setup

Verified: image builds; `devbox up`/`stop`/`up` with the Docker store surviving a restart; SSH key
login with a persistent host key; clean dockerd shutdown; capability set; CA bundle path;
tooling (`node`, `uv`) on `PATH` over SSH.

Not verified: interactive `devbox shell` in a terminal, ssh-agent forwarding, Zed against the new
setup, `DEVBOX_PROXY_INJECT=all`, and a real compose project (including the Floci emulator).

**wslc (2026-10-17, wslc 3.0.3, Python devbox):**
- Verified from PowerShell: image builds; `up`, `status`, `exec` (exit codes, piped stdin),
  `stop`/`up` keeping state, `recreate`, `down` keeping volumes, `purge`; SSH key login through the
  generated entry with node/uv on PATH; a published port reachable on `127.0.0.1`.
- Verified from inside a WSL distro: `up`/`exec`/`purge` with a distro project path.
- Not verified: interactive `devbox shell`, Zed, the Apple `container` path of the Python rewrite
  (covered by tests that check its `container run` args match the bash version).
