# Models

The models installed on this Mac. They are MLX builds, so they only run on Apple silicon; on other
platforms look for GGUF builds of the same families.

| Model | Original | On disk | Role today |
|---|---|---|---|
| [`Qwen3.6-35B-A3B-4bit`](https://huggingface.co/mlx-community/Qwen3.6-35B-A3B-4bit) | [Qwen/Qwen3.6-35B-A3B](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) | 19 GB | Pi's default model |
| [`Qwen3.8-27B-4bit`](https://huggingface.co/mlx-community/Qwen3.8-27B-4bit) | [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) | 15 GB | Installed |
| [`gpt-oss-20b-MXFP4-Q8`](https://huggingface.co/mlx-community/gpt-oss-20b-MXFP4-Q8) | [openai/gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b) | 11 GB | Installed |

Hardware is an M5 Pro with 64 GB ([basics](apple-silicon-basics.md)); the names are explained in
[quantisation and memory](quantisation-and-memory.md); serving is covered in [oMLX](omlx.md).
