import type {
  BatchQuestion,
  DisplayMode,
  QuestionOption,
  SingleSelectLayout
} from './ask-types.ts'

interface BatchQuestionInput {
  readonly question?: unknown
  readonly context?: unknown
  readonly options?: unknown
  readonly allowMultiple?: unknown
  readonly allowFreeform?: unknown
}

/** The tool parameters as they arrive (schema-shaped, still unchecked). */
interface AskParams {
  readonly question?: string
  readonly questions?: readonly BatchQuestionInput[]
  readonly context?: string
  readonly options?: readonly unknown[]
  readonly allowMultiple?: boolean
  readonly allowFreeform?: boolean
  readonly allowComment?: boolean
  readonly displayMode?: DisplayMode
  readonly singleSelectLayout?: SingleSelectLayout
  readonly contextExpanded?: boolean
  readonly overlayToggleKey?: string | null
  readonly commentToggleKey?: string | null
  readonly timeout?: number
}

const BATCH_MIN_QUESTIONS = 2
const BATCH_MAX_QUESTIONS = 4

// Set per entry in a batch, never at the top level.
const BATCH_ENTRY_FIELDS = [
  'context', 'options', 'allowMultiple', 'allowFreeform'
] as const

// Keys models fall back to when a proxy strips the option schema.
const OPTION_TITLE_KEYS = [
  'title', 'label', 'text', 'value', 'name', 'option'
] as const

function nonBlank (value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Accepts an option as a string, number, boolean or an object with a title
 * under any of the common keys.
 *
 * @param option - One raw option.
 * @returns The option, or null when it has no usable title.
 */
function coerceOption (option: unknown): QuestionOption | null {
  if (typeof option === 'string' || typeof option === 'number' ||
    typeof option === 'boolean') {
    const title = String(option).trim()
    return title === '' ? null : { title }
  }
  if (typeof option !== 'object' || option === null) {
    return null
  }
  const record: Readonly<Record<string, unknown>> = { ...option }
  for (const key of OPTION_TITLE_KEYS) {
    const title = nonBlank(record[key])
    if (title !== undefined) {
      const { description } = record
      return typeof description === 'string' && description.trim() !== ''
        ? { title, description }
        : { title }
    }
  }
  return null
}

/**
 * Normalises raw options: drops unusable ones and repeated titles.
 *
 * @param raw - The options as sent.
 * @param where - Where they came from, for the error message.
 * @returns The usable options.
 * @throws When options were sent but none is usable.
 */
function normalizeOptions (raw: unknown, where: string): QuestionOption[] {
  if (raw === undefined || raw === null) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${where} must be an array.`)
  }
  const seen = new Set<string>()
  const options: QuestionOption[] = []
  for (const item of raw) {
    const option = coerceOption(item)
    if (option !== null && !seen.has(option.title)) {
      seen.add(option.title)
      options.push(option)
    }
  }
  if (raw.length > 0 && options.length === 0) {
    throw new Error(
      `All ${raw.length} option(s) in ${where} were malformed, so nothing ` +
      'could be shown to the user. Each option must be a plain string or ' +
      'an object like { "title": "Short label", "description": "Optional ' +
      'detail" }. Call ask_user again with corrected options.'
    )
  }
  return options
}

function normalizeContext (context: unknown): string | undefined {
  return nonBlank(context)
}

/** A top-level question sent with `questions` is the batch heading. */
function batchHeading (params: AskParams): string | undefined {
  return nonBlank(params.question)
}

function batchEntry (
  entry: BatchQuestionInput,
  index: number,
  seen: Set<string>
): BatchQuestion {
  const label = `questions[${index}]`
  const question = nonBlank(entry.question)
  if (question === undefined) {
    throw new Error(`${label}.question must be a non-empty string.`)
  }
  const key = question.toLowerCase()
  if (seen.has(key)) {
    throw new Error(
      `${label} repeats the question "${question}". Each question in a ` +
      'batch must be distinct.'
    )
  }
  seen.add(key)
  const context = normalizeContext(entry.context)
  return {
    question,
    ...(context === undefined ? {} : { context }),
    options: normalizeOptions(entry.options, `${label}.options`),
    allowMultiple: entry.allowMultiple === true,
    allowFreeform: entry.allowFreeform !== false
  }
}

/**
 * Validates a `questions` batch before any UI opens.
 *
 * @param params - The tool parameters.
 * @returns The validated entries.
 * @throws With a message telling the model how to fix the call.
 */
function normalizeBatchQuestions (params: AskParams): BatchQuestion[] {
  const misplaced = BATCH_ENTRY_FIELDS.filter(
    (field) => params[field] !== undefined && params[field] !== null
  )
  if (misplaced.length > 0) {
    throw new Error(
      `${misplaced.join(', ')} cannot be set at the top level together ` +
      'with questions. Set them on each questions entry instead.'
    )
  }
  const { questions } = params
  if (!Array.isArray(questions)) {
    throw new Error(
      `questions must be an array of ${BATCH_MIN_QUESTIONS}-` +
      `${BATCH_MAX_QUESTIONS} question objects.`
    )
  }
  if (questions.length < BATCH_MIN_QUESTIONS) {
    throw new Error(
      `questions needs ${BATCH_MIN_QUESTIONS}-${BATCH_MAX_QUESTIONS} ` +
      `entries but got ${questions.length}. To ask one question, use ` +
      'question instead.'
    )
  }
  if (questions.length > BATCH_MAX_QUESTIONS) {
    throw new Error(
      `questions accepts at most ${BATCH_MAX_QUESTIONS} entries but got ` +
      `${questions.length}. Ask the rest in a later ask_user call.`
    )
  }
  const seen = new Set<string>()
  return questions.map((entry: unknown, index) => batchEntry(
    typeof entry === 'object' && entry !== null ? entry : {},
    index,
    seen
  ))
}

export {
  BATCH_MAX_QUESTIONS,
  BATCH_MIN_QUESTIONS,
  batchHeading,
  coerceOption,
  normalizeBatchQuestions,
  normalizeContext,
  normalizeOptions
}
export type { AskParams, BatchQuestionInput }
