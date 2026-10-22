import {
  Editor,
  Key,
  Markdown,
  matchesKey,
  Text,
  truncateToWidth
} from '@earendil-works/pi-tui'

import {
  createFreeformResponse,
  createSelectionResponse
} from './answer-format.ts'
import { frame, innerWidth } from './box-frame.ts'
import {
  bindingHint,
  contextToggleKey,
  joinHints,
  literalHint,
  otherCancelKeys
} from './key-input.ts'
import {
  contextOverflowsOverlay,
  helpBudget,
  INLINE_CONTEXT_MAX_ROWS,
  overlayBudgets,
  overlayMaxLines
} from './layout.ts'
import { safeMarkdownTheme } from './markdown-text.ts'
import { MultiSelectList } from './multi-select-list.ts'
import { limitEditorLines, limitLines, markOverflow } from './pane-lines.ts'
import { SingleSelectList } from './single-select-list.ts'
import {
  choiceSheet,
  CHOICE_LIST_KEY,
  NATIVE_COMPONENT,
  nodeKey,
  textSheet
} from './tern.ts'
import { VERSION } from './version.ts'

import type {
  KeybindingsManager,
  Theme
} from '@earendil-works/pi-coding-agent'
import type { Component, Focusable, KeyId, TUI } from '@earendil-works/pi-tui'

import type { AskResponse, QuestionOption } from './ask-types.ts'
import type { AskMode } from './layout.ts'
import type { PromptSettings } from './prompt-settings.ts'
import type {
  QuestionTabs,
  TernContext,
  TernEvent,
  TernNative,
  TernNode
} from './tern.ts'

interface AskQuestion {
  readonly question: string
  readonly context?: string
  readonly options: readonly QuestionOption[]
  readonly allowMultiple: boolean
  readonly allowFreeform: boolean
}

interface AskEnvironment {
  readonly settings: PromptSettings
  readonly tui: TUI
  readonly theme: Theme
  readonly keys: KeybindingsManager
}

type Done = (result: AskResponse | null) => void

const INLINE_SELECT_ROWS = 12
const PROMPT_PAGE_KEYS = {
  pageUp: Key.pageUp,
  pageDown: Key.pageDown,
  home: Key.home,
  end: Key.end,
  halfUp: Key.ctrl('u'),
  halfDown: Key.ctrl('d')
} as const

/**
 * The interactive prompt for one question: a filterable or checkbox list
 * that can switch to an editor for a custom answer or a comment.
 */
class AskComponent implements Component, Focusable, TernNative {
  private mode: AskMode = 'select'
  private pendingSelections: readonly string[] = []
  private freeformDraft = ''
  private commentDraft = ''
  private promptScroll = 0
  private promptMaxScroll = 0
  private promptViewportRows = 0
  private contextCollapsible = false
  private contextExpanded = false
  private frameTitle = 'ask_user'
  private navigationHint?: string
  private nativeTabs?: {
    readonly tabs: QuestionTabs
    readonly go: (id: string) => void
  }

  private focusedState = false
  private singleList?: SingleSelectList
  private multiList?: MultiSelectList
  private editor?: Editor
  private readonly contextView?: Component

  constructor (
    private readonly ask: AskQuestion,
    private readonly env: AskEnvironment,
    private readonly onDone: Done
  ) {
    const { theme } = env
    if (ask.context !== undefined) {
      const markdown = safeMarkdownTheme()
      this.contextView = markdown === undefined
        ? new Text(`${theme.fg('accent', theme.bold('Context:'))}\n` +
          theme.fg('dim', ask.context), 1, 0)
        : new Markdown(`**Context:**\n${ask.context}`, 1, 0, markdown)
    }
    // Without options there is no list: open straight in the editor.
    if (ask.options.length === 0) {
      this.showFreeform()
    } else {
      this.showSelect()
    }
  }

  get focused (): boolean {
    return this.focusedState
  }

  set focused (value: boolean) {
    this.focusedState = value
    if (this.editor !== undefined && this.mode !== 'select') {
      this.editor.focused = value
    }
  }

  /** Batch pages show their position in the title and a navigation hint. */
  setBatchChrome (title: string, hint: string): void {
    this.frameTitle = title
    this.navigationHint = hint
  }

