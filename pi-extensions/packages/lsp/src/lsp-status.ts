import type { ServerStatus } from './lsp/lsp-manager.ts'

type StatusColour = 'accent' | 'dim' | 'warning' | 'error'

interface StatusLine {
  readonly colour: StatusColour
  readonly text: string
}

/**
 * The footer status after a tool runs: idle, or the running languages
 * with their total diagnostics.
 *
 * @param statuses - Every configured server.
 */
function footerStatus (statuses: readonly ServerStatus[]): StatusLine {
  const running = statuses.filter((s) => s.running)
  if (running.length === 0) {
    return { colour: 'dim', text: 'LSP: idle' }
  }
  const diagnostics = running.reduce((n, s) => n + s.diagnosticsCount, 0)
  const suffix = diagnostics > 0
    ? ` (${diagnostics} diagnostic${diagnostics === 1 ? '' : 's'})`
    : ''
  return {
    colour: 'accent',
    text: `LSP: ${running.map((s) => s.languageId).join(', ')}${suffix}`
  }
}

/**
 * The `/lsp` report: one line per configured server.
 *
 * @param statuses - Every configured server.
 */
function statusReport (statuses: readonly ServerStatus[]): string {
  return statuses.map((s) => {
    const icon = s.running ? '🟢' : '⚪'
    const diagnostics = s.diagnosticsCount > 0
      ? ` (${s.diagnosticsCount} diagnostics)`
      : ''
    return `${icon} ${s.languageId}: ${s.command}${diagnostics}` +
      (s.shared ? ' [shared]' : '')
  }).join('\n')
}

export { footerStatus, statusReport }
export type { StatusColour, StatusLine }
