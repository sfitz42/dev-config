import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { formatResponseSummary } from './answer-format.ts'
import { AskComponent } from './ask-component.ts'
import { frame, innerWidth } from './box-frame.ts'
import {
  bindingHint,
  digitIndex,
  joinHints,
  literalHint,
  matchesSelectDown,
  matchesSelectUp
} from './key-input.ts'
import { reviewMaxLines } from './layout.ts'
import { NATIVE_COMPONENT, nodeKey, reviewSheet } from './tern.ts'
import { VERSION } from './version.ts'

import type { Component, Focusable } from '@earendil-works/pi-tui'

import type { AskEnvironment } from './ask-component.ts'
import type {
  AskResponse,
  BatchAnswer,
  BatchQuestion
} from './ask-types.ts'
import type {
  QuestionTabs,
  TernContext,
  TernNative,
  TernNode
} from './tern.ts'

// Answer rows the review page keeps before squeezing its footer.
const REVIEW_MIN_CONTENT_ROWS = 3
const HEADING_TITLE_WIDTH = 40
const TAB_LABEL_WIDTH = 28

/**
 * Builds the frame title for a batch: question numbers (✓ when answered,
 * brackets on the current page) and the review page.
 *
 * @returns The one-line title.
 */
function batchTitle (
  answered: readonly boolean[],
  current: number,
  heading: string | undefined
): string {
  const labels = answered.map((done, index) => {
    const label = `${index + 1}${done ? '✓' : ''}`
    return index === current ? `[${label}]` : label
  })
  const review = current === answered.length ? '[review]' : 'review'
  const head = heading === undefined
    ? ''
    : ` · ${truncateToWidth(heading.replace(/\s+/g, ' '),
      HEADING_TITLE_WIDTH, '…')}`
  return `ask_user${head} ${labels.join(' ')} · ${review}`
}

/**
 * One prompt for a `questions` batch: a page per question and a review
 * page. Pages stay alive, so filters, ticks and drafts survive navigation;
 * only the review page submits, and cancelling any page cancels the batch.
 */
class BatchAskComponent implements Component, Focusable, TernNative {
  private readonly pages: AskComponent[]
  private readonly answers: Array<AskResponse | undefined>
  private current = 0
  private title = ''
  private confirmingSkips = false
  private tabs: QuestionTabs = { tabs: [], tab: 'q0' }
  private reviewScroll = 0
  private reviewMaxScroll = 0
  private focusedState = false

  constructor (
    private readonly questions: readonly BatchQuestion[],
    private readonly env: AskEnvironment,
    private readonly onDone: (answers: BatchAnswer[] | null) => void,
    private readonly heading?: string
  ) {
    this.answers = questions.map(() => undefined)
    this.pages = questions.map((entry, index) => new AskComponent(
      entry, env, (result) => this.pageDone(index, result)))
    this.updateChrome()
  }

  get focused (): boolean {
    return this.focusedState
  }

  set focused (value: boolean) {
    this.focusedState = value
    const page = this.pages[this.current]
    if (page !== undefined) {
      page.focused = value
    }
  }

  invalidate (): void {
    for (const page of this.pages) {
      page.invalidate()
    }
  }

  render (width: number): string[] {
    return this.pages[this.current]?.render(width) ?? this.renderReview(width)
  }

  handleInput (data: string): void {
    const pageCount = this.questions.length + 1
    // Tab moves between pages; arrows and ctrl+j/k still move in a list.
    if (matchesKey(data, Key.tab)) {
      this.goTo((this.current + 1) % pageCount)
      return
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.goTo((this.current + pageCount - 1) % pageCount)
      return
    }
    const page = this.pages[this.current]
    if (page === undefined) {
      this.reviewInput(data)
    } else {
      page.handleInput(data)
    }
  }