  setNativeTabs (tabs: QuestionTabs, go: (id: string) => void): void {
    this.nativeTabs = { tabs, go }
  }

  invalidate (): void {
    this.singleList?.invalidate()
    this.multiList?.invalidate()
    this.editor?.invalidate()
    this.contextView?.invalidate()
  }

  // ── Rendering ────────────────────────────────────────────────────────

  render (width: number): string[] {
    const inner = innerWidth(width)
    if (this.env.settings.displayMode === 'overlay') {
      return this.renderOverlay(width, inner)
    }
    if (this.mode === 'select' && !this.ask.allowMultiple) {
      this.ensureSingleList().setMaxVisibleRows(INLINE_SELECT_ROWS)
    }
    const context = this.contextLines(inner)
    this.setContextCollapsible(context.length > INLINE_CONTEXT_MAX_ROWS)
    if (this.contextExpanded) {
      return this.renderOverlay(width, inner)
    }
    return this.framed([
      ...this.promptLines(inner, context),
      '',
      ...this.modeLines(inner),
      '',
      ...this.helpLines(inner)
    ], width)
  }

  private renderOverlay (width: number, inner: number): string[] {
    const { theme, tui, settings } = this.env
    const maxLines = overlayMaxLines(tui.terminal.rows)
    if (maxLines <= 2) {
      return this.framed([], width).slice(0, maxLines)
    }
    const capacity = maxLines - 2
    const question = this.questionLines(inner)
    const context = this.contextLines(inner)
    const collapse = settings.displayMode === 'overlay' && this.mode === 'select'
      ? contextOverflowsOverlay(question.length, context.length, capacity,
        this.helpLines(inner).length)
      : this.contextCollapsible
    this.setContextCollapsible(collapse)

    const help = this.helpLines(inner)
    const prompt = this.promptLines(inner, context)
    const helpRows = helpBudget(capacity, help.length)
    const budgets = overlayBudgets({
      mode: this.mode,
      contentRows: Math.max(0, capacity - helpRows),
      promptLines: prompt.length,
      contextCollapsed: this.contextCollapsible && !this.contextExpanded
    })
    const mode = this.limitedModeLines(inner, budgets.modeRows)
    const promptRows = budgets.promptRows +
      Math.max(0, budgets.modeRows - mode.length)
    const promptPane = this.promptPane(prompt, promptRows, inner)
    const dim = (text: string): string => theme.fg('dim', text)
    const separator = budgets.separatorRows > 0 && promptPane.length > 0 &&
      mode.length > 0
    return this.framed([
      ...promptPane,
      ...(separator ? [''] : []),
      ...mode,
      ...limitLines(help, helpRows, inner, dim, false)
    ].slice(0, capacity), width)
  }

  private framed (body: readonly string[], width: number): string[] {
    return frame(this.env.theme, this.frameTitle, `v${VERSION}`, body, width)
  }

  private questionLines (width: number): string[] {
    const { theme } = this.env
    return new Text(theme.fg('text', theme.bold(this.ask.question)), 1, 0)
      .render(width)
  }

  private contextLines (width: number): string[] {
    return this.contextView?.render(width) ?? []
  }

  private setContextCollapsible (value: boolean): void {
    if (this.contextCollapsible === value) {
      return
    }
    this.contextCollapsible = value
    // Start in the preferred state whenever context becomes collapsible.
    this.contextExpanded = value && this.env.settings.contextExpanded
  }

  private promptLines (width: number, context: readonly string[]): string[] {
    const question = this.questionLines(width)
    if (context.length === 0) {
      return question
    }
    if (this.contextCollapsible && !this.contextExpanded) {
      const key = contextToggleKey(this.env.settings.shortcuts)
      const label = `Context (${context.length} lines) — ${key} expand`
      return [...question,
        truncateToWidth(this.env.theme.fg('dim', label), width, '')]
    }
    return [...question, '', ...context]
  }

  private promptPane (
    lines: readonly string[],
    budget: number,
    width: number
  ): string[] {
    const rows = Math.max(0, Math.floor(budget))
    this.promptViewportRows = rows
    if (rows === 0 || lines.length === 0) {
      this.promptMaxScroll = 0
      this.promptScroll = 0
      return []
    }
    this.promptMaxScroll = Math.max(0, lines.length - rows)
    this.promptScroll = Math.min(this.promptScroll, this.promptMaxScroll)
    return markOverflow(
      lines.slice(this.promptScroll, this.promptScroll + rows),
      width,
      (text) => this.env.theme.fg('dim', text),
      this.promptScroll > 0,
      this.promptScroll + rows < lines.length
    )
  }

