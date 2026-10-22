import { formatResponseSummary } from './answer-format.ts'
import { coerceOption } from './ask-params.ts'
import { isBatchDetails } from './ask-types.ts'

import type { Theme } from '@earendil-works/pi-coding-agent'

import type {
  AskBatchDetails,
  AskDetails,
  AskResponse,
  QuestionOption,
  SelectionResponse
} from './ask-types.ts'

interface CallArgs {
  readonly question?: unknown
  readonly questions?: unknown
  readonly options?: unknown
  readonly allowMultiple?: unknown
  readonly allowComment?: unknown
}

interface ResultView {
  readonly details: AskDetails | undefined
  /** The result's text content, joined. */
  readonly text: string
  readonly isError: boolean
  readonly isPartial: boolean
  readonly expanded: boolean
}

function isRecord (value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function batchCallText (
  args: CallArgs,
  entries: readonly unknown[],
  theme: Theme
): string {
  let text = theme.fg('toolTitle', theme.bold('ask_user ')) +
    theme.fg('muted', `${entries.length} questions`)
  if (typeof args.question === 'string' && args.question.trim() !== '') {
    text += theme.fg('text', ` · ${args.question.trim().replace(/\s+/g, ' ')}`)
  }
  if (args.allowComment === true) {
    text += theme.fg('dim', ' [optional comment]')
  }
  entries.forEach((entry, index) => {
    const record = isRecord(entry) ? entry : {}
    const question = typeof record.question === 'string' ? record.question : ''
    const count = Array.isArray(record.options) ? record.options.length : 0
    const notes = [
      count > 0 ? `${count} option(s)` : '',
      record.allowMultiple === true ? 'multi-select' : ''
    ].filter((note) => note !== '').join(', ')
    const suffix = notes === '' ? '' : ` (${notes})`
    text += '\n' + theme.fg('dim', `  ${index + 1}. ${question}${suffix}`)
  })
  return text
}

/**
 * The one-line (or per-entry) summary of a call shown while it runs.
 *
 * @param args - The raw call arguments.
 * @param theme - The active theme.
 * @returns Styled text.
 */
function renderCallText (args: CallArgs, theme: Theme): string {
  if (Array.isArray(args.questions)) {
    return batchCallText(args, args.questions, theme)
  }
  const question = typeof args.question === 'string' ? args.question : ''
  let text = theme.fg('toolTitle', theme.bold('ask_user ')) +
    theme.fg('muted', question)
  const raw: readonly unknown[] = Array.isArray(args.options)
    ? args.options
    : []
  if (raw.length > 0) {
    const titles = raw.map((option) => coerceOption(option)?.title ?? '<invalid>')
    text += '\n' + theme.fg('dim',
      `  ${raw.length} option(s): ${titles.join(', ')}`)
  }
  if (args.allowMultiple === true) {
    text += theme.fg('dim', ' [multi-select]')
  }
  if (args.allowComment === true) {
    text += theme.fg('dim', ' [optional comment]')
  }
  return text
}

/** Every option, chosen ones marked `●`, then the comment. */
function optionMarkers (
  theme: Theme,
  options: readonly QuestionOption[],
  response: SelectionResponse,
  indent = ''
): string {
  const chosen = new Set(response.selections)
  let text = `\n${indent}${theme.fg('dim', 'Options:')}`
  for (const option of options) {
    const detail = option.description === undefined
      ? ''
      : ` — ${option.description}`
    const marker = chosen.has(option.title)
      ? theme.fg('success', '●')
      : theme.fg('dim', '○')
    text += `\n${indent}  ${marker} ${theme.fg('dim', option.title)}` +
      theme.fg('dim', detail)
  }
  if (response.comment !== undefined) {
    text += `\n${indent}${theme.fg('dim', 'Comment:')} ` +
      theme.fg('dim', response.comment)
  }
  return text
}

function answerText (theme: Theme, response: AskResponse): string {
  const wrote = response.kind === 'freeform' ? theme.fg('muted', '(wrote) ') : ''
  return wrote + theme.fg('accent', formatResponseSummary(response))
}

function batchResultText (
  theme: Theme,
  details: AskBatchDetails,
  expanded: boolean
): string {
  if (details.cancelled) {
    return theme.fg('warning', 'Cancelled')
  }
  const answered = details.answers
    .filter((answer) => answer.status === 'answered').length
  let text = theme.fg('success', '✓ ') +
    theme.fg('accent', `${answered} of ${details.questions.length} answered`)
  details.questions.forEach((subject, index) => {
    const answer = details.answers[index]
    text += `\n${theme.fg('dim', `${index + 1}.`)} ` +
      theme.fg('muted', subject.question) + theme.fg('dim', ' → ')
    if (answer === undefined || answer.status === 'skipped') {
      text += theme.fg('warning', '(skipped)')
      return
    }
    text += answerText(theme, answer.response)
    if (!expanded) {
      return
    }
    if (subject.context !== undefined) {
      text += `\n   ${theme.fg('dim', subject.context)}`
    }
    if (answer.response.kind === 'selection' && subject.options.length > 0) {
      text += optionMarkers(theme, subject.options, answer.response, '   ')
    }
  })
  return text
}

/**
 * The result line(s) shown under the call.
 *
 * @param view - The result and how it is being shown.
 * @param theme - The active theme.
 * @returns Styled text.
 */
function renderResultText (view: ResultView, theme: Theme): string {
  const { details } = view
  if (view.isError) {
    const message = view.text.trim() === '' ? 'ask_user failed' : view.text.trim()
    return theme.fg('error', `✗ ${message}`)
  }
  if (view.isPartial) {
    const waiting = view.text.trim() === ''
      ? 'Waiting for user input...'
      : view.text.trim()
    return theme.fg('muted', waiting)
  }
  if (details !== undefined && isBatchDetails(details)) {
    return batchResultText(theme, details, view.expanded)
  }
  if (details === undefined || details.cancelled || details.response === null) {
    return theme.fg('warning', 'Cancelled')
  }
  const { response } = details
  let text = theme.fg('success', '✓ ') + answerText(theme, response)
  if (view.expanded) {
    text += '\n' + theme.fg('dim', `Q: ${details.question}`)
    if (details.context !== undefined) {
      text += '\n' + theme.fg('dim', details.context)
    }
    if (response.kind === 'selection' && details.options.length > 0) {
      text += optionMarkers(theme, details.options, response)
    }
  }
  return text
}

export { renderCallText, renderResultText }
export type { CallArgs, ResultView }
