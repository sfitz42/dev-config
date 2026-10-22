import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { digitIndex, matchesSelectDown, matchesSelectUp } from './key-input.ts'
import { COMMENT_TOGGLE_LABEL } from './option-rows.ts'
import { shortcutMatches } from './shortcuts.ts'

import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'

import type { QuestionOption } from './ask-types.ts'
import type { Shortcut } from './shortcuts.ts'
import type { ChoiceList, ChoiceRow } from './tern.ts'

interface ListCallbacks<T> {
  readonly onSubmit: (result: T) => void
  readonly onCancel: () => void
  readonly onFreeform: () => void
}

interface ListConfig {
  readonly options: readonly QuestionOption[]
  readonly allowFreeform: boolean
  readonly allowComment: boolean
  readonly theme: Theme
  readonly keys: KeybindingsManager
  readonly commentToggle: Shortcut
}

/** Fits item blocks into `maxRows`, keeping the selected one visible. */
function windowBlocks (
  blocks: readonly string[][],
  selected: number,
  maxRows: number
): string[] {
  const total = blocks.reduce((sum, block) => sum + block.length, 0)
  if (total <= maxRows) {
    return blocks.flat()
  }
  const available = maxRows > 1 ? maxRows - 1 : 1
  const current = blocks[selected] ?? blocks[0] ?? []
  if (current.length >= available) {
    return current.slice(0, available)
  }
  let start = selected
  let end = selected + 1
  let used = current.length
  for (;;) {
    const next = blocks[end]
    if (next !== undefined && used + next.length <= available) {
      used += next.length
      end += 1
      continue
    }
    const previous = blocks[start - 1]
    if (previous !== undefined && used + previous.length <= available) {
      used += previous.length
      start -= 1
      continue
    }
    break
  }
  return blocks.slice(start, end).flat()
}

/** A checkbox list: space or a digit ticks; enter submits. */
class MultiSelectList implements Component {
  private selected = 0
  private readonly checked = new Set<number>()
  private commentOn = false
  private maxRows = 10
  private cache?: { readonly width: number, readonly lines: string[] }