  private editorHeader (width: number): string[] {
    const { theme } = this.env
    const heading = (text: string): string[] =>
      new Text(theme.fg('accent', theme.bold(text)), 1, 0).render(width)
    if (this.mode === 'comment') {
      const label = this.pendingSelections.length === 1
        ? 'Selected option:'
        : 'Selected options:'
      return [
        ...heading(label),
        ...new Text(theme.fg('text', this.pendingSelections.join(', ')), 1, 0)
          .render(width),
        ''
      ]
    }
    return [...heading('Custom response'), '']
  }

  private modeLines (width: number): string[] {
    if (this.mode === 'select') {
      return this.activeList().render(width)
    }
    return [...this.editorHeader(width), ...this.ensureEditor().render(width)]
  }

  private limitedModeLines (width: number, budget: number): string[] {
    const rows = Math.max(0, Math.floor(budget))
    if (rows === 0) {
      return []
    }
    const dim = (text: string): string => this.env.theme.fg('dim', text)
    if (this.mode === 'select') {
      const list = this.activeList()
      list.setMaxVisibleRows(rows)
      return limitLines(list.render(width), rows, width, dim, true)
    }
    const header = limitLines(this.editorHeader(width),
      Math.max(0, rows - Math.min(3, rows)), width, dim, true)
    return [
      ...header,
      ...limitEditorLines(this.ensureEditor().render(width),
        Math.max(0, rows - header.length), width, dim)
    ]
  }

  private hints (): string {
    const { theme, keys, settings } = this.env
    const { overlayToggle, commentToggle } = settings.shortcuts
    const overlay = settings.displayMode === 'overlay'
    const overlayHint = overlay && !overlayToggle.disabled
      ? literalHint(theme, overlayToggle.spec, 'hide')
      : undefined
    const cancelKeys = otherCancelKeys(keys)
    const cancelHint = cancelKeys.length > 0
      ? literalHint(theme, cancelKeys.join('/'), 'cancel')
      : undefined

    if (this.mode !== 'select') {
      return joinHints([
        this.navigationHint,
        bindingHint(theme, keys, 'tui.input.submit',
          this.mode === 'comment' ? 'submit/skip' : 'submit'),
        bindingHint(theme, keys, 'tui.input.newLine', 'newline'),
        literalHint(theme, 'esc',
          this.ask.options.length === 0 ? 'cancel' : 'back'),
        overlayHint,
        cancelHint
      ])
    }

    const commentHint = settings.allowComment && !commentToggle.disabled
      ? literalHint(theme, commentToggle.spec, 'toggle context')
      : undefined
    const contextHint = this.contextCollapsible
      ? literalHint(theme, contextToggleKey(settings.shortcuts),
        this.contextExpanded ? 'collapse context' : 'expand context')
      : undefined
    const scrollHint = overlay || this.contextExpanded
      ? literalHint(theme, 'PgUp/PgDn', 'prompt')
      : undefined

    if (this.ask.allowMultiple) {
      return joinHints([
        this.navigationHint,
        literalHint(theme, '↑↓', 'navigate'),
        literalHint(theme, 'space', 'toggle'),
        commentHint,
        contextHint,
        scrollHint,
        overlayHint,
        bindingHint(theme, keys, 'tui.select.confirm', 'submit'),
        bindingHint(theme, keys, 'tui.select.cancel', 'cancel')
      ])
    }
    return joinHints([
      this.navigationHint,
      literalHint(theme, 'type', 'filter'),
      commentHint,
      contextHint,
      scrollHint,
      bindingHint(theme, keys, 'tui.editor.deleteCharBackward', 'erase'),
      literalHint(theme, '↑↓', 'navigate'),
      overlayHint,
      bindingHint(theme, keys, 'tui.select.confirm', 'select'),
      literalHint(theme, 'esc', 'clear/cancel'),
      cancelHint
    ])
  }

  private helpLines (width: number): string[] {
    return new Text(this.env.theme.fg('dim', this.hints()), 1, 0).render(width)
  }

