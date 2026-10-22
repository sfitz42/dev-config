import { Input, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui'

import type { Component, SettingsListTheme } from '@earendil-works/pi-tui'

import type { AllowedPath } from '../core/paths.ts'
import type { PatternConfig } from '../core/patterns.ts'

/** Moves an index up or down a list, wrapping at the ends. */
function step (index: number, length: number, delta: number): number {
  return length === 0 ? 0 : (index + delta + length) % length
}

/** Keeps a selection valid after a list shrinks. */
function lastIndexAtMost (index: number, length: number): number {
  return Math.min(index, Math.max(0, length - 1))
}

function isUp (data: string): boolean {
  return matchesKey(data, Key.up) || data === 'k'
}

function isDown (data: string): boolean {
  return matchesKey(data, Key.down) || data === 'j'
}

/** A one-line text field; Enter saves, Esc cancels. */
class TextField implements Component {
  private readonly input = new Input()

  constructor (
    private readonly label: string,
    initial: string,
    private readonly theme: SettingsListTheme,
    done: (value: string | undefined) => void,
    private readonly hint = 'Enter save · Esc cancel'
  ) {
    this.input.setValue(initial)
    this.input.onSubmit = (value) => done(value)
    this.input.onEscape = () => done(undefined)
  }

  invalidate (): void {
    this.input.invalidate()
  }

  render (width: number): string[] {
    return [
      this.theme.label(` ${this.label}`, true),
      '',
      ...this.input.render(Math.max(1, width - 2)).map((line) => ` ${line}`),
      '',
      this.theme.hint(`  ${this.hint}`)
    ]
  }

  handleInput (data: string): void {
    this.input.handleInput(data)
  }
}

/** Asks yes/no; `y` confirms, anything else cancels. */
class Confirm implements Component {
  constructor (
    private readonly message: string,
    private readonly theme: SettingsListTheme,
    private readonly done: (confirmed: boolean) => void
  ) {}

  invalidate (): void {}

  render (): string[] {
    return [
      this.theme.label(` ${this.message}`, true),
      '',
      this.theme.hint('  y confirm · any other key cancels')
    ]
  }

  handleInput (data: string): void {
    this.done(data === 'y' || data === 'Y')
  }
}

interface EditablePattern {
  pattern: string
  description: string
  regex: boolean
}

/**
 * Edits a list of patterns. List mode: a add, e/Enter edit, d delete,
 * Esc back. Form mode: Tab switches field, Ctrl+R toggles regex, Enter
 * moves on and finally saves, Esc cancels.
 */
class PatternEditor implements Component {
  private items: EditablePattern[]
  private selected = 0
  private mode: 'list' | 'add' | 'edit' = 'list'
  private field: 'pattern' | 'description' | 'regex' = 'pattern'
  private regex = false
  private readonly patternInput = new Input()
  private readonly descriptionInput = new Input()

  constructor (private readonly options: {
    label: string
    items: readonly PatternConfig[]
    theme: SettingsListTheme
    /** File patterns are globs; command patterns are substrings. */
    context: 'file' | 'command'
    onSave: (items: PatternConfig[]) => void
    onDone: () => void
  }) {
    this.items = options.items.map((item) => ({
      pattern: item.pattern,
      description: item.description ?? '',
      regex: item.regex === true
    }))
    const next = (): void => this.advance()
    this.patternInput.onSubmit = next
    this.descriptionInput.onSubmit = next
    this.patternInput.onEscape = () => this.closeForm()
    this.descriptionInput.onEscape = () => this.closeForm()
  }

  invalidate (): void {}

  render (width: number): string[] {
    const { theme, label } = this.options
    const lines = [theme.label(` ${label}`, true), '']
    return this.mode === 'list'
      ? [...lines, ...this.renderList(width)]
      : [...lines, ...this.renderForm(width)]
  }

  handleInput (data: string): void {
    if (this.mode !== 'list') {
      this.handleForm(data)
      return
    }
    if (isUp(data)) {
      this.selected = step(this.selected, this.items.length, -1)
    } else if (isDown(data)) {
      this.selected = step(this.selected, this.items.length, 1)
    } else if (data === 'a' || data === 'A') {
      this.openForm('add')
    } else if (data === 'e' || data === 'E' || matchesKey(data, Key.enter)) {
      if (this.items[this.selected] !== undefined) {
        this.openForm('edit')
      }
    } else if (data === 'd' || data === 'D') {
      if (this.items.length > 0) {
        this.items.splice(this.selected, 1)
        this.selected = lastIndexAtMost(this.selected, this.items.length)
        this.save()
      }
    } else if (matchesKey(data, Key.escape)) {
      this.options.onDone()
    }
  }

  private renderList (width: number): string[] {
    const { theme } = this.options
    const lines = this.items.length === 0
      ? [theme.hint('  (empty)')]
      : this.items.map((item, index) => {
        const chosen = index === this.selected
        const text = `${item.description || item.pattern} (${item.pattern})` +
          (item.regex ? ' [regex]' : '')
        return (chosen ? theme.cursor : '  ') +
          theme.value(truncateToWidth(text, Math.max(1, width - 4)), chosen)
      })
    return [...lines, '', theme.hint('  a add · e/Enter edit · d delete · Esc back')]
  }

  private renderForm (width: number): string[] {
    const { theme, context } = this.options
    const field = (name: typeof this.field, text: string): string =>
      this.field === name ? theme.label(text, true) : theme.hint(text)
    const kind = context === 'file' ? '(glob or regex)' : '(substring or regex)'
    const inputWidth = Math.max(1, width - 4)
    return [
      theme.hint(this.mode === 'edit' ? '  Edit pattern' : '  New pattern'),
      '',
      field('pattern', `  Pattern ${kind}:`),
      `  ${this.patternInput.render(inputWidth).join('')}`,
      '',
      field('description', '  Description:'),
      `  ${this.descriptionInput.render(inputWidth).join('')}`,
      '',
      field('regex', `  Regex: ${this.regex ? 'on' : 'off'}`),
      '',
      theme.hint('  Tab field · Ctrl+R regex · Enter next/save · Esc cancel')
    ]
  }

  private openForm (mode: 'add' | 'edit'): void {
    const item = mode === 'edit' ? this.items[this.selected] : undefined
    this.mode = mode
    this.field = 'pattern'
    this.regex = item?.regex ?? false
    this.patternInput.setValue(item?.pattern ?? '')
    this.descriptionInput.setValue(item?.description ?? '')
  }

  private closeForm (): void {
    this.mode = 'list'
  }

  private advance (): void {
    if (this.field === 'pattern' && this.patternInput.getValue().trim() !== '') {
      this.field = 'description'
    } else if (this.field === 'description') {
      this.field = 'regex'
    } else if (this.field === 'regex') {
      this.submit()
    }
  }

  private handleForm (data: string): void {
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      const order = ['pattern', 'description', 'regex'] as const
      const delta = matchesKey(data, Key.tab) ? 1 : -1
      this.field = order[step(order.indexOf(this.field), 3, delta)] ?? 'pattern'
    } else if (matchesKey(data, Key.ctrl('r'))) {
      this.regex = !this.regex
    } else if (matchesKey(data, Key.escape)) {
      this.closeForm()
    } else if (this.field === 'regex') {
      if (matchesKey(data, Key.enter)) {
        this.submit()
      }
    } else if (this.field === 'pattern') {
      this.patternInput.handleInput(data)
    } else {
      this.descriptionInput.handleInput(data)
    }
  }

  private submit (): void {
    const pattern = this.patternInput.getValue().trim()
    if (pattern === '') {
      this.closeForm()
      return
    }
    const item = {
      pattern,
      description: this.descriptionInput.getValue().trim(),
      regex: this.regex
    }
    if (this.mode === 'edit') {
      this.items[this.selected] = item
    } else {
      this.items.push(item)
      this.selected = this.items.length - 1
    }
    this.save()
    this.closeForm()
  }

  private save (): void {
    this.options.onSave(this.items.map((item) => ({
      pattern: item.pattern,
      ...(item.description !== '' && item.description !== item.pattern
        ? { description: item.description }
        : {}),
      ...(item.regex ? { regex: true } : {})
    })))
  }
}

