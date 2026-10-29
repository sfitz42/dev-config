// Optional native presentation in Tern via pi-tern's global-symbol hooks.
// Nothing here imports pi-tern; without it these hooks are never read.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import type { AskResponse } from './ask-types.ts'

const NATIVE_COMPONENT = Symbol.for('pi-tern.component.v1')
const NATIVE_TOOLS = Symbol.for('pi-tern.tools.v1')

/** The key of the answer list; list events carry it as their id's tail. */
const CHOICE_LIST_KEY = 'options'

type Json = string | number | boolean | null | undefined | readonly Json[] |
  { readonly [key: string]: Json }

/** A pointer or action event from Tern. */
type TernEvent = Readonly<Record<string, Json>>

interface TernNode {
  readonly k: string
  readonly key?: string
  readonly p: Readonly<Record<string, Json>>
  readonly c: readonly TernNode[]
}

/** A text field Tern's native edits write back into. */
interface TernField {
  getText: () => string
  setText: (text: string) => void
}

interface TernContext {
  requestRender: () => void
  onEvent: (handler: (event: TernEvent) => void) => void
  field: (target: TernField) => void
}

/** A component that can render itself as a native Tern sheet. */
interface TernNative {
  [NATIVE_COMPONENT]: (native: TernContext) => TernNode
}

type CallStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

interface TernToolCall {
  readonly name: string
  readonly args: Readonly<Record<string, Json>>
  readonly result: { readonly details?: unknown } | undefined
  readonly status: CallStatus
}

type TernToolRenderer = (call: TernToolCall) => TernNode | undefined

interface ChoiceRow {
  readonly id: string
  readonly kind: 'option' | 'comment' | 'freeform'
  readonly label: string
  readonly detail?: string
  /** A ticked option, or the comment toggle when on. */
  readonly on?: boolean
}

interface QuestionTabs {
  readonly tabs: ReadonlyArray<{ readonly id: string, readonly label: string }>
  readonly tab: string
  readonly heading?: string
}

interface ChoiceList {
  readonly rows: readonly ChoiceRow[]
  readonly selected: number
  readonly query?: string
}

interface ChoiceSheet extends ChoiceList {
  readonly question: string
  readonly context?: string
  readonly multiple: boolean
  readonly tabs?: QuestionTabs
}

interface TextSheet {
  readonly question: string
  readonly context?: string
  readonly lead?: string
  readonly text: string
  readonly cursor: number
  readonly placeholder: string
  readonly escape: 'back' | 'cancel'
  readonly tabs?: QuestionTabs
}

interface ReviewSheet {
  readonly rows: ReadonlyArray<{
    readonly question: string
    readonly answer?: string
  }>
  readonly tabs: QuestionTabs
  readonly confirmSkips: boolean
}

/** The last segment of a dotted node id. */
function nodeKey (id: Json): string {
  return String(id).split('.').pop() ?? ''
}

function node (
  k: string,
  p: Readonly<Record<string, Json>> = {},
  children: ReadonlyArray<TernNode | null> = [],
  key?: string
): TernNode {
  const c = children.filter((child): child is TernNode => child !== null)
  return key === undefined ? { k, p, c } : { k, key, p, c }
}

function button (
  label: string,
  act: string,
  keys: string,
  tone?: string
): TernNode {
  return node('row', {
    role: 'omp.btn',
    gap: 'xs',
    align: 'center',
    actions: { click: act },
    title: `${label}  ${keys}`,
    tone
  }, [node('text', { text: label }), node('kbd', { keys: [keys] })], act)
}

function actionBar (buttons: readonly TernNode[]): TernNode {
  return node('row', { role: 'omp.actions', gap: 'sm', align: 'center' },
    [node('spacer', { grow: 1 }), ...buttons], 'actions')
}

