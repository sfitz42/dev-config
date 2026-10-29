# Runtimes for local models on a Mac

**Last reviewed: 2026-10-16.** This space moves quickly; treat this as a map, and check each
project before relying on it. No performance claims here: measure on your own tasks.

**Platform:** any, except MLX/oMLX (Apple silicon only).

> [!NOTE]
> **Beyond macOS**
>
> llama.cpp, Ollama and LM Studio run on Linux, Windows and macOS. MLX weights only run on Apple
> silicon, so on other platforms the GGUF runtimes are the choice. On the Windows PC this repo uses
> Ollama on the Windows side, driven from WSL ([models](models.md#ollama-any-platform)).

| Runtime | What it is | Format | Notes |
|---|---|---|---|
| **MLX** (and servers built on it) | Apple's array framework for Apple silicon | MLX weights (e.g. the `mlx-community` models on Hugging Face) | Designed around unified memory. oMLX, mlx-lm and others serve it |
| **oMLX** | A server and menu-bar app on MLX | MLX | What I use. OpenAI- and Anthropic-compatible API, SSD-backed KV cache, one-command launchers for coding agents. See [omlx](omlx.md) |
| **llama.cpp** | Portable C/C++ inference with a Metal backend | GGUF | Widest model and quantisation support, runs everywhere; `llama-server` gives an OpenAI-style API |
| **Ollama** | Simple model manager and local server | Its own library, GGUF-based | Easiest first step; good defaults, fewer knobs |
| **LM Studio** | Desktop app | GGUF and MLX engines | GUI for browsing, downloading, chatting and serving |

## Choosing

- **Want it to just work, any model:** Ollama or LM Studio.
- **Want the most from Apple silicon and a coding-agent workflow:** MLX through oMLX.
- **Need a model that only exists as GGUF, or non-Mac portability:** llama.cpp.

> [!NOTE]
> **My take · reviewed 2026-10-16**
>
> oMLX: it speaks the APIs the coding agents expect and caches long agent prompts on SSD.
> *(Drafted from the config, not from me: confirm or rewrite.)* Which *model* I use for what is on the
> [models page](models.md).

## Interchange

Most of these expose an OpenAI-compatible endpoint, so tools such as [Pi](../agents/pi.md) only need
a base URL, a key and a model name.
