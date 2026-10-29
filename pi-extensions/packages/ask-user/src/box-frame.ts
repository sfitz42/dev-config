import { truncateToWidth } from '@earendil-works/pi-tui'

import type { Theme } from '@earendil-works/pi-coding-agent'

type Paint = (text: string) => string

const BORDER_LEFT = '│ '
const BORDER_RIGHT = ' │'
const BORDER_OVERHEAD = BORDER_LEFT.length + BORDER_RIGHT.length

/** The top border, with the title set in after `╭─` when it fits. */
function topBorder (
  width: number,
  title: string,
  paint: Paint,
  paintTitle: Paint
): string {
  const inner = Math.max(0, width - 2)
  if (title === '' || inner < title.length + 4) {
    return paint(`╭${'─'.repeat(inner)}╮`)
  }
  const label = ` ${title} `
  const rest = Math.max(0, inner - 1 - label.length)
  return paint('╭─') + paintTitle(label) + paint(`${'─'.repeat(rest)}╮`)
}

/** The bottom border, with the label set in before `─╯` when it fits. */
function bottomBorder (
  width: number,
  label: string,
  paint: Paint,
  paintLabel: Paint
): string {
  const inner = Math.max(0, width - 2)
  if (label === '' || inner < label.length + 4) {
    return paint(`╰${'─'.repeat(inner)}╯`)
  }
  const tag = ` ${label} `
  const rest = Math.max(0, inner - tag.length - 1)
  return paint(`╰${'─'.repeat(rest)}`) + paintLabel(tag) + paint('─╯')
}

/**
 * Frames body lines in the ask_user box.
 *
 * @param theme - The active theme.
 * @param title - Shown in the top border.
 * @param footer - Shown in the bottom border (the version).
 * @param body - Lines, padded or truncated to the inner width.
 * @param width - The full width, borders included.
 * @returns The framed lines.
 */
function frame (
  theme: Theme,
  title: string,
  footer: string,
  body: readonly string[],
  width: number
): string[] {
  const inner = Math.max(1, width - BORDER_OVERHEAD)
  const paint: Paint = (text) => theme.fg('accent', text)
  const left = paint(BORDER_LEFT)
  const right = paint(BORDER_RIGHT)
  return [
    topBorder(width, title, paint,
      (text) => theme.fg('dim', theme.bold(text))),
    ...body.map((line) =>
      `${left}${truncateToWidth(line, inner, '', true)}${right}`),
    bottomBorder(width, footer, paint, (text) => theme.fg('dim', text))
  ]
}

function innerWidth (width: number): number {
  return Math.max(1, width - BORDER_OVERHEAD)
}

export { bottomBorder, frame, innerWidth, topBorder }