function askSheet (
  tabs: QuestionTabs | undefined,
  children: ReadonlyArray<TernNode | null>
): TernNode {
  const head = tabs === undefined
    ? null
    : node('row', { role: 'omp.ask.head', gap: 'sm', align: 'center' }, [
      node('tabs', {
        items: tabs.tabs.map((tab) => ({ id: tab.id, label: tab.label })),
        active: tabs.tab,
        role: 'omp.ask.questions',
        actions: { click: 'select' }
      }, [], 'tabs')
    ], 'head')
  const heading = tabs?.heading === undefined
    ? null
    : node('md', { text: tabs.heading, role: 'omp.ask.heading' }, [], 'heading')
  return node('overlay', {
    role: 'omp.overlay.ask', anchor: 'bottom', size: 'md', modal: true
  }, [node('col', { gap: 'md' }, [head, heading, ...children], 'sheet')])
}

function questionNodes (question: string, context?: string): TernNode[] {
  const nodes = [
    node('md', { text: question, role: 'omp.ask.question' }, [], 'question')
  ]
  if (context !== undefined) {
    nodes.push(
      node('md', { text: context, role: 'omp.tool.context' }, [], 'context'))
  }
  return nodes
}

function rowRole (row: ChoiceRow, multiple: boolean): string {
  if (row.kind === 'freeform') {
    return 'omp.ask.other'
  }
  return multiple && row.kind === 'option' ? 'omp.ask.check' : 'omp.ask.option'
}

function rowDetail (row: ChoiceRow): Json {
  if (row.detail !== undefined) {
    return [{ t: row.detail }]
  }
  return row.kind === 'freeform'
    ? [{ t: 'Type your own answer', s: 'dim' }]
    : undefined
}

/** A question's answers as a native list with an action bar. */
function choiceSheet (sheet: ChoiceSheet): TernNode {
  const items = sheet.rows.map((row) => node('item', {
    label: [{ t: row.label }],
    detail: rowDetail(row),
    role: rowRole(row, sheet.multiple),
    icon: row.on === true ? 'check' : undefined,
    tone: row.on === true ? 'success' : undefined
  }, [], row.id))
  const filter = sheet.query === undefined || sheet.query === ''
    ? null
    : node('text', {
      spans: [{ t: 'Filter ', s: 'muted' }, { t: sheet.query, s: 'accent' }]
    }, [], 'filter')
  return askSheet(sheet.tabs, [
    ...questionNodes(sheet.question, sheet.context),
    filter,
    node('list', {
      selected: sheet.rows[sheet.selected]?.id ?? null,
      role: 'omp.ask.options',
      empty: 'No matching options'
    }, items, CHOICE_LIST_KEY),
    actionBar([
      button('Cancel', 'cancel', 'esc'),
      button(sheet.multiple ? 'Submit' : 'Select', 'submit', 'enter', 'accent')
    ])
  ])
}

/** A custom response or comment over a native editor. */
function textSheet (sheet: TextSheet): TernNode {
  const lead = sheet.lead === undefined
    ? null
    : node('text', { spans: [{ t: sheet.lead, s: 'muted' }], wrap: 'word' },
      [], 'lead')
  return askSheet(sheet.tabs, [
    ...questionNodes(sheet.question, sheet.context),
    lead,
    node('editor', {
      text: sheet.text,
      cursor: sheet.cursor,
      maxLines: 8,
      placeholder: sheet.placeholder
    }, [], 'field'),
    actionBar([
      button(sheet.escape === 'back' ? 'Back' : 'Cancel', 'cancel', 'esc'),
      button('Submit', 'submit', 'enter', 'accent')
    ])
  ])
}

/** The batch review page as key/value pairs. */
function reviewSheet (sheet: ReviewSheet): TernNode {
  const unanswered = sheet.rows.filter((row) => row.answer === undefined).length
  const noun = unanswered === 1 ? 'question' : 'questions'
  const them = unanswered === 1 ? 'it' : 'them'
  const warningText = sheet.confirmSkips
    ? `${unanswered} unanswered ${noun} — submit again to skip ${them}.`
    : `${unanswered} unanswered ${noun}.`
  const warning = unanswered === 0
    ? null
    : node('text', { spans: [{ t: warningText, s: 'warning' }] }, [], 'warning')
  const submitLabel = unanswered > 0 && sheet.confirmSkips
    ? 'Submit with skips'
    : 'Submit'
  return askSheet(sheet.tabs, [
    warning,
    node('kv', {
      items: sheet.rows.map((row, index) => ({
        k: `${index + 1}. ${row.question}`,
        v: row.answer === undefined
          ? [{ t: 'unanswered', s: 'warning' }]
          : [{ t: row.answer }]
      }))
    }, [], 'answers'),
    actionBar([
      button('Cancel', 'cancel', 'esc'),
      button(submitLabel, 'submit', 'enter', 'accent')
    ])
  ])
}

