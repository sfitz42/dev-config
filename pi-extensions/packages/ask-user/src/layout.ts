import type { DisplayMode, SingleSelectLayout } from './ask-types.ts'

type AskMode = 'select' | 'freeform' | 'comment'

interface PaneWidths {
  readonly left: number
  readonly right: number
}

interface OverlayBudgets {
  readonly promptRows: number
  readonly modeRows: number
  readonly separatorRows: number
}

const OVERLAY_HEIGHT_RATIO = 0.85
const OVERLAY_MIN_LINES = 8
const SPLIT_MIN_WIDTH = 84
const SPLIT_LEFT_MIN = 32
const SPLIT_RIGHT_MIN = 28
const SPLIT_LEFT_SHARE = 0.42
const SPLIT_SEPARATOR = ' │ '
const INLINE_CONTEXT_MAX_ROWS = 3
// Rows Pi's input dock keeps for the transcript, status and footer.
const INLINE_DOCK_RESERVED_ROWS = 5
const DEFAULT_TERMINAL_ROWS = 24

function terminalRows (rows: number): number {
  return Number.isFinite(rows)
    ? Math.max(1, Math.floor(rows))
    : DEFAULT_TERMINAL_ROWS
}

/** Lines an overlay may use, borders included. */
function overlayMaxLines (rows: number): number {
  const total = terminalRows(rows)
  const available = Math.max(1, total - 2)
  const byRatio = Math.max(1, Math.floor(total * OVERLAY_HEIGHT_RATIO))
  return Math.min(available,
    Math.max(Math.min(OVERLAY_MIN_LINES, available), byRatio))
}

/** Lines the batch review page may use, borders included. */
function reviewMaxLines (rows: number, displayMode: DisplayMode): number {
  const cap = overlayMaxLines(rows)
  if (displayMode === 'overlay') {
    return cap
  }
  const dock = terminalRows(rows) - INLINE_DOCK_RESERVED_ROWS
  return Math.max(4, Math.min(cap, dock))
}

/** Widths of the list and details panes, or null for a single column. */
function splitPaneWidths (
  width: number,
  layout: SingleSelectLayout
): PaneWidths | null {
  if (layout === 'list' || width < SPLIT_MIN_WIDTH) {
    return null
  }
  const available = width - SPLIT_SEPARATOR.length
  if (available < SPLIT_LEFT_MIN + SPLIT_RIGHT_MIN) {
    return null
  }
  const left = Math.max(SPLIT_LEFT_MIN, Math.min(
    Math.floor(available * SPLIT_LEFT_SHARE), available - SPLIT_RIGHT_MIN))
  const right = available - left
  return right < SPLIT_RIGHT_MIN ? null : { left, right }
}

function helpBudget (bodyCapacity: number, helpRows: number): number {
  if (helpRows <= 0 || bodyCapacity <= 0) {
    return 0
  }
  return bodyCapacity >= 12 ? Math.min(2, helpRows) : 1
}

function minimumModeRows (mode: AskMode): number {
  switch (mode) {
    case 'freeform': return 5
    case 'comment': return 6
    case 'select': return 3
  }
}

function preferredModeRows (mode: AskMode): number {
  switch (mode) {
    case 'freeform': return 10
    case 'comment': return 11
    case 'select': return 8
  }
}

/** Whether context must collapse for the select list to fit the overlay. */
function contextOverflowsOverlay (
  questionRows: number,
  contextRows: number,
  bodyCapacity: number,
  helpRows: number
): boolean {
  if (contextRows === 0) {
    return false
  }
  const content = Math.max(0, bodyCapacity - helpBudget(bodyCapacity, helpRows))
  const separator = content >= 4 ? 1 : 0
  const promptCapacity = Math.max(0,
    content - separator - minimumModeRows('select'))
  return questionRows + 1 + contextRows > promptCapacity
}

interface BudgetInput {
  readonly mode: AskMode
  /** Rows left after the help line. */
  readonly contentRows: number
  readonly promptLines: number
  /** True while the context is collapsed to a one-line summary. */
  readonly contextCollapsed: boolean
}

/**
 * Splits overlay rows between the prompt pane (question and context) and
 * the mode pane (list or editor). The mode pane gets its preferred rows
 * where possible; in select mode the prompt keeps 2-3 useful rows.
 *
 * @param input - The current mode and space.
 * @returns Rows for each pane and the separator between them.
 */
function overlayBudgets (input: BudgetInput): OverlayBudgets {
  const { mode, contentRows, promptLines } = input
  if (mode !== 'select') {
    const modeRows = Math.max(Math.min(minimumModeRows(mode), contentRows),
      Math.min(preferredModeRows(mode), contentRows))
    const rest = Math.max(0, contentRows - modeRows)
    return rest > 0 && modeRows > 0
      ? { promptRows: rest - 1, modeRows, separatorRows: 1 }
      : { promptRows: rest, modeRows, separatorRows: 0 }
  }

  const separatorRows = contentRows >= 4 ? 1 : 0
  const shared = Math.max(0, contentRows - separatorRows)
  if (shared === 0) {
    return { promptRows: 0, modeRows: 0, separatorRows }
  }
  const promptMin = promptLines > 0 ? 1 : 0
  const modeMax = Math.max(0, shared - promptMin)
  const modeMin = Math.min(minimumModeRows(mode), modeMax)
  let modeRows = Math.max(modeMin, Math.min(preferredModeRows(mode), modeMax))
  let promptRows = shared - modeRows
  const target = input.contextCollapsed ? 3 : 2
  const useful = Math.min(promptLines,
    shared >= modeMin + target ? target : promptMin)
  if (promptRows < useful && modeRows > modeMin) {
    const shift = Math.min(useful - promptRows, modeRows - modeMin)
    modeRows -= shift
    promptRows += shift
  }
  return { promptRows, modeRows, separatorRows }
}

export {
  contextOverflowsOverlay,
  helpBudget,
  INLINE_CONTEXT_MAX_ROWS,
  minimumModeRows,
  overlayBudgets,
  overlayMaxLines,
  preferredModeRows,
  reviewMaxLines,
  SPLIT_SEPARATOR,
  splitPaneWidths
}
export type { AskMode, OverlayBudgets, PaneWidths }