  constructor (
    private readonly config: ListConfig,
    private readonly callbacks: ListCallbacks<string[]>
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

  private get itemCount (): number {
    const { options, allowComment, allowFreeform } = this.config
    return options.length + (allowComment ? 1 : 0) + (allowFreeform ? 1 : 0)
  }

  private isCommentRow (index: number): boolean {
    return this.config.allowComment && index === this.config.options.length
  }

  private isFreeformRow (index: number): boolean {
    const { options, allowComment, allowFreeform } = this.config
    return allowFreeform && index === options.length + (allowComment ? 1 : 0)
  }

  private toggleComment (): void {
    if (this.config.allowComment) {
      this.commentOn = !this.commentOn
      this.invalidate()
    }
  }

  private toggle (index: number): void {
    if (index < 0 || index >= this.config.options.length) {
      return
    }
    if (this.checked.has(index)) {
      this.checked.delete(index)
    } else {
      this.checked.add(index)
    }
    this.invalidate()
  }

  /** Space on the highlighted row. */
  private activate (): void {
    if (this.isCommentRow(this.selected)) {
      this.toggleComment()
    } else if (this.isFreeformRow(this.selected)) {
      this.callbacks.onFreeform()
    } else {
      this.toggle(this.selected)
    }
  }

  /** Submits the ticked options, or the highlighted one if none is ticked. */
  submit (): void {
    const { options } = this.config
    const ticked = [...this.checked].sort((a, b) => a - b)
      .flatMap((index) => {
        const option = options[index]
        return option === undefined ? [] : [option.title]
      })
    const fallback = options[this.selected]?.title
    const result = ticked.length > 0
      ? ticked
      : fallback === undefined ? [] : [fallback]
    if (result.length > 0) {
      this.callbacks.onSubmit(result)
    } else {
      this.callbacks.onCancel()
    }
  }

  handleInput (data: string): void {
    const { keys, allowComment, commentToggle } = this.config
    if (keys.matches(data, 'tui.select.cancel') || this.itemCount === 0) {
      this.callbacks.onCancel()
      return
    }
    if (allowComment && shortcutMatches(commentToggle, data)) {
      this.toggleComment()
      return
    }
    const count = this.itemCount
    if (matchesSelectUp(data, keys)) {
      this.select(this.selected === 0 ? count - 1 : this.selected - 1)
      return
    }
    if (matchesSelectDown(data, keys)) {
      this.select(this.selected === count - 1 ? 0 : this.selected + 1)
      return
    }
    const digit = digitIndex(data)
    if (digit !== undefined) {
      if (digit < this.config.options.length) {
        this.toggle(digit)
        this.select(Math.min(digit, count - 1))
      }
      return
    }
    if (matchesKey(data, Key.space)) {
      this.activate()
      return
    }
    if (keys.matches(data, 'tui.select.confirm')) {
      if (this.isCommentRow(this.selected) ||
        this.isFreeformRow(this.selected)) {
        this.activate()
      } else {
        this.submit()
      }
    }
  }

  private select (index: number): void {
    this.selected = index
    this.invalidate()
  }

  /** The rows for Tern's native sheet. */
  nativeSheet (): ChoiceList {
    const rows: ChoiceRow[] = this.config.options.map((option, index) => ({
      id: `o${index}`,
      kind: 'option',
      label: option.title,
      ...(option.description === undefined
        ? {}
        : { detail: option.description }),
      on: this.checked.has(index)
    }))
    if (this.config.allowComment) {
      rows.push({
        id: 'comment', kind: 'comment', label: COMMENT_TOGGLE_LABEL, on: this.commentOn
      })
    }
    if (this.config.allowFreeform) {
      rows.push({ id: 'freeform', kind: 'freeform', label: 'Other' })
    }
    return { rows, selected: this.selected }
  }

  /** Highlights a native row; `activate` then acts as space on it. */
  selectRow (row: number, activate: boolean): void {
    if (row < 0 || row >= this.itemCount) {
      return
    }
    this.select(row)
    if (activate) {
      this.activate()
    }
  }

  private block (index: number, width: number): string[] {
    const { theme, options } = this.config
    const current = index === this.selected
    const pointer = current ? theme.fg('accent', '→') : ' '
    const emphasise = (text: string): string =>
      theme.fg(current ? 'accent' : 'text', theme.bold(text))
    const fit = (line: string): string => truncateToWidth(line, width, '')

    if (this.isCommentRow(index)) {
      const box = this.commentOn
        ? theme.fg('success', '[✓]')
        : theme.fg('dim', '[ ]')
      return [fit(`${pointer}   ${box} ${emphasise(COMMENT_TOGGLE_LABEL)}`)]
    }
    if (this.isFreeformRow(index)) {
      const label = theme.fg('text', theme.bold('Type something.'))
      const detail = theme.fg('muted', 'Enter a custom response')
      return [fit(`${pointer}   ${label} ${theme.fg('dim', '—')} ${detail}`)]
    }
    const option = options[index]
    if (option === undefined) {
      return []
    }
    const box = this.checked.has(index)
      ? theme.fg('success', '[✓]')
      : theme.fg('dim', '[ ]')
    const number = theme.fg('dim', `${index + 1}.`)
    const lines = [fit(`${pointer} ${number} ${box} ${emphasise(option.title)}`)]
    if (option.description !== undefined) {
      const indent = '      '
      for (const line of wrapTextWithAnsi(option.description,
        Math.max(10, width - indent.length))) {
        lines.push(fit(indent + theme.fg('muted', line)))
      }
    }
    return lines
  }

  render (width: number): string[] {
    if (this.cache?.width === width) {
      return this.cache.lines
    }
    const { theme } = this.config
    const count = this.itemCount
    let lines: string[]
    if (count === 0) {
      lines = [theme.fg('warning', 'No options')]
    } else {
      const blocks = Array.from({ length: count },
        (_, index) => this.block(index, width))
      const total = blocks.reduce((sum, block) => sum + block.length, 0)
      lines = windowBlocks(blocks, this.selected, this.maxRows)
      if (total > this.maxRows && this.maxRows > 1) {
        lines.push(theme.fg('dim',
          truncateToWidth(`  (${this.selected + 1}/${count})`, width, '')))
      }
    }
    this.cache = { width, lines }
    return lines
  }
}

export { MultiSelectList, windowBlocks }
export type { ListCallbacks, ListConfig }