  // ── Modes ────────────────────────────────────────────────────────────

  private listConfig (): ConstructorParameters<typeof MultiSelectList>[0] {
    const { theme, keys, settings } = this.env
    return {
      options: this.ask.options,
      allowFreeform: this.ask.allowFreeform,
      allowComment: settings.allowComment,
      theme,
      keys,
      commentToggle: settings.shortcuts.commentToggle
    }
  }

  private ensureSingleList (): SingleSelectList {
    this.singleList ??= new SingleSelectList(this.listConfig(),
      this.env.settings.singleSelectLayout, {
        onSubmit: (choice) => this.submitSelection([choice],
          this.singleList?.isCommentEnabled() === true),
        onCancel: () => this.onDone(null),
        onFreeform: () => this.showFreeform()
      })
    return this.singleList
  }

  private ensureMultiList (): MultiSelectList {
    this.multiList ??= new MultiSelectList(this.listConfig(), {
      onSubmit: (choices) => this.submitSelection(choices,
        this.multiList?.isCommentEnabled() === true),
      onCancel: () => this.onDone(null),
      onFreeform: () => this.showFreeform()
    })
    return this.multiList
  }

  private activeList (): SingleSelectList | MultiSelectList {
    return this.ask.allowMultiple
      ? this.ensureMultiList()
      : this.ensureSingleList()
  }

  private ensureEditor (): Editor {
    if (this.editor === undefined) {
      const { theme } = this.env
      const accent = (text: string): string => theme.fg('accent', text)
      const editor = new Editor(this.env.tui, {
        borderColor: accent,
        selectList: {
          selectedPrefix: accent,
          selectedText: accent,
          description: (text) => theme.fg('muted', text),
          scrollInfo: (text) => theme.fg('dim', text),
          noMatch: (text) => theme.fg('warning', text)
        }
      })
      editor.disableSubmit = false
      editor.onSubmit = (text) => this.submitEditor(text)
      this.editor = editor
    }
    return this.editor
  }

  private saveDraft (): void {
    const text = this.editor?.getText() ?? ''
    if (this.mode === 'freeform') {
      this.freeformDraft = text
    } else if (this.mode === 'comment') {
      this.commentDraft = text
    }
  }

  private showSelect (): void {
    if (this.mode !== 'select') {
      this.saveDraft()
    }
    this.mode = 'select'
    this.pendingSelections = []
    this.env.tui.requestRender()
  }

  private openEditor (mode: 'freeform' | 'comment', draft: string): void {
    // Keep the other editor mode's draft when switching between them.
    if (this.mode !== 'select' && this.mode !== mode) {
      this.saveDraft()
    }
    this.mode = mode
    const editor = this.ensureEditor()
    editor.setText(draft)
    editor.focused = this.focusedState
    this.env.tui.requestRender()
  }

  private showFreeform (): void {
    this.openEditor('freeform', this.freeformDraft)
  }

  private submitSelection (
    selections: readonly string[],
    wantsComment: boolean
  ): void {
    if (this.env.settings.allowComment && wantsComment) {
      this.pendingSelections = selections
      this.commentDraft = ''
      this.openEditor('comment', '')
      return
    }
    this.onDone(createSelectionResponse(selections))
  }

  private submitEditor (text: string): void {
    if (this.mode === 'freeform') {
      this.onDone(createFreeformResponse(text))
    } else if (this.mode === 'comment') {
      this.commentDraft = text
      this.onDone(createSelectionResponse(this.pendingSelections, text))
    }
  }

  // ── Input ────────────────────────────────────────────────────────────

  private toggleContext (): boolean {
    if (this.mode !== 'select' || !this.contextCollapsible) {
      return false
    }
    this.contextExpanded = !this.contextExpanded
    this.promptScroll = 0
    this.env.tui.requestRender()
    return true
  }

