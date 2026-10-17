# oMLX

**Last reviewed: 2026-10-16.** Version 0.7.0 on this Mac. App: `/Applications/oMLX.app`; CLI: `omlx`
(installed from the pinned DMG in `packages.yaml`).

**Platform:** macOS on Apple silicon only.

## What it is

An LLM server for Apple silicon built on MLX: a menu-bar app plus the `omlx` command. It serves
several models behind an OpenAI-compatible API and also launches coding tools already pointed at it.

## Running it

```sh
omlx start                 # managed background server
omlx stop | restart
omlx serve mlx-community/Llama-3.2-3B-Instruct-4bit --port 8000   # foreground, one model
omlx diagnose              # installation / runtime problems
omlx launch list           # which coding tools it can configure
omlx launch pi             # configure and start Pi against the server
omlx launch claude         # same for Claude Code
```

`omlx launch` supports Claude Code, Copilot CLI, Codex, OpenCode, OpenClaw, Hermes, Pi and others;
on this Mac Claude Code and Pi are installed.

## My configuration

Settings live in `~/.omlx/settings.json` (not tracked: it contains keys). The parts that matter:

| Setting | Value here | Meaning |
|---|---|---|
| `server.host` / `port` | `127.0.0.1` / `8000` | Local only |
| `auth.allow_unauthenticated_inference` | `False` | Requests need the API key |
| `model.model_dir` | `~/.omlx/models` | Hugging Face layout: `mlx-community/<model>` |
| `memory.soft_threshold` / `hard_threshold` | 0.85 / 0.95 | Fractions of memory at which it starts protecting itself |
| `memory.prefill_memory_guard` | on | Guards against a huge prompt exhausting memory |
| `scheduler.max_concurrent_requests` | 8 | |
| `cache.*` | enabled, SSD cache | Reuses prompt state across turns: important for agents |
| `sampling.max_context_window` | 32768 | Server-side limit (compare with what Pi declares) |
| `integrations.web_search_provider` | `ddgs` | Optional web search tool |

## Models installed

| Model | Size |
|---|---|
| `Qwen3.6-35B-A3B-4bit` | 19 GB (Pi's default) |
| `Qwen3.8-27B-4bit` | 15 GB |
| `gpt-oss-20b-MXFP4-Q8` | 11 GB |

## Talking to it

```sh
curl http://127.0.0.1:8000/v1/models -H "Authorization: Bearer $OMLX_API_KEY"
```

The key is kept in the untracked `local/agents.env` and used by `scripts/dotfiles agents` to render
Pi's `models.json` ([Pi](../agents/pi.md)). Never put it in a tracked file.

> [!WARNING]
> **Gotchas**
>
> - First request after loading a model is slow; later ones are warm.
> - A long agent session is bounded by the smaller of the model's context, the server's
>   `max_context_window`, and what your free memory allows.
> - Updating: the app updates itself; to pin a version, update the URL and `sha256` in `packages.yaml`.
