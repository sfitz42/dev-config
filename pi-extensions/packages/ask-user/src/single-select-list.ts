import { fuzzyFilter, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'

import {
  digitIndex,
  matchesSelectDown,
  matchesSelectUp,
  printableInput
} from './key-input.ts'
import { SPLIT_SEPARATOR, splitPaneWidths } from './layout.ts'
import { markdownLines } from './markdown-text.ts'
import { COMMENT_TOGGLE_LABEL, renderOptionRows } from './option-rows.ts'
import { shortcutMatches } from './shortcuts.ts'

import type { Component } from '@earendil-works/pi-tui'

import type { QuestionOption, SingleSelectLayout } from './ask-types.ts'
import type { ListCallbacks, ListConfig } from './multi-select-list.ts'
import type { ChoiceList, ChoiceRow } from './tern.ts'

/**
 * Builds the markdown for the details pane beside a wide single-select
 * list.
 *
 * @returns Markdown describing the highlighted row.
 */
function previewMarkdown (
  row: { readonly kind: 'comment', readonly on: boolean } |
    { readonly kind: 'freeform' } |
    { readonly kind: 'option', readonly option: QuestionOption | undefined },
  query: string
): string {
  const filterNote = (label: string): string =>
    query === '' ? '' : `\n\n> ${label}: \`${query}\``
  switch (row.kind) {
    case 'comment':
      return '## Additional context\n\n' +
        `Currently: **${row.on ? 'Enabled' : 'Disabled'}**\n\n` +
        'Turn this on when the selected option needs extra explanation ' +
        'before the tool submits.'
    case 'freeform':
      return '## Custom response\n\nOpen the editor to write **any** ' +
        'answer.\n\n*Use this when none of the listed options fit.*' +
        filterNote('Current filter')
    case 'option': {
      const { option } = row
      if (option === undefined) {
        return '*No option selected*'
      }
      const description = option.description ?? ''
      const body = description.trim() === ''
        ? '*No additional details provided for this option.*'
        : description
      return `## ${option.title}\n\n${body}\n\n---\n\n` +
        'Press `Enter` to select this option.' + filterNote('Filter')
    }
  }
}

/** A filterable single-choice list with an optional details pane. */
class SingleSelectList implements Component {
  private selected = 0
  private query = ''
  private commentOn = false
  private maxRows = 12
  private cache?: { readonly width: number, readonly lines: string[] }

  constructor (
    private readonly config: ListConfig,
    private readonly layout: SingleSelectLayout,
    private readonly callbacks: ListCallbacks<string>
  ) {}

  isCommentEnabled (): boolean {
    return this.commentOn
  }

  setMaxVisibleRows (rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next !== this.maxRows) {
      this.maxRows = next
      this.invalidate()
    }
  }

  invalidate (): void {
    this.cache = undefined
  }

  private filtered (): QuestionOption[] {
    return fuzzyFilter([...this.config.options], this.query,
      (option) => `${option.title} ${option.description ?? ''}`)
  }

  private itemCount (filtered: readonly QuestionOption[]): number {
    const { allowComment, allowFreeform } = this.config
    return filtered.length + (allowComment ? 1 : 0) + (allowFreeform ? 1 : 0)
  }

  private isCommentRow (
    index: number,
    filtered: readonly QuestionOption[]
  ): boolean {
    return this.config.allowComment && index === filtered.length
  }

  private isFreeformRow (
    index: number,
    filtered: readonly QuestionOption[]
  ): boolean {
    const { allowComment, allowFreeform } = this.config
    return allowFreeform && index === filtered.length + (allowComment ? 1 : 0)
  }

  private toggleComment (): void {
    if (this.config.allowComment) {
      this.commentOn = !this.commentOn
      this.invalidate()
    }
  }

  private setQuery (query: string): void {
    this.query = query
    this.selected = 0
    this.invalidate()
  }

  private select (index: number): void {
    this.selected = index
    this.invalidate()
  }

  /** Enter on the highlighted row. */
  private confirm (filtered: readonly QuestionOption[]): void {
    if (this.isCommentRow(this.selected, filtered)) {
      this.toggleComment()
      return
    }
    if (this.isFreeformRow(this.selected, filtered)) {
      this.callbacks.onFreeform()
      return
    }
    const choice = filtered[this.selected]?.title
    if (choice === undefined) {
      this.callbacks.onCancel()
    } else {
      this.callbacks.onSubmit(choice)
    }
  }

  handleInput (data: string): void {
    const { keys, allowComment, commentToggle } = this.config
    if (this.query !== '' && matchesKey(data, Key.escape)) {
      this.setQuery('')
      return
    }
    if (keys.matches(data, 'tui.select.cancel')) {
      this.callbacks.onCancel()
      return
    }
    if (allowComment && shortcutMatches(commentToggle, data)) {
      this.toggleComment()
      return
    }
    const filtered = this.filtered()
    const count = this.itemCount(filtered)
    if (count > 0 && matchesSelectUp(data, keys)) {
      this.select(this.selected === 0 ? count - 1 : this.selected - 1)
      return
    }
    if (count > 0 && matchesSelectDown(data, keys)) {
      this.select(this.selected === count - 1 ? 0 : this.selected + 1)
      return
    }
    const digit = digitIndex(data)
    if (digit !== undefined && digit < filtered.length) {
      this.select(digit)
      return
    }
    if (count > 0 && matchesKey(data, Key.space) &&
      this.isCommentRow(this.selected, filtered)) {
      this.toggleComment()
      return
    }
    if (count > 0 && keys.matches(data, 'tui.select.confirm')) {
      this.confirm(filtered)
      return
    }
    if (keys.matches(data, 'tui.editor.deleteCharBackward') ||
      matchesKey(data, Key.backspace)) {
      this.setQuery([...this.query].slice(0, -1).join(''))
      return
    }
    const typed = printableInput(data)
    if (typed !== undefined) {
      this.setQuery(this.query + typed)
    }
  }

  /** The rows for Tern's native sheet. */
  nativeSheet (): ChoiceList {
    const { options } = this.config
    const rows: ChoiceRow[] = this.filtered().map((option) => ({
      id: `o${options.indexOf(option)}`,
      kind: 'option',
      label: option.title,
      ...(option.description === undefined
        ? {}
        : { detail: option.description })
    }))
    if (this.config.allowComment) {
      rows.push({
        id: 'comment', kind: 'comment', label: COMMENT_TOGGLE_LABEL, on: this.commentOn
      })
    }
    if (this.config.allowFreeform) {
      rows.push({ id: 'freeform', kind: 'freeform', label: 'Other' })
    }
    return { rows, selected: this.selected, query: this.query }
  }

  /** Highlights a native row; `activate` then acts as enter on it. */
  selectRow (row: number, activate: boolean): void {
    const filtered = this.filtered()
    if (row < 0 || row >= this.itemCount(filtered)) {
      return
    }
    this.select(row)
    if (activate) {
      this.confirm(filtered)
    }
  }

  private styleRow (line: string, width: number, highlighted: boolean): string {
    const { theme } = this.config
    let styled: string
    if (line.trim().startsWith('(')) {
      styled = theme.fg('dim', line)
    } else if (highlighted || line.startsWith('→')) {
      styled = theme.fg('accent', theme.bold(line))
    } else if (line.startsWith('      ')) {
      styled = theme.fg('muted', line)
    } else {
      styled = theme.fg('text', line)
    }
    return truncateToWidth(styled, width, '')
  }

  private listLines (
    width: number,
    filtered: readonly QuestionOption[],
    hideDescriptions: boolean
  ): string[] {
    const { theme } = this.config
    const fit = (line: string): string => truncateToWidth(line, width, '')
    const value = this.query === ''
      ? theme.fg('dim', 'type to filter')
      : theme.fg('text', this.query)
    const lines = [fit(`${theme.fg('accent', 'Filter:')} ${value}`)]
    if (this.query !== '' && filtered.length === 0) {
      lines.push(fit(theme.fg('warning', 'No matching options')))
    }
    if (this.itemCount(filtered) === 0) {
      if (this.query === '') {
        lines.push(fit(theme.fg('warning', 'No options')))
      }
      return lines.slice(0, this.maxRows)
    }
    const rows = renderOptionRows({
      options: filtered,
      selectedIndex: this.selected,
      width,
      allowFreeform: this.config.allowFreeform,
      allowComment: this.config.allowComment,
      commentEnabled: this.commentOn,
      maxRows: Math.max(1, this.maxRows - lines.length),
      hideDescriptions
    })
    for (const row of rows) {
      lines.push(this.styleRow(row.line, width, row.selected))
    }
    return lines.slice(0, this.maxRows)
  }

  private previewLines (
    width: number,
    filtered: readonly QuestionOption[]
  ): string[] {
    const { theme } = this.config
    const row = this.isCommentRow(this.selected, filtered)
      ? { kind: 'comment' as const, on: this.commentOn }
      : this.isFreeformRow(this.selected, filtered)
        ? { kind: 'freeform' as const }
        : { kind: 'option' as const, option: filtered[this.selected] }
    const lines = markdownLines(previewMarkdown(row, this.query), width)
    if (lines.length <= this.maxRows) {
      return lines
    }
    const ellipsis = truncateToWidth(theme.fg('dim', '…'), width, '')
    return this.maxRows === 1
      ? [ellipsis]
      : [...lines.slice(0, this.maxRows - 1), ellipsis]
  }

  render (width: number): string[] {
    if (this.cache?.width === width) {
      return this.cache.lines
    }
    const filtered = this.filtered()
    const count = this.itemCount(filtered)
    this.selected = count > 0
      ? Math.max(0, Math.min(this.selected, count - 1))
      : 0

    const panes = splitPaneWidths(width, this.layout)
    let lines: string[]
    if (panes === null) {
      lines = this.listLines(width, filtered, false)
    } else {
      const left = this.listLines(panes.left, filtered, true)
      const right = this.previewLines(panes.right, filtered)
      const separator = this.config.theme.fg('dim', SPLIT_SEPARATOR)
      const rows = Math.min(this.maxRows, Math.max(left.length, right.length))
      lines = Array.from({ length: rows }, (_, index) =>
        truncateToWidth(left[index] ?? '', panes.left, '', true) + separator +
        truncateToWidth(right[index] ?? '', panes.right, ''))
    }
    this.cache = { width, lines }
    return lines
  }
}

export { previewMarkdown, SingleSelectList }
