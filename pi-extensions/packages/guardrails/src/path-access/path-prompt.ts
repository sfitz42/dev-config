import { homedir } from 'node:os'

import {
  Container,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth
} from '@earendil-works/pi-tui'

import type { Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'

type PathPromptResult =
  | 'allow-file-once'
  | 'allow-dir-once'
  | 'allow-file-session'
  | 'allow-dir-session'
  | 'allow-file-always'
  | 'allow-dir-always'
  | 'deny'

interface PromptOption {
  readonly label: string
  readonly result: PathPromptResult
  /** Single-key shortcut. */
  readonly key?: string
}

interface PathPromptRequest {
  readonly toolName: string
  readonly displayPath: string
  readonly displayDirectory: string | undefined
  readonly cwd: string
  /** File tools and bash get file and directory options; ls/find only dirs. */
  readonly fileOptions: boolean
  /** False for `/` and home: directory grants are not offered. */
  readonly directoryGrantable: boolean
  /** False for a location only known at runtime: only once or deny. */
  readonly grantable: boolean
  readonly command?: string
}

const FILE_OPTIONS: readonly PromptOption[] = [
  { label: 'Allow once', result: 'allow-file-once', key: 'o' },
  { label: 'Allow file this session', result: 'allow-file-session', key: 'f' },
  { label: 'Allow file always', result: 'allow-file-always', key: 'F' },
  { label: 'Allow directory this session', result: 'allow-dir-session', key: 'd' },
  { label: 'Allow directory always', result: 'allow-dir-always', key: 'D' },
  { label: 'Deny', result: 'deny', key: 'n' }
]

const DIRECTORY_OPTIONS: readonly PromptOption[] = [
  { label: 'Allow once', result: 'allow-dir-once', key: 'o' },
  { label: 'Allow directory this session', result: 'allow-dir-session', key: 'd' },
  { label: 'Allow directory always', result: 'allow-dir-always', key: 'D' },
  { label: 'Deny', result: 'deny', key: 'n' }
]

const MAX_COMMAND_WIDTH = 500

/**
 * The options offered for a request, in display order.
 *
 * @param request - What is being asked.
 * @returns Options; directory grants are left out when too broad.
 */
function promptOptions (request: Pick<PathPromptRequest,
'fileOptions' | 'directoryGrantable' | 'grantable'>): PromptOption[] {
  const options = request.fileOptions ? FILE_OPTIONS : DIRECTORY_OPTIONS
  return options.filter((option) => {
    if (!request.grantable) {
      return option.result === 'deny' || option.result.endsWith('-once')
    }
    return request.directoryGrantable ||
      (option.result !== 'allow-dir-session' &&
        option.result !== 'allow-dir-always')
  })
}

/** Replaces control characters so a command cannot restyle the prompt. */
function sanitize (text: string): string {
  let safe = ''
  const collapsed = text.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ⏎ ')
    .replace(/\t+/g, ' ').replace(/ {2,}/g, ' ').trim()
  for (const char of collapsed) {
    const code = char.charCodeAt(0)
    safe += code === 0x1b ? '␛' : code < 0x20 || code === 0x7f ? '�' : char
  }
  return safe
}

function shortenHome (path: string, home = homedir()): string {
  if (path === home) {
    return '~'
  }
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * Builds the outside-workspace prompt. Deny is selected initially, so an
 * accidental Enter never grants access.
 *
 * @param request - What is being asked.
 * @returns A factory for `ctx.ui.custom`.
 */
function createPathPrompt (request: PathPromptRequest): (
  tui: TUI,
  theme: Theme,
  keybindings: unknown,
  done: (result: PathPromptResult) => void
) => Component {
  return (tui, theme, _keybindings, done) => {
    const options = promptOptions(request)
    let selected = options.findIndex((option) => option.result === 'deny')
    let expanded = false
    const command = request.command === undefined
      ? ''
      : sanitize(request.command)
    const container = new Container()
    const commandLine = new Text('', 1, 0)
    const footer = new Text('', 1, 0)

    container.addChild(new Text(
      theme.fg('warning', theme.bold('Outside Workspace Access')), 1, 0))
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('text',
      `\`${request.toolName}\` targets a path outside the working directory.`),
    1, 0))
    if (command !== '') {
      container.addChild(commandLine)
    }
    container.addChild(new Spacer(1))
    container.addChild(new Text(theme.fg('dim',
      `  Cwd:  ${shortenHome(request.cwd)}`), 1, 0))
    container.addChild(new Text(theme.fg('dim',
      `  Path: ${sanitize(request.displayPath)}`), 1, 0))
    if (request.displayDirectory !== undefined) {
      container.addChild(new Text(theme.fg('dim',
        `  Dir:  ${request.displayDirectory}`), 1, 0))
    }
    container.addChild(new Spacer(1))
    container.addChild({
      render: (width: number) => options.map((option, index) => {
        const label = truncateToWidth(
          ` ${option.key ?? ' '} ${option.label} `, Math.max(1, width - 1))
        return index === selected
          ? ` ${theme.bg('selectedBg', theme.fg('accent', label))}`
          : ` ${theme.fg('dim', label)}`
      }),
      invalidate: () => {}
    })
    container.addChild(new Spacer(1))
    container.addChild(footer)

    const move = (step: number): void => {
      selected = (selected + step + options.length) % options.length
      tui.requestRender()
    }

    return {
      render: (width: number): string[] => {
        const inner = Math.max(1, width - 4)
        const prefix = '  Command: '
        const fits = visibleWidth(prefix + command) <= inner &&
          command.length <= MAX_COMMAND_WIDTH
        commandLine.setText(theme.fg('dim', expanded || fits
          ? prefix + command
          : truncateToWidth(prefix + command, inner)))
        const keys = options.map((option) => option.key).join('/')
        footer.setText(theme.fg('dim',
          `↑/↓/Tab · Enter · ${keys} · Esc deny` +
          (fits ? '' : `\nx ${expanded ? 'collapse' : 'expand'} command`)))
        const border = (text: string): string => theme.fg('warning', text)
        const body = container.render(inner).map((line) => {
          const pad = Math.max(0, inner - visibleWidth(line))
          return `${border('│')} ${line}${' '.repeat(pad)} ${border('│')}`
        })
        const rule = '─'.repeat(Math.max(1, width - 2))
        return [border(`╭${rule}╮`), ...body, border(`╰${rule}╯`)]
      },
      invalidate: () => container.invalidate(),
      handleInput: (data: string): void => {
        if (matchesKey(data, Key.up) || matchesKey(data, Key.shift('tab')) ||
          data === 'k') {
          move(-1)
        } else if (matchesKey(data, Key.down) || matchesKey(data, Key.tab) ||
          data === 'j') {
          move(1)
        } else if (data === 'x' || data === 'X') {
          expanded = !expanded
          tui.requestRender()
        } else if (matchesKey(data, Key.enter)) {
          done(options[selected]?.result ?? 'deny')
        } else if (matchesKey(data, Key.escape)) {
          done('deny')
        } else {
          const shortcut = options.find((option) => option.key === data)
          if (shortcut !== undefined) {
            done(shortcut.result)
          }
        }
      }
    }
  }
}

export { createPathPrompt, promptOptions, sanitize }
export type { PathPromptRequest, PathPromptResult, PromptOption }
