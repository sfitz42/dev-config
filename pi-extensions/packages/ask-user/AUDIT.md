# ask-user: audit and spec

Inspired by [edlsh/pi-ask-user](https://github.com/edlsh/pi-ask-user) 0.17.0, commit
`c5109911ada9bad375aa94300ad9315304226aa1`, audited 2026-10-20.
This package is a new implementation written from the spec below; no upstream code, tests or
skill text were copied.

## Audit findings

| Severity | Finding | Handling here |
|---|---|---|
| None | No network, no processes at runtime, no `eval`/`Function`/dynamic import, no runtime deps, no lifecycle scripts. Dev scripts (`scripts/*.mjs`, not shipped) run `npm pack --dry-run --ignore-scripts`. | n/a |
| Low | Reads `ask-user.json` from the agent directory and `PI_ASK_USER_*` env vars on every call. Read-only; nothing is written. | Same, read-only. |
| Low | Broadcasts `ask:answered` / `ask:cancelled` on `pi.events` to every extension. Redacted to the question and response kind unless `emitFullEvents` is on. | Same, redacted by default. |
| Low | Emits `herdr:blocked` on `pi.events` while waiting for the user. | Same. |
| Low | Tern integration puts a renderer in a process-global registry (`Symbol.for('pi-tern.tools.v1')`) and a method under a global symbol; any extension can read or replace them. They only render what the tool already shows. | Kept for parity; no data beyond the tool's own. |
| Low | The model can override the user's display preferences per call, including turning off the overlay-hide and comment shortcuts. | Kept (documented precedence), noted here. |
| Low | Options are matched by title, so duplicate titles are indistinguishable in the answer. | Duplicate titles are dropped (first kept). |
| Info | `SKILL.md` uses pressure wording ("You MUST", "Non-negotiable rule") and names tools that may not exist (`exa`, `ref`). | Skill rewritten in neutral wording. |
| Info | Peers on `@sinclair/typebox` and carries a TypeBox shim probe for another host. | Uses Pi's `typebox` and `StringEnum` from `@earendil-works/pi-ai`. |
| Info | Several `as any` casts around the editor and key ids. | Typed; one documented cast for user-supplied key ids. |

## Spec

### Tool `ask_user`

Label "Ask User", `exposure: 'model-only'` (scripts cannot open prompts), `executionMode:
'sequential'` (no other tool in the same turn runs before the user answers). Prompt snippet and
guidelines tell the model to gather context first, ask one focused question by default, use
`questions` only for 2-4 independent decisions, and not to pack several questions into one.

Parameters (all optional in the schema; exactly one of `question` / `questions` is needed):

| Param | Meaning |
|---|---|
| `question` | The question. With `questions`, only a heading for the batch. |
| `questions` | 2-4 entries `{ question, context?, options?, allowMultiple?, allowFreeform? }`. |
| `context` | Summary shown with the question (markdown). |
| `options` | `{ title, description? }[]`. Strings and objects keyed `label`/`text`/`value`/`name`/`option` are accepted at runtime. |
| `allowMultiple` | Multi-select. Default false. |
| `allowFreeform` | Adds a "type something" row. Default true. |
| `allowComment` | After choosing, offer an optional comment. |
| `displayMode` | `overlay` (centred modal) or `inline`. |
| `singleSelectLayout` | `auto` (details pane on wide terminals) or `list`. |
| `contextExpanded` | Start with long context expanded. |
| `overlayToggleKey`, `commentToggleKey` | Key ids; `off`/`none`/`disabled`/empty disables. |
| `timeout` | Milliseconds; expiry counts as cancel. |

Validation (throws before any UI, so the model sees an error it can fix):

- Neither `question` nor `questions`: error naming both.
- Options given but none usable: error explaining the accepted shapes.
- Batch: `context`/`options`/`allowMultiple`/`allowFreeform` at the top level → error; not an
  array, fewer than 2 or more than 4 entries → error; empty or repeated (case-insensitive)
  question → error; per-entry option errors as above.

Results (`content` text / `details`):

- Answered: `User answered: <summary>`; summary is the freeform text, or selections joined by
  `, ` plus ` — <comment>` when there is one.
- Cancelled, aborted or timed out: `User cancelled the question`, `details.cancelled: true`.
- Already aborted at start: `Cancelled`.
- Single details: `{ question, context?, options, response, cancelled }`; response is
  `{ kind: 'selection', selections, comment? }` or `{ kind: 'freeform', text }`.
- Batch: `[heading]` then `User answered n of m questions:` and `i. question → summary` (or
  `(skipped)`); details `{ kind: 'batch', heading?, questions, answers, cancelled }`, answers
  `{ status: 'answered', response }` or `{ status: 'skipped' }`; cancelled batches return
  `User cancelled the questions` with empty answers.
- No UI (print/JSON mode): throws `Ask requires interactive mode. Please answer:` with the
  question, context, numbered options and hints, so the model can ask in plain text.
- While waiting, a partial update `Waiting for user input...` is sent.

### Preferences

Resolved per call: parameter, then env var, then `ask-user.json`, then default.

| Key (file) | Env var | Default |
|---|---|---|
| `displayMode` | `PI_ASK_USER_DISPLAY_MODE` | `overlay` |
| `singleSelectLayout` | `PI_ASK_USER_SINGLE_SELECT_LAYOUT` | `auto` |
| `allowComment` | `PI_ASK_USER_ALLOW_COMMENT` | false |
| `contextExpanded` | `PI_ASK_USER_CONTEXT_EXPANDED` | false |
| `overlayToggleKey` | `PI_ASK_USER_OVERLAY_TOGGLE_KEY` | `alt+o` |
| `commentToggleKey` | `PI_ASK_USER_COMMENT_TOGGLE_KEY` | `ctrl+g` |
| `emitFullEvents` | `PI_ASK_USER_EMIT_FULL_EVENTS` | false |

The file is `<agent dir>/ask-user.json`, agent dir = `PI_CODING_AGENT_DIR` or `~/.pi/agent`,
re-read every call. Missing file → defaults; unreadable or invalid JSON → the call fails naming
the file; wrong-typed or unknown keys are ignored. Env booleans accept `1/true/yes/on` and
`0/false/no/off`. An invalid key id falls through to the next source.

### Interactive prompt

- **No options:** a plain input dialog (`ctx.ui.input`), question plus `Context:` block.
- **Otherwise:** a custom component framed as a rounded box titled `ask_user` with the package
  version in the bottom border; `overlay` shows it centred (92% wide, min 40 columns, max 85%
  high, margin 1), `inline` in place. The overlay-toggle key hides/shows the overlay via a raw
  terminal listener (ignoring key repeat/release); the first hide shows a notice.
- **Single-select:** type-to-filter (fuzzy over title and description), `Filter:` line, numbered
  rows with wrapped titles and descriptions, then the comment-toggle row (if `allowComment`) and
  the freeform row (if `allowFreeform`). Up/down, tab/shift+tab, ctrl+k/ctrl+j move (wrapping);
  digits 1-9 jump; enter chooses (or toggles comment / opens editor on those rows); space toggles
  the comment row; backspace erases the filter; esc clears the filter, then cancels. With
  `auto` layout and width ≥ 84 the list (42%, min 32) sits beside a markdown details pane (min
  28) separated by ` │ `, and list descriptions are hidden. Long lists scroll around the selected
  row with a `(i/n)` indicator.
- **Multi-select:** `[ ]`/`[✓]` rows; space or a digit toggles; enter submits the ticked
  options, or the highlighted one when none is ticked.
- **Freeform / comment editor:** a multi-line editor under `Custom response` or the selected
  options; submit sends, esc returns to the list (or cancels when there are no options); drafts
  survive switching. An empty comment submits the selection without a comment.
- **Context:** shown as markdown under `Context:`. When it does not fit (more than 3 rows
  inline, or more than the overlay can spare), it collapses to `Context (n lines) — <key>
  expand`; the toggle key is the first of ctrl+e/ctrl+x/ctrl+y not used by another shortcut.
  `contextExpanded` sets the starting state.
- **Overlay sizing:** up to 85% of terminal rows (min 8); the question/context pane scrolls with
  PgUp/PgDn, Home/End, ctrl+u/ctrl+d in select mode, with ↑/↓/↕ markers; help hints take 1-2 rows.
- **Help line:** context-dependent key hints joined by ` • `.

### Batches

One prompt with a page per question plus a review page; tab/shift+tab move between pages, and
each page keeps its filter, ticks and drafts. Answering a page moves to the next unanswered one,
then to review. The frame title lists `[1✓] 2 3 · review` (and the heading, if any). Review lists
each question with its answer or `unanswered`; enter submits, and with unanswered questions the
first enter asks for confirmation and the second submits them as skipped; digits jump to a
question; the list scrolls. Esc on any page cancels the whole batch. One deadline covers the
whole batch.

### Fallback dialogs (RPC mode)

When `ctx.ui.custom` returns nothing: single-select uses `select` (options plus
`✏️ Type custom response...` when freeform is allowed, which opens `input`); multi-select uses
`input` listing numbered options and parses a comma-separated answer; with `allowComment`, a
second `input` asks for an optional comment (enter skips; cancel cancels the answer). Batches ask
each question in turn titled `(i/n) question`; cancelling any one cancels the batch. Every stage
respects the abort signal and the remaining time.

### Events

- `herdr:blocked` `{ active: true, label: 'Waiting for user response' }` while waiting, then
  `{ active: false }`.
- `ask:answered` `{ question, response: { kind } }` and `ask:cancelled` `{ question }`, with
  `batch: { index, total }` in batches (answered entries only on submit; every entry on cancel).
  With `emitFullEvents`, the full `context`, `options` and `response` are included.

### Rendering

- Call: `ask_user <question>`, option count and titles, `[multi-select]`, `[optional comment]`;
  batches show `n questions`, the heading and one line per entry.
- Result: errors as `✗ message`; partial as the waiting text; `Cancelled`; otherwise
  `✓ [(wrote)] <summary>`, and when expanded the question, context, every option with `●`/`○`
  and the comment. Batches show `✓ a of n answered` and one line per question.

### Tern

When pi-tern is present it reads two global-symbol hooks: the prompt components render native
sheets (question tabs, markdown question and context, list of options, editor, review page,
action bar) whose pointer events run the same transitions as keys, and a tool card shows each
question over its options with the chosen ones checked. Without pi-tern nothing happens.

### Skill

`skills/ask-user/SKILL.md`: when to ask (consequential or ambiguous decisions), gathering
evidence first, writing one focused question with a short context and 2-5 options, when to
batch, what to do after an answer or a cancel, and a cap of two attempts per decision.
