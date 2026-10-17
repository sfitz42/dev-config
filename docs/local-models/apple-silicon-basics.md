# Running local models on Apple silicon: the basics

**Last reviewed: 2026-10-16.** General background is stable; the machine facts and the "my setup"
sections are specific to this Mac.

**Platform:** Apple silicon (macOS); the concepts apply anywhere.

> [!NOTE]
> **Beyond macOS**
>
> Prefill versus decode, the quantisation arithmetic and the measuring snippet apply on any machine.
> The unified-memory and wired-limit sections are Apple-specific: on a PC the equivalent constraint is
> GPU VRAM (plus system RAM if the runtime can offload).

## This machine

| | |
|---|---|
| Model | MacBook Pro, **Apple M5 Pro** |
| Cores | 18 (6 "Super" + 12 Performance) |
| Memory | **64 GB** unified |
| Free disk | ~720 GB |
| macOS | 26.6 |

## Unified memory, and why it decides everything

CPU and GPU share one memory pool, so a model's weights can be used by the GPU without copying.
The practical consequences:

1. **A model must fit in memory** (weights + cache + the rest of the system), or it will not run
   well, if at all. There is no "offload layers to a separate VRAM and RAM" trade like on a PC.
2. **The GPU can only wire a fraction of RAM.** macOS limits how much memory the GPU may pin. On
   this Mac `sysctl iogpu.wired_limit_mb` reports `0`, meaning "the system default". You can raise
   it with `sudo sysctl iogpu.wired_limit_mb=<MB>`; the setting does not survive a reboot. Check how
   your macOS version treats it before relying on that.
3. **Everything else competes.** Browser, IDE, dev containers and Docker Desktop all take from the
   same 64 GB. Watch *Memory Pressure* in Activity Monitor, not just "used".

## Two phases, two bottlenecks

| Phase | What happens | Limited by |
|---|---|---|
| **Prefill** (prompt processing) | The whole prompt is read before the first token | Compute. Long prompts (a big file, a long agent history) make you wait before anything appears |
| **Decode** (generation) | One token at a time | Memory bandwidth: every token reads the *active* weights once |

This is why coding agents feel different from chat: they send long, mostly repeated prompts. A
runtime with a **prompt/KV cache** (oMLX has an SSD-backed one) avoids re-doing prefill on each turn.

## What fits: back-of-envelope

```
weights (GB)  ≈ parameters (billions) × bits per weight ÷ 8        (plus a few % overhead)
KV cache (GB) ≈ grows linearly with context length                  (varies a lot by architecture)
budget        = RAM − macOS and your other apps − KV cache − headroom
```

The models on this Mac, from their on-disk size:

| Model | On disk | Notes |
|---|---|---|
| `Qwen3.6-35B-A3B-4bit` | 19 GB | Mixture-of-experts: 35B total, ~3B active per token |
| `Qwen3.8-27B-4bit` | 15 GB | Dense 27B |
| `gpt-oss-20b-MXFP4-Q8` | 11 GB | Mixture-of-experts, MXFP4 weights |

All three fit comfortably alongside normal work on 64 GB. Details of quantisation and context cost
are in [quantisation-and-memory](quantisation-and-memory.md).

## Measure, don't guess

Throughput depends on model, quantisation, context length and what else is running. To get your
own numbers from the local server:

```sh
time curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $OMLX_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3.6-35B-A3B-4bit","messages":[{"role":"user","content":"Explain a B-tree in 200 words."}],"max_tokens":300}' \
  | jq .usage
```

`completion_tokens ÷ seconds` is roughly decode speed for a short prompt. Repeat with a long prompt
to feel prefill. Record results, with a date, on the [models page](models.md).

> [!WARNING]
> **Gotchas**
>
> - Dev containers cannot use the GPU: run models on the host and call them over
>   `http://127.0.0.1:8000` (from a container, via the host's bridge address).
> - Leave headroom: macOS will compress and swap before a model "runs out", and speed then collapses.
> - The first request after a model loads is slow; keep-warm settings exist in oMLX
>   (`gpu_keep_warm_interval`).
