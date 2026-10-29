import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import {
  cleanPath,
  ensureDocumentOpen,
  errorMessage,
  positionFields,
  positionLabel,
  resolvePosition,
  textResult,
  withNote
} from './tool-support.ts'
import { summarizeActionEdit } from './workspace-edit-format.ts'

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  CodeAction,
  Command,
  Diagnostic,
  Range
} from 'vscode-languageserver-protocol'

import type { LspRuntime } from '../lsp-runtime.ts'

const parameters = Type.Object({
  ...positionFields,
  endLine: Type.Optional(Type.Number({
    description: 'End line for range selection (1-indexed). Defaults to line.'
  })),
  endCharacter: Type.Optional(Type.Number({
    description: 'End column for range selection (1-indexed). Defaults to character.'
  })),
  kind: Type.Optional(Type.String({
    description: 'Filter by action kind (e.g., "quickfix", "refactor", "source")'
  }))
})

interface CodeActionsDetails {
  readonly count: number
  readonly preferredCount: number
}

const NONE: CodeActionsDetails = { count: 0, preferredCount: 0 }
const KIND_ORDER: Readonly<Record<string, number>> = {
  quickfix: 0,
  refactor: 1,
  source: 2
}

/** A bare Command has a string `command`; a CodeAction never does. */
function isCommand (item: CodeAction | Command): item is Command {
  return typeof item.command === 'string'
}

function contains (range: Range, line: number, character: number): boolean {
  const { start, end } = range
  if (line < start.line || line > end.line) {
    return false
  }
  return !(line === start.line && character < start.character) &&
    !(line === end.line && character > end.character)
}

/** Diagnostics that touch the requested range (0-indexed). */
function overlapping (
  diagnostics: readonly Diagnostic[],
  range: Range
): Diagnostic[] {
  return diagnostics.filter((d) =>
    contains(d.range, range.start.line, range.start.character) ||
    contains(range, d.range.start.line, d.range.start.character))
}

function kindRank (action: CodeAction): number {
  const family = action.kind?.split('.')[0]
  return family === undefined ? 3 : KIND_ORDER[family] ?? 3
}

/** Preferred actions first, then quick fixes, refactors, source actions. */
function byPreference (a: CodeAction, b: CodeAction): number {
  const preferred = Number(b.isPreferred === true) -
    Number(a.isPreferred === true)
  return preferred !== 0 ? preferred : kindRank(a) - kindRank(b)
}

function describeActions (
  rootDir: string,
  actions: readonly CodeAction[],
  commands: readonly Command[]
): string[] {
  const lines = actions.flatMap((action, i) => {
    const star = action.isPreferred === true ? '★ ' : ''
    const kind = action.kind === undefined ? '' : ` [${action.kind}]`
    const header = `  ${i + 1}. ${star}${action.title}${kind}`
    if (action.edit !== undefined) {
      return [header, ...summarizeActionEdit(rootDir, action.edit)]
    }
    if (action.command !== undefined) {
      const name = action.command.title === ''
        ? action.command.command
        : action.command.title
      return [header, `     (command: ${name})`]
    }
    return [header, '     (resolve required)']
  })
  return [...lines, ...commands.map((c) =>
    `  • ${c.title} (command-only, requires IDE execution)`)]
}

/**
 * Creates `lsp_code_actions`. Actions are listed, never executed.
 *
 * @param runtime - The LSP runtime.
 */
function createCodeActionsTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, CodeActionsDetails> {
  return defineTool({
    name: 'lsp_code_actions',
    label: 'LSP Code Actions',
    description: 'Get available code actions (quick fixes, refactorings, source actions) at a position or range. Returns actionable fixes the LSP server can suggest — auto-imports, remove unused, extract method, etc.',
    promptSnippet: 'Get available code actions (quick fixes, refactorings) at a file position via LSP. Use after lsp_diagnostics shows errors to find auto-fixes.',
    parameters,
    async execute (_id, params) {
      const position = await resolvePosition(runtime, params)
      if (typeof position === 'string') {
        return textResult(position, NONE)
      }
      const filePath = cleanPath(params.path)
      const manager = runtime.manager
      const client = manager.getClientForFile(filePath)
      if (client === undefined) {
        return textResult(manager.unavailableReason(filePath), NONE)
      }
      if (client.serverCapabilities?.codeActionProvider === undefined ||
        client.serverCapabilities.codeActionProvider === false) {
        return textResult(
          'LSP server for this file does not support code actions.', NONE)
      }
      const uri = manager.getFileUri(filePath)
      const range: Range = {
        start: { line: position.line - 1, character: position.character - 1 },
        end: {
          line: (params.endLine ?? position.line) - 1,
          character: (params.endCharacter ?? position.character) - 1
        }
      }
      try {
        await ensureDocumentOpen(runtime, client, filePath)
        const response = await client.sendRequest<
        Array<CodeAction | Command> | null
        >('textDocument/codeAction', {
          textDocument: { uri },
          range,
          context: {
            diagnostics: overlapping(client.getDiagnostics(uri), range),
            ...(params.kind === undefined ? {} : { only: [params.kind] })
          }
        }) ?? []
        if (response.length === 0) {
          return textResult(withNote(position,
            'No code actions available at this position.'), NONE)
        }
        const commands = response.filter(isCommand)
        const actions = response
          .filter((item): item is CodeAction => !isCommand(item))
          .sort(byPreference)
        const preferredCount = actions
          .filter((a) => a.isPreferred === true).length
        const count = actions.length + commands.length
        const preferred = preferredCount > 0
          ? ` (${preferredCount} preferred)`
          : ''
        const header = `${count} code action(s) at ${filePath}:` +
          `${position.line}:${position.character}${preferred}`
        return textResult(withNote(position, `${header}\n\n` +
          describeActions(manager.rootDir, actions, commands).join('\n')),
        { count, preferredCount })
      } catch (error) {
        return textResult(
          `LSP code action request failed: ${errorMessage(error)}`, NONE)
      }
    },
    renderCall (args, theme) {
      let text = theme.fg('toolTitle', theme.bold('lsp_code_actions ')) +
        positionLabel(args, theme)
      if (args.endLine !== undefined) {
        text += theme.fg('accent',
          `-${args.endLine}:${args.endCharacter ?? args.character ?? '?'}`)
      }
      if (args.kind !== undefined) {
        text += theme.fg('dim', ` [${args.kind}]`)
      }
      return new Text(text, 0, 0)
    },
    renderResult (result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Loading...'), 0, 0)
      }
      const { count, preferredCount } = result.details
      if (count === 0) {
        return new Text(theme.fg('dim', 'No code actions available'), 0, 0)
      }
      const preferred = preferredCount > 0
        ? ` (${preferredCount} preferred)`
        : ''
      return new Text(theme.fg('success', `${count} action(s)${preferred}`),
        0, 0)
    }
  })
}

export { byPreference, createCodeActionsTool, isCommand, overlapping }
