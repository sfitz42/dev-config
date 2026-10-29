import {
  buildCommentPrompt,
  createFreeformResponse,
  createSelectionResponse,
  formatOptionsForMessage,
  parseDialogSelections,
  withContext
} from './answer-format.ts'
import { isAborted } from './custom-prompt.ts'

import type { ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent'

import type {
  AskResponse,
  BatchAnswer,
  BatchQuestion,
  QuestionOption
} from './ask-types.ts'

/** The two dialogs the fallback needs (what RPC mode supports). */
interface DialogUI {
  select: (
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions
  ) => Promise<string | undefined>
  input: (
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions
  ) => Promise<string | undefined>
}

interface DialogQuestion {
  readonly question: string
  readonly context?: string
  readonly options: readonly QuestionOption[]
  readonly allowMultiple: boolean
  readonly allowFreeform: boolean
  readonly allowComment: boolean
}

const FREEFORM_CHOICE = '✏️ Type custom response...'
const ANSWER_PLACEHOLDER = 'Type your answer...'
const COMMENT_PLACEHOLDER = 'Optional comment (press Enter to skip)...'

/**
 * Options for the next dialog. With a shared deadline each dialog gets the
 * time left, or null once it has passed.
 *
 * @param base - Signal and per-dialog timeout.
 * @param deadline - Epoch ms the whole ask must finish by, if any.
 * @returns Dialog options, or null when out of time.
 */
function stageOptions (
  base: ExtensionUIDialogOptions | undefined,
  deadline: number | undefined,
  now: number = Date.now()
): ExtensionUIDialogOptions | undefined | null {
  if (deadline === undefined) {
    return base
  }
  const remaining = deadline - now
  return remaining > 0 ? { ...base, timeout: remaining } : null
}

/**
 * Runs one dialog stage unless time is up or the ask was aborted.
 *
 * @returns The dialog's value, or null when cancelled.
 */
async function stage (
  base: ExtensionUIDialogOptions | undefined,
  deadline: number | undefined,
  show: (opts: ExtensionUIDialogOptions | undefined) =>
  Promise<string | undefined>
): Promise<string | null> {
  const opts = stageOptions(base, deadline)
  if (opts === null || isAborted(base?.signal)) {
    return null
  }
  const value = await show(opts)
  return isAborted(base?.signal) || value === undefined ? null : value
}

async function withComment (
  ui: DialogUI,
  prompt: string,
  selections: readonly string[],
  base: ExtensionUIDialogOptions | undefined,
  deadline: number | undefined
): Promise<AskResponse | null> {
  const comment = await stage(base, deadline, async (opts) =>
    await ui.input(buildCommentPrompt(prompt, selections),
      COMMENT_PLACEHOLDER, opts))
  return comment === null ? null : createSelectionResponse(selections, comment)
}

/**
 * Asks one question with plain select/input dialogs, for RPC mode where
 * custom components are not available.
 *
 * @returns The answer, or null when cancelled, aborted or timed out.
 */
async function askViaDialogs (
  ui: DialogUI,
  ask: DialogQuestion,
  base?: ExtensionUIDialogOptions,
  deadline?: number
): Promise<AskResponse | null> {
  if (base?.signal?.aborted === true) {
    return null
  }
  const prompt = withContext(ask.question, ask.context)

  if (ask.allowMultiple) {
    const list = formatOptionsForMessage(ask.options)
    const raw = await stage(base, deadline, async (opts) => await ui.input(
      `${prompt}\n\nOptions (select one or more):\n${list}`,
      'Type your selection(s)...', opts))
    if (raw === null) {
      return null
    }
    const selections = parseDialogSelections(raw)
    if (selections.length === 0) {
      return null
    }
    return ask.allowComment
      ? await withComment(ui, prompt, selections, base, deadline)
      : createSelectionResponse(selections)
  }

  const choices = ask.options.map((option) => option.title)
  if (ask.allowFreeform) {
    choices.push(FREEFORM_CHOICE)
  }
  const selected = await stage(base, deadline,
    async (opts) => await ui.select(prompt, choices, opts))
  if (selected === null) {
    return null
  }
  if (selected === FREEFORM_CHOICE) {
    const answer = await stage(base, deadline,
      async (opts) => await ui.input(prompt, ANSWER_PLACEHOLDER, opts))
    return createFreeformResponse(answer)
  }
  return ask.allowComment
    ? await withComment(ui, prompt, [selected], base, deadline)
    : createSelectionResponse([selected])
}

/**
 * Asks a batch one question at a time; cancelling any question cancels the
 * batch. All dialogs share one deadline.
 *
 * @returns Every answer, or null when cancelled.
 */
async function askBatchViaDialogs (
  ui: DialogUI,
  questions: readonly BatchQuestion[],
  allowComment: boolean,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
  heading: string | undefined
): Promise<BatchAnswer[] | null> {
  const base = signal === undefined ? undefined : { signal }
  const answers: BatchAnswer[] = []
  for (const [index, entry] of questions.entries()) {
    if (signal?.aborted === true) {
      return null
    }
    const title = `${heading === undefined ? '' : `${heading}\n`}` +
      `(${index + 1}/${questions.length}) ${entry.question}`
    let response: AskResponse | null
    if (entry.options.length === 0) {
      const answer = await stage(base, deadline, async (opts) =>
        await ui.input(withContext(title, entry.context),
          ANSWER_PLACEHOLDER, opts))
      response = createFreeformResponse(answer)
    } else {
      response = await askViaDialogs(ui, {
        ...entry, question: title, allowComment
      }, base, deadline)
    }
    if (response === null) {
      return null
    }
    answers.push({ status: 'answered', response })
  }
  return answers
}

export { askBatchViaDialogs, askViaDialogs, FREEFORM_CHOICE, stageOptions }
export type { DialogQuestion, DialogUI }