/** Edits allowed paths; Tab toggles file/directory while editing. */
class PathListEditor implements Component {
  private items: AllowedPath[]
  private selected = 0
  private editing: 'add' | 'edit' | undefined
  private kind: AllowedPath['kind'] = 'file'
  private readonly input = new Input()

  constructor (private readonly options: {
    label: string
    items: readonly AllowedPath[]
    theme: SettingsListTheme
    onSave: (items: AllowedPath[]) => void
    onDone: () => void
  }) {
    this.items = [...options.items]
    this.input.onSubmit = (value) => this.submit(value)
    this.input.onEscape = () => { this.editing = undefined }
  }

  invalidate (): void {}

  render (width: number): string[] {
    const { theme, label } = this.options
    const lines = [theme.label(` ${label}`, true), '']
    if (this.editing !== undefined) {
      return [
        ...lines,
        theme.hint(`  kind: ${this.kind === 'directory' ? 'dir' : 'file'} (Tab toggles)`),
        '',
        ...this.input.render(Math.max(1, width - 4)).map((line) => `  ${line}`),
        '',
        theme.hint('  Enter save · Esc cancel')
      ]
    }
    const rows = this.items.length === 0
      ? [theme.hint('  (empty)')]
      : this.items.map((item, index) => {
        const chosen = index === this.selected
        return (chosen ? theme.cursor : '  ') +
          theme.hint(`[${item.kind === 'directory' ? 'dir' : 'file'}] `) +
          theme.value(item.path, chosen)
      })
    return [...lines, ...rows, '',
      theme.hint('  a add · e/Enter edit · d delete · Esc back')]
  }