  private pageDone (index: number, result: AskResponse | null): void {
    if (result === null) {
      this.onDone(null)
      return
    }
    this.answers[index] = result
    const count = this.questions.length
    for (let step = 1; step <= count; step++) {
      const next = (index + step) % count
      if (this.answers[next] === undefined) {
        this.goTo(next)
        return
      }
    }
    this.goTo(count)
  }

  private goTo (target: number): void {
    const previous = this.pages[this.current]
    if (previous !== undefined) {
      previous.focused = false
    }
    this.current = target
    this.confirmingSkips = false
    this.reviewScroll = 0
    const next = this.pages[target]
    if (next !== undefined) {
      next.focused = this.focusedState
    }
    this.updateChrome()
    this.env.tui.requestRender()
  }

  private goToTab (id: string): void {
    const target = id === 'review' ? this.questions.length : Number(id.slice(1))
    if (Number.isInteger(target) && target >= 0 &&
      target <= this.questions.length && target !== this.current) {
      this.goTo(target)
    }
  }

  private updateChrome (): void {
    const answered = this.answers.map((answer) => answer !== undefined)
    this.title = batchTitle(answered, this.current, this.heading)
    const hint = literalHint(this.env.theme, 'tab/shift+tab', 'questions')
    this.tabs = {
      tabs: [
        ...this.questions.map((entry, index) => ({
          id: `q${index}`,
          label: `${answered[index] === true ? '✓ ' : ''}` +
            truncateToWidth(entry.question, TAB_LABEL_WIDTH, '…')
        })),
        { id: 'review', label: 'Review' }
      ],
      tab: this.current < this.questions.length ? `q${this.current}` : 'review',
      ...(this.heading === undefined ? {} : { heading: this.heading })
    }
    for (const page of this.pages) {
      page.setBatchChrome(this.title, hint)
      page.setNativeTabs(this.tabs, (id) => this.goToTab(id))
    }
  }

  private unansweredCount (): number {
    return this.answers.filter((answer) => answer === undefined).length
  }

  /** Submits from review; with gaps, the first submit asks to confirm. */
  private submitReview (): void {
    if (this.unansweredCount() > 0 && !this.confirmingSkips) {
      this.confirmingSkips = true
      this.env.tui.requestRender()
      return
    }
    this.onDone(this.answers.map((response): BatchAnswer =>
      response === undefined
        ? { status: 'skipped' }
        : { status: 'answered', response }))
  }

  private reviewInput (data: string): void {
    const { keys, tui } = this.env
    if (keys.matches(data, 'tui.select.cancel')) {
      this.onDone(null)
      return
    }
    if (keys.matches(data, 'tui.select.confirm')) {
      this.submitReview()
      return
    }
    const digit = digitIndex(data)
    if (digit !== undefined && digit < this.questions.length) {
      this.goTo(digit)
      return
    }
    const page = Math.max(1, this.reviewCap() - 4)
    let by = 0
    if (matchesSelectUp(data, keys)) {
      by = -1
    } else if (matchesSelectDown(data, keys)) {
      by = 1
    } else if (matchesKey(data, Key.pageUp)) {
      by = -page
    } else if (matchesKey(data, Key.pageDown)) {
      by = page
    }
    if (by !== 0) {
      this.reviewScroll = Math.max(0,
        Math.min(this.reviewScroll + by, this.reviewMaxScroll))
      tui.requestRender()
    }
  }

  private reviewCap (): number {
    return reviewMaxLines(this.env.tui.terminal.rows,
      this.env.settings.displayMode)
  }

