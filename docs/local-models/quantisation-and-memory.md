# Quantisation, model shape and memory

**Last reviewed: 2026-10-16.** General concepts; verify specifics against a model's own card.

**Platform:** any Unix (macOS and Linux).

## Quantisation in one paragraph

Weights are stored at lower precision to shrink memory and speed up decode (less to read per
token), at some cost in quality. 16-bit is the reference; **8-bit** is usually close to it;
**4-bit** is the common sweet spot for local use; below that, quality loss grows noticeably and
varies by model and task. Newer block-scaled formats (such as **MXFP4**) aim to keep more quality
at 4 bits than older integer schemes.

## What the names on this Mac mean

| Name | Reading |
|---|---|
| `Qwen3.6-35B-A3B-4bit` | 35B parameters in total; **A3B** = about 3B *active* per token (mixture of experts); 4-bit weights |
| `Qwen3.8-27B-4bit` | 27B **dense** (all parameters used per token); 4-bit |
| `gpt-oss-20b-MXFP4-Q8` | ~20B mixture-of-experts; MXFP4 expert weights with 8-bit for the rest |

Sizes on disk (19 GB, 15 GB, 11 GB) are about 0.55 bytes per parameter, a little over 4 bits,
because scales and some layers are kept at higher precision.

## Mixture-of-experts versus dense

- **Memory** is set by *total* parameters: a 35B MoE needs more RAM than a 27B dense model.
- **Decode speed** follows *active* parameters: a ~3B-active MoE reads far less per token, so it
  should generate faster than a dense 27B on the same machine.
- **Quality** is not simply parameter count; compare on your tasks.

That "should" is the expected relationship, not something I have benchmarked here; see
[measure, don't guess](apple-silicon-basics.md#measure-dont-guess).

## Context length costs memory

The **KV cache** stores attention state for every token in the context. It grows with context
length and, for classic transformers, can reach many GB at very long contexts. Some newer models use
hybrid layers that keep much less per-token state (oMLX has dedicated "gdn" cache settings for
these), so cost varies per model: measure Activity Monitor's memory while you load a long prompt.

Two numbers to keep apart:

- the **model's maximum context** (what it was trained for),
- the **server's configured limit** (what you will actually allow).

On this setup Pi declares a 262,144-token window for `Qwen3.6-35B-A3B-4bit`, while oMLX's
`sampling.max_context_window` setting is 32,768. Worth checking which one governs before a long
agent session.

> [!TIP]
> **Practical rules**
>
> 1. Pick the largest model whose weights plus a realistic context leave 10+ GB free.
> 2. Prefer 4-bit for the main model; spend memory on context before spending it on 8-bit weights,
>    unless you see quality problems.
> 3. Keep one big model loaded rather than switching: loading costs tens of seconds.
> 4. For agents, a cache matters as much as raw speed (see [oMLX](omlx.md)).