  private scrollPrompt (data: string): boolean {
    const scrollable = this.env.settings.displayMode === 'overlay' ||
      this.contextExpanded
    // The editor owns PgUp/PgDn in its modes.
    if (!scrollable || this.promptMaxScroll <= 0 || this.mode !== 'select') {
      return false
    }
    const page = Math.max(1, this.promptViewportRows - 1)
    const half = Math.max(1, Math.floor(this.promptViewportRows / 2))
    const targets: ReadonlyArray<readonly [KeyId, number]> = [
      [PROMPT_PAGE_KEYS.pageUp, this.promptScroll - page],
      [PROMPT_PAGE_KEYS.pageDown, this.promptScroll + page],
      [PROMPT_PAGE_KEYS.home, 0],
      [PROMPT_PAGE_KEYS.end, this.promptMaxScroll],
      [PROMPT_PAGE_KEYS.halfUp, this.promptScroll - half],
      [PROMPT_PAGE_KEYS.halfDown, this.promptScroll + half]
    ]
    for (const [key, target] of targets) {
      if (matchesKey(data, key)) {
        this.promptScroll = Math.max(0, Math.min(target, this.promptMaxScroll))
        return true
      }
    }
    return false
  }

  handleInput (data: string): void {
    const { tui, keys } = this.env
    if (matchesKey(data, contextToggleKey(this.env.settings.shortcuts)) &&
      this.toggleContext()) {
      return
    }
    if (this.scrollPrompt(data)) {
      tui.requestRender()
      return
    }
    if (this.mode !== 'select') {
      if (matchesKey(data, Key.escape)) {
        if (this.ask.options.length === 0) {
          this.onDone(null)
        } else {
          this.showSelect()
        }
        return
      }
      if (keys.matches(data, 'tui.select.cancel')) {
        this.onDone(null)
        return
      }
      this.ensureEditor().handleInput(data)
      tui.requestRender()
      return
    }
    this.activeList().handleInput(data)
    tui.requestRender()
  }

  // ── Tern ─────────────────────────────────────────────────────────────

  private contextField (): { context?: string } {
    return this.ask.context === undefined ? {} : { context: this.ask.context }
  }

  [NATIVE_COMPONENT] (native: TernContext): TernNode {
    const tabs = this.nativeTabs
    const onTab = (event: TernEvent): boolean => {
      if (event.ev !== 'select' || nodeKey(event.id) !== 'tabs') {
        return false
      }
      tabs?.go(nodeKey(event.item))
      return true
    }

    if (this.mode !== 'select') {
      const editor = this.ensureEditor()
      native.field(editor)
      const { line, col } = editor.getCursor()
      const cursor = editor.getLines().slice(0, line)
        .reduce((sum, text) => sum + text.length + 1, 0) + col
      const back = this.ask.options.length > 0
      native.onEvent((event) => {
        if (onTab(event) || event.ev !== 'action') {
          return
        }
        if (event.act === 'cancel' || event.act === 'close') {
          if (back) {
            this.showSelect()
          } else {
            this.onDone(null)
          }
        } else if (event.act === 'submit') {
          this.submitEditor(editor.getText())
        }
      })
      return textSheet({
        question: this.ask.question,
        ...this.contextField(),
        ...(this.mode === 'comment'
          ? { lead: `Selected: ${this.pendingSelections.join(', ')}` }
          : {}),
        text: editor.getText(),
        cursor,
        placeholder: this.mode === 'comment'
          ? 'Add context for your selection'
          : 'Type your answer',
        escape: back ? 'back' : 'cancel',
        ...(tabs === undefined ? {} : { tabs: tabs.tabs })
      })
    }

    const list = this.activeList()
    const sheet = list.nativeSheet()
    native.onEvent((event) => {
      if (onTab(event)) {
        return
      }
      if (event.ev === 'select' && nodeKey(event.id) === CHOICE_LIST_KEY) {
        const item = nodeKey(event.item)
        list.selectRow(sheet.rows.findIndex((row) => row.id === item), true)
      } else if (event.ev === 'action') {
        if (event.act === 'cancel' || event.act === 'close') {
          this.onDone(null)
        } else if (event.act === 'submit' && list instanceof MultiSelectList) {
          list.submit()
        } else if (event.act === 'submit') {
          list.selectRow(sheet.selected, true)
        }
      }
      this.env.tui.requestRender()
    })
    return choiceSheet({
      question: this.ask.question,
      ...this.contextField(),
      rows: sheet.rows,
      selected: sheet.selected,
      multiple: this.ask.allowMultiple,
      ...(sheet.query === undefined ? {} : { query: sheet.query }),
      ...(tabs === undefined ? {} : { tabs: tabs.tabs })
    })
  }
}

export { AskComponent }
export type { AskEnvironment, AskQuestion }
