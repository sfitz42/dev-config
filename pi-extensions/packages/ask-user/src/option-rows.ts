import type { QuestionOption } from './ask-types.ts'

/** One plain-text row of a single-select list, before styling. */
interface OptionRow {
  readonly line: string
  /** True when the row belongs to the highlighted item. */
  readonly selected: boolean
}

interface OptionRowsInput {
  readonly options: readonly QuestionOption[]
  readonly selectedIndex: number
  readonly width: number
  readonly allowFreeform: boolean
  readonly allowComment: boolean
  readonly commentEnabled: boolean
  /** Rows available; the list scrolls around the selection beyond this. */
  readonly maxRows?: number
  readonly hideDescriptions?: boolean
}

const MIN_WIDTH = 12
const MIN_WRAP_WIDTH = 8
const DESCRIPTION_INDENT = '      '
const COMMENT_TOGGLE_LABEL = 'Add extra context after selection'
const FREEFORM_LABEL = 'Type something. — Enter a custom response'

function hardBreak (word: string, width: number): string[] {
  const chunks: string[] = []
  for (let start = 0; start < word.length; start += width) {
    chunks.push(word.slice(start, start + width))
  }
  return chunks
}

/**
 * Word-wraps plain text, collapsing whitespace and breaking words longer
 * than the width.
 *
 * @param text - Plain text (no ANSI codes).
 * @param width - Maximum line length.
 * @returns At least one line.
 */
function wrapPlain (text: string, width: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
    .filter((word) => word !== '')
  if (words.length === 0) {
    return ['']
  }
  const size = Math.max(1, width)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (candidate.length <= size) {
      current = candidate
      continue
    }
    if (current !== '') {
      lines.push(current)
    }
    if (word.length <= size) {
      current = word
    } else {
      const chunks = hardBreak(word, size)
      current = chunks.pop() ?? ''
      lines.push(...chunks)
    }
  }
  if (current !== '') {
    lines.push(current)
  }
  return lines
}

function prefixed (prefix: string, lines: readonly string[]): string[] {
  const indent = ' '.repeat(prefix.length)
  return lines.map((line, index) =>
    `${index === 0 ? prefix : indent}${line}`.trimEnd())
}

function itemBlocks (input: OptionRowsInput): string[][] {
  const width = Math.max(MIN_WIDTH, input.width)
  const pointer = (index: number): string =>
    index === input.selectedIndex ? '→' : ' '
  const wrapAfter = (prefix: string, text: string): string[] =>
    prefixed(prefix, wrapPlain(text,
      Math.max(MIN_WRAP_WIDTH, width - prefix.length)))

  const blocks = input.options.map((option, index) => {
    const lines = wrapAfter(`${pointer(index)} ${index + 1}. `, option.title)
    if (option.description !== undefined && input.hideDescriptions !== true) {
      lines.push(...wrapAfter(DESCRIPTION_INDENT, option.description))
    }
    return lines
  })
  if (input.allowComment) {
    const box = input.commentEnabled ? '[✓]' : '[ ]'
    blocks.push(wrapAfter(`${pointer(blocks.length)}   `,
      `${box} ${COMMENT_TOGGLE_LABEL}`))
  }
  if (input.allowFreeform) {
    blocks.push(wrapAfter(`${pointer(blocks.length)}   `, FREEFORM_LABEL))
  }
  return blocks
}

function toRows (
  blocks: readonly string[][],
  first: number,
  selectedIndex: number
): OptionRow[] {
  return blocks.flatMap((lines, offset) => lines.map((line) => ({
    line,
    selected: first + offset === selectedIndex
  })))
}

/**
 * Lays out a single-select list as plain rows: numbered, wrapped options
 * with indented descriptions, then the comment toggle and freeform rows.
 * When the rows exceed `maxRows`, a window around the selected item is
 * shown with a `(i/n)` indicator.
 *
 * @param input - The list state and the space available.
 * @returns The rows to style and draw.
 */
function renderOptionRows (input: OptionRowsInput): OptionRow[] {
  const blocks = itemBlocks(input)
  const all = toRows(blocks, 0, input.selectedIndex)
  const { maxRows } = input
  if (maxRows === undefined || !Number.isFinite(maxRows) || maxRows <= 0 ||
    all.length <= maxRows) {
    return all
  }

  const cap = Math.max(1, Math.floor(maxRows))
  const selected = blocks[input.selectedIndex] === undefined
    ? 0
    : input.selectedIndex
  const selectedBlock = blocks[selected] ?? []
  const indicator = {
    line: `  (${input.selectedIndex + 1}/${blocks.length})`,
    selected: false
  }
  const available = cap > 1 ? cap - 1 : 1

  if (selectedBlock.length >= available) {
    const rows = selectedBlock.slice(0, available)
      .map((line) => ({ line, selected: true }))
    return (cap > 1 ? [...rows, indicator] : rows).slice(0, cap)
  }

  let start = selected
  let end = selected + 1
  let used = selectedBlock.length
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
  return [
    ...toRows(blocks.slice(start, end), start, input.selectedIndex),
    indicator
  ].slice(0, cap)
}

export { COMMENT_TOGGLE_LABEL, renderOptionRows, wrapPlain }
export type { OptionRow, OptionRowsInput }
