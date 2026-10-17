# Local versus hosted models for coding agents

**Last reviewed: 2026-10-16.** The framework below is stable; the "My take" lines are my own
opinions and are meant to be dated and revisited. Entries marked *to fill* are not yet written.

**Platform:** any Unix (macOS and Linux).

> [!NOTE]
> **Beyond macOS**
>
> The comparison is general. The hardware figures (64 GB, 10–35B parameters at 4-bit) describe this
> Mac; scale them to your machine.

## What differs

| Dimension | Local (oMLX + Pi) | Hosted (Claude Code, Copilot) |
|---|---|---|
| **Privacy** | Prompts and code never leave the Mac | Sent to the provider under its terms and your organisation's agreement |
| **Cost** | Hardware you already own, electricity | Per-token or subscription |
| **Availability** | Works offline; you manage the server | Depends on the network and provider |
| **Speed** | Bounded by memory bandwidth; long prompts wait on prefill; a cache helps a lot | Fast at scale, but latency and rate limits apply |
| **Model quality** | The best model that fits in 64 GB (roughly 10–35B parameters at 4-bit) | The provider's frontier models |
| **Context** | Server limit and free memory bound it | Large, managed for you |
| **Tool use** | Varies by model; some models are shaky with long tool-call chains | Generally the strongest |
| **Setup** | Install, download models, tune memory | Sign in |

> [!NOTE]
> **My take · reviewed 2026-10-16 · confidence: low**
>
> *To fill.* A starting point to confirm or change:
>
> - Work involving data I should not send out: local.
> - Large refactors and long multi-step agent runs: hosted.
> - Quick edits, explanations, offline: local.

> [!TIP]
> **Practical tips**
>
> - Give a local model a **small, well-scoped task** and relevant files rather than a whole repo.
> - Keep an eye on the context ceiling ([quantisation and memory](../local-models/quantisation-and-memory.md)).
> - If an agent loops or ignores tools, try another model before blaming the harness; see
>   the [models page](../local-models/models.md).

## Switching

- Pi: set `defaultProvider` in `agents/pi/settings.json`.
- Claude Code: `omlx launch claude` for local; plain `claude` for hosted.
