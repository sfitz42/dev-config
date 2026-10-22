import { getMarkdownTheme } from '@earendil-works/pi-coding-agent'
import { Markdown, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import type { MarkdownTheme } from '@earendil-works/pi-tui'

/**
 * The host's markdown theme, or undefined when it cannot style text (its
 * closures throw on first use if the host theme was never set up).
 */
function safeMarkdownTheme (): MarkdownTheme | undefined {
  try {
    const theme = getMarkdownTheme()
    theme.bold('')
    return theme
  } catch {
    return undefined
  }
}

/**
 * Renders markdown to lines, falling back to wrapped plain text.
 *
 * @param text - Markdown source.
 * @param width - Line width.
 * @returns Lines without trailing blank ones.
 */
function markdownLines (text: string, width: number): string[] {
  const theme = safeMarkdownTheme()
  const lines = theme === undefined
    ? wrapTextWithAnsi(text, Math.max(10, width))
      .map((line) => truncateToWidth(line, width, ''))
    : new Markdown(text, 0, 0, theme).render(width)
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop()
  }
  return lines
}

export { markdownLines, safeMarkdownTheme }
