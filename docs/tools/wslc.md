# WSL containers (wslc)

**Last reviewed: 2026-10-17** against WSL 3.0.3 / `wslc 3.0.3.0` on Windows 11.

**Platform:** Windows (WSL 2.9.3+). `wslc.exe` also works from inside a WSL distro through interop.

`wslc.exe` is the container CLI built into WSL ([Microsoft docs](https://learn.microsoft.com/en-us/windows/wsl/wsl-container)).
There is no separate engine to install: `wsl --update`, then `wslc version`. Its commands follow
Docker's (`run`, `exec`, `build`, `volume`, `logs`, `inspect`), and containers run in a
"session" VM that starts on demand. `devbox` uses it on Windows the way it uses
[Apple `container`](apple-container.md) on the Mac.

## What devbox can and can't do on wslc

These were checked by hand on this machine. `src/dotfiles/devbox/runtime.py` encodes them.

| Feature | wslc | Notes |
|---|---|---|
| Build `dev-core` / `dev-fullstack` | ✅ | BuildKit: `--build-arg`, `COPY --chmod` and `# syntax=` all work |
| Persistent container, stop/start keeps state | ✅ | The session stays up while a container runs |
| Project bind mount | ✅ | Windows paths; distro paths via `\\wsl.localhost\<distro>\...` |
| Ports on `127.0.0.1` | ✅ | **IPv4 only**: on Windows `localhost` resolves to `::1` first, so the ssh entry uses `127.0.0.1` |
| sshd, Zed over SSH | ✅ | `devbox ssh-config` |
| Named volumes | ✅ | Default `guest` driver; a sized volume is `-d vhd -o SizeBytes=<bytes>` (its own VHDX) |
| Docker inside the container | ❌ | No `--cap-add` / `--privileged`. Containers get Docker's default caps (`CapEff 00000000a80425fb`), so the `/proc/sys` remount and iptables are denied and dockerd exits. devbox turns `DEVBOX_DOCKER` off |
| ssh-agent forwarding (`--ssh`) | ❌ | The ssh entry sets `ForwardAgent yes` instead, so the agent works in ssh/Zed sessions but not in `devbox shell` |

> [!TIP]
> **Where to keep projects.** A quick test (2000 small file writes and reads) took 4.7 s on a
> Windows path, 21.8 s on a `\\wsl.localhost` distro path and 0.09 s in a named volume. With
> wslc, keep projects on the Windows drive (or clone into a volume for heavy `node_modules`
> work). This is the opposite of the advice for tools running *inside* a distro.

## Settings

`wslc settings` opens `%LOCALAPPDATA%\wslc\settings.yaml`. `.wslconfig` does not apply here.

| Setting | Default | Why it matters for devbox |
|---|---|---|
| `session.memorySize` | 50% of RAM | Caps **all** containers together; `DEVBOX_MEMORY` is per container inside it |
| `session.cpuCount` | all | Same for CPUs |
| `session.idleTimeout` | 30 s | The VM stops when nothing runs; a devbox container keeps it up |
| `session.defaultBindingAddress` | `127.0.0.1` | devbox always passes `127.0.0.1` explicitly |
| `session.hostLoopback` | `host.wslc.internal` | How containers reach Windows, e.g. for a proxy (`BUILD_PROXY`, `DEVBOX_PROXY`) |

Session settings apply to the next session: `wslc system session terminate` to restart it.

## Handy commands

```powershell
wslc list --all                 # containers (add --format json for one object per line)
wslc stats                      # resource use
wslc volume list
wslc image prune; wslc container prune
wslc system session terminate   # restart the VM (picks up settings.yaml changes)
```

> [!WARNING]
> **Gotchas**
>
> - `wslc run -m` prints "kernel does not support swap limit capabilities". It is harmless: memory is
>   limited without swap.
> - `wslc exec -i` with a closed or `NUL` stdin fails with `ERROR_INVALID_HANDLE`. devbox only passes
>   `-i` when there is piped input.
> - Under PowerShell 7, `ssh-keygen -N '""'` sets a literal `""` passphrase. devbox calls it with
>   a real empty argument.