  handleInput (data: string): void {
    if (this.editing !== undefined) {
      if (matchesKey(data, Key.tab)) {
        this.kind = this.kind === 'file' ? 'directory' : 'file'
      } else {
        this.input.handleInput(data)
      }
      return
    }
    if (isUp(data)) {
      this.selected = step(this.selected, this.items.length, -1)
    } else if (isDown(data)) {
      this.selected = step(this.selected, this.items.length, 1)
    } else if (data === 'a' || data === 'A') {
      this.editing = 'add'
      this.kind = 'file'
      this.input.setValue('')
    } else if (data === 'e' || data === 'E' || matchesKey(data, Key.enter)) {
      const item = this.items[this.selected]
      if (item !== undefined) {
        this.editing = 'edit'
        this.kind = item.kind
        this.input.setValue(item.path)
      }
    } else if (data === 'd' || data === 'D') {
      this.items.splice(this.selected, 1)
      this.selected = lastIndexAtMost(this.selected, this.items.length)
      this.options.onSave([...this.items])
    } else if (matchesKey(data, Key.escape)) {
      this.options.onDone()
    }
  }

  private submit (value: string): void {
    const path = value.trim()
    if (path !== '') {
      const entry: AllowedPath = { kind: this.kind, path }
      if (this.editing === 'edit') {
        this.items[this.selected] = entry
      } else {
        this.items.push(entry)
        this.selected = this.items.length - 1
      }
      const seen = new Set<string>()
      this.items = this.items.filter((item) => {
        const key = `${item.kind}:${item.path}`
        return !seen.has(key) && seen.add(key) !== undefined
      })
      this.options.onSave([...this.items])
    }
    this.editing = undefined
  }
}

interface WizardStep {
  readonly label: string
  /** Steps that need no answer (checklists); Tab always moves on. */
  readonly optional?: boolean
  /** The step gets every key (an editor using Tab and Esc itself). */
  readonly capturesInput?: boolean
  /** Builds the step; call `next` when it is answered. */
  build: (next: () => void) => Component
}

