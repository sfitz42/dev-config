import { CURSOR_MARKER, truncateToWidth } from '@earendil-works/pi-tui'

type Paint = (text: string) => string

const INVERSE_VIDEO = '\x1b[7m'

function fitPadded (line: string, width: number): string {
  return truncateToWidth(line, width, '', true)
}

/**
 * Cuts lines to a budget.
 *
 * @param lines - The lines to show.
 * @param budget - Rows available.
 * @param width - Line width.
 * @param dim - Paints the `…` overflow marker.
 * @param showOverflow - Replace the last row with `…` when cut.
 * @returns At most `budget` lines.
 */
function limitLines (
  lines: readonly string[],
  budget: number,
  width: number,
  dim: Paint,
  showOverflow: boolean
): string[] {
  const rows = Math.max(0, Math.floor(budget))
  if (rows === 0) {
    return []
  }
  if (lines.length <= rows || !showOverflow) {
    return lines.slice(0, rows).map((line) => fitPadded(line, width))
  }
  if (rows === 1) {
    return [dim('…')]
  }
  return [
    ...lines.slice(0, rows - 1).map((line) => fitPadded(line, width)),
    dim('…')
  ]
}

/**
 * Prefixes `↑`, `↓` (or `↕` on a single row) to show hidden lines.
 *
 * @returns The marked lines.
 */
function markOverflow (
  lines: readonly string[],
  width: number,
  dim: Paint,
  hiddenAbove: boolean,
  hiddenBelow: boolean
): string[] {
  const marked = [...lines]
  const mark = (index: number, symbol: string): void => {
    marked[index] = fitPadded(`${dim(symbol)} ${marked[index] ?? ''}`, width)
  }
  if (marked.length === 0) {
    return marked
  }
  if (hiddenAbove && hiddenBelow && marked.length === 1) {
    mark(0, '↕')
    return marked
  }
  if (hiddenAbove) {
    mark(0, '↑')
  }
  if (hiddenBelow) {
    mark(marked.length - 1, '↓')
  }
  return marked
}

/**
 * Fits a bordered editor into a budget, keeping its borders and the line
 * with the cursor visible.
 *
 * @returns At most `budget` lines.
 */
function limitEditorLines (
  lines: readonly string[],
  budget: number,
  width: number,
  dim: Paint
): string[] {
  const rows = Math.max(0, Math.floor(budget))
  if (rows === 0) {
    return []
  }
  if (lines.length <= rows) {
    return lines.map((line) => fitPadded(line, width))
  }
  if (rows === 1) {
    return [dim('…')]
  }
  const top = fitPadded(lines[0] ?? '', width)
  const bottom = fitPadded(lines[lines.length - 1] ?? '', width)
  if (rows === 2) {
    return [top, bottom]
  }
  const content = lines.slice(1, -1)
  const contentRows = rows - 2
  const cursor = content.findIndex((line) =>
    line.includes(CURSOR_MARKER) || line.includes(INVERSE_VIDEO))
  const maxStart = Math.max(0, content.length - contentRows)
  const start = cursor >= 0
    ? Math.max(0, Math.min(cursor - contentRows + 1, maxStart))
    : maxStart
  const visible = markOverflow(content.slice(start, start + contentRows),
    width, dim, start > 0, start + contentRows < content.length)
  return [top, ...visible, bottom]
}

export { limitEditorLines, limitLines, markOverflow }
