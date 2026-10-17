# Models

**Last reviewed: 2026-10-16.** What is installed here, and which model I reach for. The facts are
stable; the assessments go in dated panels because they go stale fast.

**Platform:** the notes are general; the installed models are MLX builds (Apple silicon).

> [!NOTE]
> **Beyond macOS**
>
> The model families are not Mac-specific, but these particular files are MLX builds. On other
> platforms look for GGUF (or other runtime) builds of the same families and check their sizes.

## Installed

| Model | On disk | Role today |
|---|---|---|
| `Qwen3.6-35B-A3B-4bit` | 19 GB | Pi's default model |
| `Qwen3.8-27B-4bit` | 15 GB | Installed |
| `gpt-oss-20b-MXFP4-Q8` | 11 GB | Installed |

Hardware is an M5 Pro with 64 GB ([basics](apple-silicon-basics.md)); the names are explained in
[quantisation and memory](quantisation-and-memory.md); serving is covered in [oMLX](omlx.md).

## By task

For each task: record what I **measured** separately from what I **feel**, with the setup (runtime,
quantisation, context) and the date. Delete a panel rather than leave a guess in it.

### Agentic coding (multi-step, tool use)

> [!NOTE]
> **My take** · reviewed 2026-10-16 · confidence: low
>
> - **Local:** *to fill*
> - **Hosted:** *to fill*
> - **Measured:** *to fill*

### Quick edits and explanations

> [!NOTE]
> **My take** · reviewed 2026-10-16 · confidence: low
>
> - **Local:** *to fill*
> - **Hosted:** *to fill*

### Code review

> [!NOTE]
> **My take** · reviewed 2026-10-16 · confidence: low
>
> *to fill*

### Summarising long documents

> [!NOTE]
> **My take** · reviewed 2026-10-16 · confidence: low
>
> *to fill*

### Vision and screenshots

> [!NOTE]
> **My take** · reviewed 2026-10-16 · confidence: low
>
> *to fill*

### Offline or sensitive work

> [!NOTE]
> **My take** · reviewed 2026-10-16 · confidence: low
>
> *to fill*

## How I test

> [!TIP]
> A repeatable prompt set matters more than any single impression. A minimum: one bug-fix task, one
> refactor and one "explain this code", each run on each model with the same context. Record
> tokens/s from the [measurement snippet](apple-silicon-basics.md#measure-dont-guess) and whether
> the result worked first time.
