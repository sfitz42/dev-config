import { DiagnosticSeverity } from 'vscode-languageserver-protocol'

import type { Diagnostic } from 'vscode-languageserver-protocol'

const MAX_INJECTED_ERRORS = 10

interface SeverityCounts {
  readonly errors: number
  readonly warnings: number
  readonly other: number
}

function severityName (severity: number | undefined): string {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'error'
    case DiagnosticSeverity.Warning:
      return 'warning'
    case DiagnosticSeverity.Information:
      return 'info'
    case DiagnosticSeverity.Hint:
      return 'hint'
    default:
      return 'unknown'
  }
}

/**
 * `path:line:col severity: message (code) [source]`, 1-indexed.
 *
 * @param diagnostic - The diagnostic.
 * @param path - The file, as shown to the model.
 */
function formatDiagnostic (diagnostic: Diagnostic, path: string): string {
  const { line, character } = diagnostic.range.start
  const code = diagnostic.code === undefined ? '' : ` (${diagnostic.code})`
  const source = diagnostic.source === undefined
    ? ''
    : ` [${diagnostic.source}]`
  return `${path}:${line + 1}:${character + 1} ` +
    `${severityName(diagnostic.severity)}: ${diagnostic.message}${code}${source}`
}

/** Sorts errors first (missing severity last), stable otherwise. */
function bySeverity (a: Diagnostic, b: Diagnostic): number {
  return (a.severity ?? 99) - (b.severity ?? 99)
}

function countSeverities (diagnostics: readonly Diagnostic[]): SeverityCounts {
  const errors = diagnostics
    .filter((d) => d.severity === DiagnosticSeverity.Error).length
  const warnings = diagnostics
    .filter((d) => d.severity === DiagnosticSeverity.Warning).length
  return { errors, warnings, other: diagnostics.length - errors - warnings }
}

/** "2 error(s), 1 warning(s)" style summary; empty parts are left out. */
function summarizeCounts (counts: SeverityCounts): string {
  return [
    counts.errors > 0 ? `${counts.errors} error(s)` : undefined,
    counts.warnings > 0 ? `${counts.warnings} warning(s)` : undefined,
    counts.other > 0 ? `${counts.other} other` : undefined
  ].filter((part) => part !== undefined).join(', ')
}

/**
 * The note appended to a write or edit result when the file has errors:
 * errors only, at most ten.
 *
 * @param diagnostics - The file's diagnostics.
 * @param path - The file, as shown to the model.
 * @returns The note, or undefined when there are no errors.
 */
function injectedErrorNote (
  diagnostics: readonly Diagnostic[],
  path: string
): string | undefined {
  const errors = diagnostics
    .filter((d) => d.severity === DiagnosticSeverity.Error)
  if (errors.length === 0) {
    return undefined
  }
  const lines = errors.slice(0, MAX_INJECTED_ERRORS).map((d) => {
    const { line, character } = d.range.start
    const source = d.source === undefined ? '' : ` [${d.source}]`
    return `${path}:${line + 1}:${character + 1} error: ${d.message}${source}`
  })
  if (errors.length > MAX_INJECTED_ERRORS) {
    lines.push(`... and ${errors.length - MAX_INJECTED_ERRORS} more error(s)`)
  }
  return `\n\n⚠ LSP: ${errors.length} error(s) in ${path}:\n${lines.join('\n')}`
}

export {
  bySeverity,
  countSeverities,
  formatDiagnostic,
  injectedErrorNote,
  MAX_INJECTED_ERRORS,
  summarizeCounts
}
export type { SeverityCounts }