  private reviewFooter (inner: number, capacity: number): string[] {
    const { theme, keys, settings } = this.env
    const unanswered = this.unansweredCount()
    const count = this.questions.length
    const { overlayToggle } = settings.shortcuts
    const hints = theme.fg('dim', joinHints([
      bindingHint(theme, keys, 'tui.select.confirm',
        unanswered > 0 ? 'submit with skips' : 'submit'),
      literalHint(theme, count > 1 ? `1-${count}` : '1', 'edit'),
      literalHint(theme, 'tab/shift+tab', 'questions'),
      settings.displayMode === 'overlay' && !overlayToggle.disabled
        ? literalHint(theme, overlayToggle.spec, 'hide')
        : undefined,
      bindingHint(theme, keys, 'tui.select.cancel', 'cancel')
    ]))
    const confirmKeys = keys.getKeys('tui.select.confirm').join('/')
    const warning = this.confirmingSkips
      ? theme.fg('warning', `${unanswered} unanswered — press ` +
        `${confirmKeys} again to submit with skips`)
      : undefined
    const footer = [
      '',
      ...(warning === undefined ? [] : wrapTextWithAnsi(warning, inner)),
      ...wrapTextWithAnsi(hints, inner)
    ]
    // On short prompts keep room for answers: one line each, no spacer.
    return capacity - footer.length < REVIEW_MIN_CONTENT_ROWS
      ? [...(warning === undefined ? [] : [warning]), hints]
      : footer
  }

  private renderReview (width: number): string[] {
    const { theme } = this.env
    const inner = innerWidth(width)
    // Leave two cells for the overflow marker so marking never truncates.
    const wrap = (text: string): string[] =>
      wrapTextWithAnsi(text, Math.max(1, inner - 2))
    const content = [
      ...wrap(theme.fg('accent', theme.bold('Review answers'))),
      ...(this.heading === undefined
        ? []
        : wrap(theme.fg('text', this.heading))),
      ''
    ]
    this.questions.forEach((entry, index) => {
      const response = this.answers[index]
      const marker = response === undefined
        ? theme.fg('warning', '○')
        : theme.fg('success', '✓')
      content.push(...wrap(
        `${marker} ${theme.fg('text', `${index + 1}. ${entry.question}`)}`))
      content.push(...wrap(response === undefined
        ? `   ${theme.fg('warning', 'unanswered')}`
        : `   ${theme.fg('dim', '→')} ` +
          theme.fg('accent', formatResponseSummary(response))))
    })

    const capacity = Math.max(1, this.reviewCap() - 2)
    const footer = this.reviewFooter(inner, capacity)
    const budget = Math.max(1, capacity - footer.length)
    this.reviewMaxScroll = Math.max(0, content.length - budget)
    this.reviewScroll = Math.min(this.reviewScroll, this.reviewMaxScroll)
    const visible = content.slice(this.reviewScroll, this.reviewScroll + budget)
    const above = this.reviewScroll > 0
    const below = this.reviewScroll < this.reviewMaxScroll
    const mark = (index: number, symbol: string): void => {
      visible[index] = `${theme.fg('dim', symbol)} ${visible[index] ?? ''}`
    }
    const last = visible.length - 1
    if (above && below && last === 0) {
      mark(0, '↕')
    } else {
      if (above) {
        mark(0, '↑')
      }
      if (below) {
        mark(last, '↓')
      }
    }
    return frame(theme, this.title, `v${VERSION}`, [...visible, ...footer],
      width)
  }

  [NATIVE_COMPONENT] (native: TernContext): TernNode {
    const page = this.pages[this.current]
    if (page !== undefined) {
      return page[NATIVE_COMPONENT](native)
    }
    native.onEvent((event) => {
      if (event.ev === 'select' && nodeKey(event.id) === 'tabs') {
        this.goToTab(nodeKey(event.item))
      } else if (event.ev === 'action') {
        if (event.act === 'cancel' || event.act === 'close') {
          this.onDone(null)
        } else if (event.act === 'submit') {
          this.submitReview()
        }
      }
    })
    return reviewSheet({
      rows: this.questions.map((entry, index) => {
        const response = this.answers[index]
        return response === undefined
          ? { question: entry.question }
          : {
              question: entry.question,
              answer: formatResponseSummary(response)
            }
      }),
      tabs: this.tabs,
      confirmSkips: this.confirmingSkips
    })
  }
}

export { BatchAskComponent, batchTitle }
