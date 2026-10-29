import { DynamicBorder } from '@earendil-works/pi-coding-agent'
import {
  Container,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi
} from '@earendil-works/pi-tui'

import type { Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'

type GateAnswer = 'allow' | 'allow-session' | 'deny' | 'stop'

const VIEWPORT_LINES = 12
const SELECT_OPTIONS: readonly { label: string, answer: GateAnswer }[] = [
  { label: 'Deny', answer: 'deny' },
  { label: 'Allow once', answer: 'allow' },
  { label: 'Allow for session', answer: 'allow-session' },
  { label: 'Decline and stop', answer: 'stop' }
]

/** Escapes terminal control characters so the command shows as typed. */
function visible (text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    out += code === 0x1b
      ? '␛'
      : (code < 0x20 && char !== '\n' && char !== '\t') || code === 0x7f
          ? '�'
          : char
  }
  return out
}

/** Numbered, wrapped lines; the first logical line stays pinned. */
function numberedRows (
  command: string,
  width: number,
  theme: Theme
): { pinned: string[], rest: string[] } {
  const lines = visible(command).split('\n')
  const digits = Math.max(2, String(lines.length).length)
  const textWidth = Math.max(1, width - digits - 1)
  const pinned: string[] = []
  const rest: string[] = []
  lines.forEach((line, index) => {
    const number = theme.fg('dim', String(index + 1).padStart(digits))
    const wrapped = wrapTextWithAnsi(theme.fg('text', line), textWidth)
    for (const row of wrapped.length > 0 ? wrapped : ['']) {
      (index === 0 ? pinned : rest).push(`${number} ${row}`)
    }
  })
  return { pinned, rest }
}

/**
 * Builds the dangerous-command prompt. Enter does not allow: approving
 * needs `y`, so a stray keypress cannot run the command.
 *
 * @param command - The full command.
 * @param description - Why it is dangerous.
 * @returns A factory for `ctx.ui.custom`.
 */
function createGatePrompt (command: string, description: string): (
  tui: TUI,
  theme: Theme,
  keybindings: unknown,
  done: (answer: GateAnswer) => void
) => Component {
  return (tui, theme, _keybindings, done) => {
    let offset = 0
    const container = new Container()
    const top = new Text('', 0, 0)
    const body = new Text('', 1, 0)
    const bottom = new Text('', 0, 0)
    const red = (text: string): string => theme.fg('error', text)

    container.addChild(new DynamicBorder(red))
    container.addChild(new Text(
      theme.fg('error', theme.bold('Dangerous Command Detected')), 1, 0))
    container.addChild(new Spacer(1))
    container.addChild(new Text(
      theme.fg('warning', `This command contains ${description}:`), 1, 0))
    container.addChild(new Spacer(1))
    container.addChild(top)
    container.addChild(body)
    container.addChild(bottom)
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('text', 'Allow execution?'), 1, 0))
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('dim',
      '↑/↓ j/k scroll · y allow · a session · n/Enter/Esc deny · s decline & stop'),
    1, 0))
    container.addChild(new DynamicBorder(red))

    const viewport = (width: number): {
      pinned: string[],
      rest: string[],
      window: number,
      max: number
    } => {
      const rows = numberedRows(command, Math.max(1, width - 4), theme)
      const window = Math.max(0, VIEWPORT_LINES - rows.pinned.length)
      return { ...rows, window, max: Math.max(0, rows.rest.length - window) }
    }
    const rule = (width: number, label: string): string => {
      const text = truncateToWidth(label, Math.max(1, width))
      return theme.fg('dim',
        '─'.repeat(Math.max(0, width - visibleWidth(text))) + text)
    }

    return {
      render: (width: number): string[] => {
        const { pinned, rest, window, max } = viewport(width)
        offset = Math.min(offset, max)
        const shown = rest.slice(offset, offset + window)
        const below = rest.length - offset - shown.length
        top.setText(rule(width, offset > 0 ? `↑ ${offset} more` : ''))
        body.setText([...pinned, ...shown].join('\n'))
        bottom.setText(rule(width, below > 0 ? `↓ ${below} more` : ''))
        return container.render(width)
      },
      invalidate: () => container.invalidate(),
      handleInput: (data: string): void => {
        const { max } = viewport(tui.terminal.columns)
        if (matchesKey(data, Key.up) || data === 'k') {
          offset = Math.max(0, offset - 1)
          tui.requestRender()
        } else if (matchesKey(data, Key.down) || data === 'j') {
          offset = Math.min(max, offset + 1)
          tui.requestRender()
        } else if (data === 'y' || data === 'Y') {
          done('allow')
        } else if (data === 'a' || data === 'A') {
          done('allow-session')
        } else if (data === 's' || data === 'S') {
          done('stop')
        } else if (data === 'n' || data === 'N' || matchesKey(data, Key.enter) ||
          matchesKey(data, Key.escape)) {
          done('deny')
        }
      }
    }
  }
}

/** Title for the plain select used outside the TUI (RPC clients). */
function selectTitle (command: string, description: string): string {
  const indented = visible(command).replace(/^/gm, '    ')
  return `Dangerous command: ${description}\n\n${indented}`
}

export { createGatePrompt, SELECT_OPTIONS, selectTitle }
export type { GateAnswer }
