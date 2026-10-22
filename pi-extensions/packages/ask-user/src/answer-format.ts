import type {
  AskBatchDetails,
  AskResponse,
  BatchQuestion,
  QuestionOption
} from './ask-types.ts'

/**
 * Builds a freeform answer, or null when the text is blank (a cancel).
 *
 * @param text - What the user typed; undefined or null means cancelled.
 * @returns The response, or null.
 */
function createFreeformResponse (
  text: string | null | undefined
): AskResponse | null {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? null : { kind: 'freeform', text: trimmed }
}

/**
 * Builds a selection answer from option titles and an optional comment.
 *
 * @param selections - Chosen option titles; blanks are dropped.
 * @param comment - Optional extra context; blank means none.
 * @returns The response, or null when nothing was selected.
 */
function createSelectionResponse (
  selections: readonly string[],
  comment?: string | null
): AskResponse | null {
  const chosen = selections.map((title) => title.trim())
    .filter((title) => title !== '')
  if (chosen.length === 0) {
    return null
  }
  const note = comment?.trim() ?? ''
  return note === ''
    ? { kind: 'selection', selections: chosen }
    : { kind: 'selection', selections: chosen, comment: note }
}

function formatResponseSummary (response: AskResponse): string {
  if (response.kind === 'freeform') {
    return response.text
  }
  const chosen = response.selections.join(', ')
  return response.comment === undefined
    ? chosen
    : `${chosen} — ${response.comment}`
}

function formatOptionsForMessage (options: readonly QuestionOption[]): string {
  return options.map((option, index) => {
    const detail = option.description === undefined
      ? ''
      : ` — ${option.description}`
    return `${index + 1}. ${option.title}${detail}`
  }).join('\n')
}

function withContext (question: string, context: string | undefined): string {
  return context === undefined ? question : `${question}\n\nContext:\n${context}`
}

function buildCommentPrompt (
  prompt: string,
  selections: readonly string[]
): string {
  const label = selections.length === 1
    ? 'Selected option'
    : 'Selected options'
  const list = selections.map((title) => `- ${title}`).join('\n')
  return `${prompt}\n\n${label}:\n${list}`
}

function parseDialogSelections (input: string): string[] {
  return input.split(',').map((part) => part.trim())
    .filter((part) => part !== '')
}

function formatBatchAnswers (details: AskBatchDetails): string {
  const lines = details.questions.map((subject, index) => {
    const answer = details.answers[index]
    const summary = answer?.status === 'answered'
      ? formatResponseSummary(answer.response)
      : '(skipped)'
    return `${index + 1}. ${subject.question} → ${summary}`
  })
  const answered = details.answers
    .filter((answer) => answer.status === 'answered').length
  return [
    ...(details.heading === undefined ? [] : [details.heading]),
    `User answered ${answered} of ${details.questions.length} questions:`,
    ...lines
  ].join('\n')
}

const COMMENT_HINT =
  'After choosing an option, you may add an optional comment.'

/**
 * The error text for a single question when no UI is available, so the
 * model can ask the user in plain text instead.
 *
 * @returns The full message.
 */
function nonInteractiveMessage (
  question: string,
  context: string | undefined,
  options: readonly QuestionOption[],
  allowFreeform: boolean,
  allowComment: boolean
): string {
  const parts = [`Ask requires interactive mode. Please answer:\n\n${question}`]
  if (context !== undefined) {
    parts.push(`Context:\n${context}`)
  }
  if (options.length > 0) {
    parts.push(`Options:\n${formatOptionsForMessage(options)}`)
  }
  if (allowFreeform) {
    parts.push('You can also answer freely.')
  }
  if (allowComment) {
    parts.push(COMMENT_HINT)
  }
  return parts.join('\n\n')
}

/**
 * The error text for a batch when no UI is available.
 *
 * @returns The full message.
 */
function batchNonInteractiveMessage (
  questions: readonly BatchQuestion[],
  allowComment: boolean,
  heading: string | undefined
): string {
  const blocks = questions.map((entry, index) => {
    const lines = [`${index + 1}. ${entry.question}`]
    if (entry.context !== undefined) {
      lines.push(`   Context: ${entry.context.replace(/\n/g, '\n   ')}`)
    }
    if (entry.options.length > 0) {
      const multiple = entry.allowMultiple ? ' (choose one or more)' : ''
      lines.push(`   Options${multiple}:`)
      for (const line of formatOptionsForMessage(entry.options).split('\n')) {
        lines.push(`   ${line}`)
      }
      if (entry.allowFreeform) {
        lines.push('   You can also answer freely.')
      }
    }
    return lines.join('\n')
  })
  return [
    'Ask requires interactive mode. Please answer these questions:',
    ...(heading === undefined ? [] : [heading]),
    ...blocks,
    ...(allowComment ? [COMMENT_HINT] : [])
  ].join('\n\n')
}

export {
  batchNonInteractiveMessage,
  buildCommentPrompt,
  createFreeformResponse,
  createSelectionResponse,
  formatBatchAnswers,
  formatOptionsForMessage,
  formatResponseSummary,
  nonInteractiveMessage,
  parseDialogSelections,
  withContext
}