// ── Tool card ────────────────────────────────────────────────────────────

interface CardQuestion {
  readonly question: string
  readonly options: ReadonlyArray<{ readonly title: string }>
}

interface CardAnswer {
  readonly status: string
  readonly response?: AskResponse
}

function isRecord (value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstLine (text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}

/** Option titles from raw call arguments (models may send strings). */
function argOptions (value: unknown): Array<{ title: string }> {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((option: unknown) => {
    if (isRecord(option)) {
      return typeof option.title === 'string' && option.title !== ''
        ? [{ title: option.title }]
        : []
    }
    return option === null || option === undefined
      ? []
      : [{ title: String(option) }]
  })
}

function asResponse (value: unknown): AskResponse | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (value.kind === 'freeform' && typeof value.text === 'string') {
    return { kind: 'freeform', text: value.text }
  }
  if (value.kind === 'selection' && Array.isArray(value.selections)) {
    const selections = value.selections.filter(
      (item: unknown): item is string => typeof item === 'string')
    return typeof value.comment === 'string'
      ? { kind: 'selection', selections, comment: value.comment }
      : { kind: 'selection', selections }
  }
  return undefined
}

function answerRows (
  options: CardQuestion['options'],
  response: AskResponse | undefined
): TernNode[] {
  if (response === undefined) {
    return [node('text', { text: 'Cancelled', tone: 'warning' }, [], 'cancelled')]
  }
  const chosen = new Set(response.kind === 'selection' ? response.selections : [])
  const row = (label: string, on: boolean, key: string): TernNode =>
    node('row', {
      gap: 'sm',
      align: 'baseline',
      role: on ? 'omp.tool.answer' : 'omp.tool.answer.off'
    }, [
      on ? node('icon', { name: 'check', tone: 'success' }) : null,
      node('text', { spans: [{ t: label, s: on ? 'strong' : 'muted' }], wrap: 'word' })
    ], key)
  const rows = options.map((option, index) =>
    row(option.title, chosen.has(option.title), `o${index}`))
  if (response.kind === 'freeform') {
    rows.push(row(`“${response.text}”`, true, 'custom'))
  } else if (response.comment !== undefined) {
    rows.push(node('text', {
      spans: [{ t: response.comment, s: 'muted' }],
      wrap: 'word',
      role: 'omp.tool.context'
    }, [], 'comment'))
  }
  return rows
}

function cardQuestions (value: unknown): CardQuestion[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.question !== 'string') {
      return []
    }
    return [{ question: entry.question, options: argOptions(entry.options) }]
  })
}

function cardAnswers (value: unknown): CardAnswer[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) {
      return { status: 'skipped' }
    }
    const response = asResponse(entry.response)
    return response === undefined
      ? { status: String(entry.status) }
      : { status: String(entry.status), response }
  })
}

function waitingRows (options: CardQuestion['options']): TernNode[] {
  return options.map((option, index) =>
    node('text', { spans: [{ t: option.title, s: 'muted' }] }, [], `o${index}`))
}

