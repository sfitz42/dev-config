type DisplayMode = 'overlay' | 'inline'

type SingleSelectLayout = 'auto' | 'list'

interface QuestionOption {
  readonly title: string
  readonly description?: string
}

interface SelectionResponse {
  readonly kind: 'selection'
  readonly selections: readonly string[]
  readonly comment?: string
}

interface FreeformResponse {
  readonly kind: 'freeform'
  readonly text: string
}

type AskResponse = SelectionResponse | FreeformResponse

/** What the user sees for one question: used by events, results, cards. */
interface QuestionSubject {
  readonly question: string
  readonly context?: string
  readonly options: readonly QuestionOption[]
}

/** One validated `questions` entry. */
interface BatchQuestion extends QuestionSubject {
  readonly allowMultiple: boolean
  readonly allowFreeform: boolean
}

interface AnsweredBatchAnswer {
  readonly status: 'answered'
  readonly response: AskResponse
}

interface SkippedBatchAnswer {
  readonly status: 'skipped'
}

type BatchAnswer = AnsweredBatchAnswer | SkippedBatchAnswer

/** Result details of a single question. */
interface AskToolDetails extends QuestionSubject {
  readonly response: AskResponse | null
  readonly cancelled: boolean
}

/** Result details of a `questions` batch. */
interface AskBatchDetails {
  readonly kind: 'batch'
  readonly heading?: string
  readonly questions: readonly QuestionSubject[]
  /** Index-aligned with `questions`; empty when the batch was cancelled. */
  readonly answers: readonly BatchAnswer[]
  readonly cancelled: boolean
}

type AskDetails = AskToolDetails | AskBatchDetails

function isBatchDetails (details: AskDetails): details is AskBatchDetails {
  return 'kind' in details && details.kind === 'batch'
}

export { isBatchDetails }
export type {
  AnsweredBatchAnswer,
  AskBatchDetails,
  AskDetails,
  AskResponse,
  AskToolDetails,
  BatchAnswer,
  BatchQuestion,
  DisplayMode,
  FreeformResponse,
  QuestionOption,
  QuestionSubject,
  SelectionResponse,
  SingleSelectLayout,
  SkippedBatchAnswer
}
