import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { syntaxErrors } from '../tree-sitter/symbol-extractor.ts'
import {
  bySeverity,
  countSeverities,
  formatDiagnostic,
  summarizeCounts
} from './diagnostic-format.ts'
import {
  cleanPath,
  displayPath,
  ensureDocumentOpen,
  parseFile,
  textResult,
  truncateOutput,
  useTreeSitter
} from './tool-support.ts'

import type {
  AgentToolResult,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { Diagnostic } from 'vscode-languageserver-protocol'

import type { LspRuntime } from '../lsp-runtime.ts'

const parameters = Type.Object({
  path: Type.String({
    description: 'File path to get diagnostics for. Pass "*" to get all workspace diagnostics from all running LSP servers.'
  })
})

interface DiagnosticsDetails {
  readonly count: number
  readonly errors?: number
  readonly warnings?: number
  readonly files?: number
}

type DiagnosticsResult = AgentToolResult<DiagnosticsDetails>

const TREE_SITTER_NOTE = '[tree-sitter — syntax only, no type checking]'

/** How long a server usually takes to publish after a file is sent. */
const DIAGNOSTIC_SETTLE_MS = 1_500

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function workspaceDiagnostics (runtime: LspRuntime): DiagnosticsResult {
  const manager = runtime.manager
  const running = manager.getStatus().filter((s) => s.running)
  if (running.length === 0) {
    return textResult('No LSP servers are running. Use lsp_diagnostics with ' +
      'a file path to start a server and check that file.', { count: 0 })
  }
  const all: Array<{ path: string, diagnostic: Diagnostic }> = []
  for (const status of running) {
    const client = manager.getRunningClient(status.languageId)
    for (const [uri, list] of client?.getAllDiagnostics() ?? []) {
      const path = displayPath(manager.rootDir, uri)
      all.push(...list.map((diagnostic) => ({ path, diagnostic })))
    }
  }
  if (all.length === 0) {
    const languages = running.map((s) => s.languageId).join(', ')
    return textResult(`No diagnostics across ${running.length} running ` +
      `server(s) (${languages}).`, { count: 0 })
  }
  all.sort((a, b) => bySeverity(a.diagnostic, b.diagnostic) ||
    a.path.localeCompare(b.path))
  const counts = countSeverities(all.map((d) => d.diagnostic))
  const files = new Set(all.map((d) => d.path)).size
  const summary = [`${all.length} diagnostic(s) in ${files} file(s)`,
    summarizeCounts(counts)].filter((s) => s !== '').join(', ')
  const body = all.map((d) => formatDiagnostic(d.diagnostic, d.path))
    .join('\n')
  return textResult(`${summary}\n\n${truncateOutput(body, 'diagnostics')}`, {
    count: all.length,
    errors: counts.errors,
    warnings: counts.warnings,
    files
  })
}

async function treeSitterDiagnostics (
  runtime: LspRuntime,
  filePath: string
): Promise<DiagnosticsResult | undefined> {
  const parsed = await parseFile(runtime, filePath)
  if (parsed === undefined) {
    return undefined
  }
  const errors = syntaxErrors(parsed.tree)
  if (errors.length === 0) {
    return textResult(`No syntax errors detected. ${TREE_SITTER_NOTE}`,
      { count: 0 })
  }
  const path = displayPath(runtime.manager.rootDir,
    runtime.manager.resolvePath(filePath))
  const body = errors.map((e) =>
    `${path}:${e.line + 1}:${e.character + 1} error: ${e.message}`).join('\n')
  return textResult(`${errors.length} syntax error(s) ${TREE_SITTER_NOTE}` +
    `\n\n${truncateOutput(body, 'diagnostics')}`,
  { count: errors.length, errors: errors.length })
}

async function fileDiagnostics (
  runtime: LspRuntime,
  filePath: string
): Promise<DiagnosticsResult> {
  const manager = runtime.manager
  const client = manager.getClientForFile(filePath)
  if (client !== undefined) {
    const uri = manager.getFileUri(filePath)
    if (await ensureDocumentOpen(runtime, client, filePath)) {
      await sleep(DIAGNOSTIC_SETTLE_MS)
    }
    const diagnostics = [...client.getDiagnostics(uri)].sort(bySeverity)
    if (diagnostics.length === 0) {
      return textResult('No diagnostics (clean).', { count: 0 })
    }
    const path = displayPath(manager.rootDir, manager.resolvePath(filePath))
    const counts = countSeverities(diagnostics)
    const body = diagnostics.map((d) => formatDiagnostic(d, path)).join('\n')
    return textResult(`${summarizeCounts(counts)}\n\n` +
      truncateOutput(body, 'diagnostics'), {
      count: diagnostics.length,
      errors: counts.errors,
      warnings: counts.warnings
    })
  }
  if (useTreeSitter(runtime, filePath)) {
    const fallback = await treeSitterDiagnostics(runtime, filePath)
    if (fallback !== undefined) {
      return fallback
    }
  }
  return textResult(manager.unavailableReason(filePath), { count: 0 })
}

/**
 * Creates `lsp_diagnostics`.
 *
 * @param runtime - The LSP runtime.
 */
function createDiagnosticsTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, DiagnosticsDetails> {
  return defineTool({
    name: 'lsp_diagnostics',
    label: 'LSP Diagnostics',
    description: 'Get compilation errors and warnings from the LSP server. Pass a file path to check a single file, or pass "*" to get all cached diagnostics across the workspace.',
    promptSnippet: 'Get compiler errors, warnings, and hints for a source file via LSP. Pass path="*" to get all workspace diagnostics.',
    promptGuidelines: [
      'After making code changes with edit or write, use lsp_diagnostics to check for compilation errors before moving on.',
      'To review all workspace diagnostics at once, call lsp_diagnostics with path="*" — this returns all cached diagnostics from running LSP servers without needing to check files individually.'
    ],
    parameters,
    async execute (_id, params) {
      const filePath = cleanPath(params.path)
      return filePath === '*' || filePath === ''
        ? workspaceDiagnostics(runtime)
        : await fileDiagnostics(runtime, filePath)
    },
    renderCall (args, theme) {
      const target = args.path !== '*' && args.path !== ''
        ? theme.fg('accent', args.path)
        : theme.fg('dim', '(workspace)')
      return new Text(theme.fg('toolTitle', theme.bold('lsp_diagnostics ')) +
        target, 0, 0)
    },
    renderResult (result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Checking...'), 0, 0)
      }
      const { count, errors = 0, warnings = 0, files = 0 } = result.details
      if (count === 0) {
        return new Text(theme.fg('success', '✓ No diagnostics'), 0, 0)
      }
      let text = [
        errors > 0 ? theme.fg('error', `${errors} error(s)`) : '',
        warnings > 0 ? theme.fg('warning', `${warnings} warning(s)`) : ''
      ].filter((part) => part !== '').join(' ')
      if (text === '') {
        text = theme.fg('muted', `${count} diagnostic(s)`)
      }
      if (files > 0) {
        text += theme.fg('dim', ` in ${files} file(s)`)
      }
      const [first] = result.content
      if (expanded && first?.type === 'text') {
        for (const line of first.text.split('\n').slice(0, 30)) {
          text += `\n${theme.fg('dim', line)}`
        }
      }
      return new Text(text, 0, 0)
    }
  })
}

export { createDiagnosticsTool, DIAGNOSTIC_SETTLE_MS, sleep }