function batchCard (
  call: TernToolCall,
  details: Readonly<Record<string, unknown>> | undefined,
  settled: boolean
): TernNode {
  const fromDetails = cardQuestions(details?.questions)
  const questions = fromDetails.length > 0
    ? fromDetails
    : cardQuestions(call.args.questions)
  const answers = cardAnswers(details?.answers)
  const cancelled = details?.cancelled === true
  const sections = questions.map((entry, index) => {
    const answer = answers[index]
    let body: TernNode[]
    if (!settled) {
      body = waitingRows(entry.options)
    } else if (cancelled) {
      body = [node('text', { text: 'Cancelled', tone: 'warning' }, [], 'cancelled')]
    } else if (answer?.status === 'answered') {
      body = answerRows(entry.options, answer.response)
    } else {
      body = [node('text', { text: 'Skipped', tone: 'muted' }, [], 'skipped')]
    }
    return node('section', {
      head: [{ t: `${index + 1}. `, s: 'muted' }, { t: entry.question }]
    }, body, `q${index}`)
  })
  const heading = typeof details?.heading === 'string'
    ? details.heading
    : typeof call.args.question === 'string'
      ? call.args.question
      : questions[0]?.question ?? ''
  const waiting = settled
    ? null
    : node('text', { spans: [{ t: 'Waiting for your answers…', s: 'muted' }] },
      [], 'waiting')
  return node('tool', {
    title: 'Ask',
    target: firstLine(heading),
    targetKind: 'text',
    meta: [`${questions.length} questions`]
  }, [...sections, waiting])
}

function singleCard (
  call: TernToolCall,
  details: Readonly<Record<string, unknown>> | undefined,
  settled: boolean
): TernNode {
  const question = typeof details?.question === 'string'
    ? details.question
    : String(call.args.question ?? '')
  const context = typeof details?.context === 'string'
    ? details.context
    : typeof call.args.context === 'string' ? call.args.context : undefined
  const fromDetails = argOptions(details?.options)
  const options = fromDetails.length > 0
    ? fromDetails
    : argOptions(call.args.options)
  const response = details?.cancelled === true
    ? undefined
    : asResponse(details?.response)
  const body = settled
    ? answerRows(options, response)
    : [
        ...waitingRows(options),
        node('text', { spans: [{ t: 'Waiting for your answer…', s: 'muted' }] },
          [], 'waiting')
      ]
  return node('tool', {
    title: 'Ask', target: firstLine(question), targetKind: 'text'
  }, [
    question.trim() === firstLine(question)
      ? null
      : node('md', { text: question }, [], 'question'),
    context === undefined
      ? null
      : node('md', { text: context, role: 'omp.tool.context' }, [], 'context'),
    ...body
  ])
}

/**
 * The ask_user tool card: each question over its options, chosen ones
 * checked.
 *
 * @param call - The call as Tern reports it.
 * @returns The card, or undefined for failed calls.
 */
function askToolCard (call: TernToolCall): TernNode | undefined {
  if (call.status === 'error') {
    return undefined
  }
  const raw = call.result?.details
  const details = isRecord(raw) ? raw : undefined
  const settled = call.status === 'done' && details !== undefined
  const batch = details?.kind === 'batch' || Array.isArray(call.args.questions)
  return batch
    ? batchCard(call, details, settled)
    : singleCard(call, details, settled)
}

type TernRegistry = typeof globalThis & {
  [NATIVE_TOOLS]?: Map<string, TernToolRenderer>
}

/**
 * Registers a native tool card in pi-tern's global registry. The entry is
 * restored on session start and removed on shutdown unless replaced.
 *
 * @param pi - The extension API.
 * @param name - The tool name.
 * @param renderer - The card renderer.
 */
function registerTernTool (
  pi: Pick<ExtensionAPI, 'on'>,
  name: string,
  renderer: TernToolRenderer
): void {
  const registry: TernRegistry = globalThis
  const tools = registry[NATIVE_TOOLS] ?? new Map<string, TernToolRenderer>()
  registry[NATIVE_TOOLS] = tools
  tools.set(name, renderer)
  pi.on('session_start', () => {
    tools.set(name, renderer)
  })
  pi.on('session_shutdown', () => {
    if (tools.get(name) === renderer) {
      tools.delete(name)
    }
  })
}

export {
  askToolCard,
  CHOICE_LIST_KEY,
  choiceSheet,
  NATIVE_COMPONENT,
  nodeKey,
  registerTernTool,
  reviewSheet,
  textSheet
}
export type {
  ChoiceList,
  ChoiceRow,
  QuestionTabs,
  TernContext,
  TernEvent,
  TernNative,
  TernNode,
  TernToolCall
}