/**
 * Steps shown one at a time. Esc cancels, Shift+Tab goes back, Tab moves
 * forward over answered steps; `onFinish` runs when the last step calls
 * `next`.
 */
class Wizard implements Component {
  private index = 0
  private answered = 0
  private current: Component

  constructor (private readonly options: {
    title: string
    steps: readonly WizardStep[]
    theme: SettingsListTheme
    onFinish: () => void
    onCancel: () => void
  }) {
    this.current = this.build(0)
  }

  invalidate (): void {
    this.current.invalidate()
  }

  render (width: number): string[] {
    const { theme, title, steps } = this.options
    const tabs = steps.map((item, i) => {
      const text = `${i + 1}. ${item.label}`
      return i === this.index ? theme.label(text, true) : theme.hint(text)
    }).join(theme.hint('  ›  '))
    return [
      theme.label(` ${title}`, true),
      ` ${tabs}`,
      '',
      ...this.current.render(width),
      '',
      theme.hint('  Enter select · Tab/Shift+Tab steps · Esc cancel')
    ]
  }

  handleInput (data: string): void {
    if (this.options.steps[this.index]?.capturesInput === true) {
      this.current.handleInput?.(data)
    } else if (matchesKey(data, Key.escape)) {
      this.options.onCancel()
    } else if (matchesKey(data, Key.shift('tab'))) {
      this.goTo(Math.max(0, this.index - 1))
    } else if (matchesKey(data, Key.tab)) {
      const optional = this.options.steps[this.index]?.optional === true
      if ((this.index < this.answered || optional) &&
        this.index + 1 < this.options.steps.length) {
        this.goTo(this.index + 1)
      }
    } else {
      this.current.handleInput?.(data)
    }
  }

  private build (index: number): Component {
    const step = this.options.steps[index]
    if (step === undefined) {
      throw new Error(`wizard has no step ${index}`)
    }
    return step.build(() => {
      this.answered = Math.max(this.answered, index + 1)
      if (index + 1 >= this.options.steps.length) {
        this.options.onFinish()
      } else {
        this.goTo(index + 1)
      }
    })
  }

  private goTo (index: number): void {
    this.index = index
    this.current = this.build(index)
  }
}

/** A single choice with a description under the list. */
class Choice implements Component {
  private selected = 0

  constructor (private readonly options: {
    title: string
    items: readonly { label: string, description: string }[]
    theme: SettingsListTheme
    onSelect: (index: number) => void
    initial?: number
  }) {
    this.selected = options.initial ?? 0
  }

  invalidate (): void {}

  render (width: number): string[] {
    const { theme, items, title } = this.options
    const description = items[this.selected]?.description ?? ''
    return [
      `  ${title}`,
      '',
      ...items.map((item, i) => (i === this.selected ? theme.cursor : '  ') +
        theme.value(item.label, i === this.selected)),
      '',
      ...wrap(description, Math.max(20, width - 4)).map((line) =>
        theme.description(`  ${line}`))
    ]
  }

  handleInput (data: string): void {
    if (isUp(data)) {
      this.selected = step(this.selected, this.options.items.length, -1)
    } else if (isDown(data)) {
      this.selected = step(this.selected, this.options.items.length, 1)
    } else if (matchesKey(data, Key.enter)) {
      this.options.onSelect(this.selected)
    }
  }
}

/** Word-wraps plain text, keeping explicit line breaks. */
function wrap (text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
      if (line !== '' && line.length + word.length + 1 > width) {
        lines.push(line)
        line = word
      } else {
        line = line === '' ? word : `${line} ${word}`
      }
    }
    lines.push(line)
  }
  return lines
}

export {
  Choice,
  Confirm,
  isDown,
  isUp,
  PathListEditor,
  PatternEditor,
  step,
  TextField,
  Wizard,
  wrap
}
export type { WizardStep }
