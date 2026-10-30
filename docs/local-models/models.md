# Models

The local models I use, in two runtimes. The lists the installer pulls live in `models.yaml`, so
this page and that file should agree.

## oMLX (Apple silicon)

The models installed on the Mac. They are MLX builds, so they only run on Apple silicon.

| Model | Original | On disk | Role today |
|---|---|---|---|
| [`Qwen3.6-35B-A3B-4bit`](https://huggingface.co/mlx-community/Qwen3.6-35B-A3B-4bit) | [Qwen/Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) | 19 GB | Pi's default model |
| [`Qwen3.8-27B-4bit`](https://huggingface.co/mlx-community/Qwen3.8-27B-4bit) | [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) | 15 GB | Installed |
| [`gpt-oss-20b-MXFP4-Q8`](https://huggingface.co/mlx-community/gpt-oss-20b-MXFP4-Q8) | [openai/gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b) | 11 GB | Installed |

Hardware is an M5 Pro with 64 GB ([basics](apple-silicon-basics.md)); the names are explained in
[quantisation and memory](quantisation-and-memory.md); serving is covered in [oMLX](omlx.md).

## Ollama (any platform)

The same models as Ollama library tags (GGUF), 4-bit where there is a choice. Explicit quantisation
tags were checked on ollama.com on 2026-10-29.

| Tag | Same model as | On disk |
|---|---|---|
| [`qwen3.6:35b-a3b-q4_K_M`](https://ollama.com/library/qwen3.6/tags) | `Qwen3.6-35B-A3B-4bit` | 24 GB |
| [`qwen3.8:27b-q4_K_M`](https://ollama.com/library/qwen3.8/tags) | `Qwen3.8-27B-4bit` | 18 GB |
| [`gpt-oss:20b`](https://ollama.com/library/gpt-oss/tags) | `gpt-oss-20b-MXFP4-Q8` | 14 GB |

A model larger than the GPU's memory still runs, but Ollama moves the layers that don't fit onto
the CPU, which is much slower. These sizes were chosen for the Mac's 64 GB of unified memory: on
the Windows PC (RTX 2080 Ti, 11 GB), none of the three fits entirely on the GPU, `gpt-oss:20b`
comes closest. Under WSL, models go to Ollama on Windows (see
[getting started](../getting-started.md#local-models-and-extras)).

## Pulling them

From the wizard (the Models tab under Select Components shows which are pulled), or:

```sh
scripts/dotfiles models                      # every runtime found here
scripts/dotfiles models --runtime ollama     # just Ollama
scripts/dotfiles models --runtime omlx Qwen3.8-27B-4bit
```
