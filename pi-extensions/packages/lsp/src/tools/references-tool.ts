import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import {
  cleanPath,
  ensureDocumentOpen,
  errorMessage,
  formatLocation,
  positionFields,
  positionLabel,
  resolvePosition,
  textResult,
  truncateOutput,
  withNote
} from './tool-support.ts'

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Location } from 'vscode-languageserver-protocol'

import type { LspRuntime } from '../lsp-runtime.ts'

const parameters = Type.Object({
  ...positionFields,
  includeDeclaration: Type.Optional(Type.Boolean({
    description: 'Include the declaration in results (default: true)'
  }))
})

interface ReferencesDetails {
  readonly count: number
}

/**
 * Creates `lsp_references`. There is no tree-sitter fallback: finding
 * references needs a server.
 *
 * @param runtime - The LSP runtime.
 */
function createReferencesTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, ReferencesDetails> {
  return defineTool({
    name: 'lsp_references',
    label: 'LSP References',
    description: 'Find all references to a symbol at a specific position. Returns a list of file locations. Line and character are 1-indexed.',
    promptSnippet: 'Find all references to a symbol at a file position via LSP',
    parameters,
    async execute (_id, params) {
      const position = await resolvePosition(runtime, params)
      if (typeof position === 'string') {
        return textResult(position, { count: 0 })
      }
      const filePath = cleanPath(params.path)
      const manager = runtime.manager
      const client = manager.getClientForFile(filePath)
      if (client === undefined) {
        return textResult(manager.unavailableReason(filePath), { count: 0 })
      }
      try {
        await ensureDocumentOpen(runtime, client, filePath)
        const locations = await client.sendRequest<Location[] | null>(
          'textDocument/references', {
            textDocument: { uri: manager.getFileUri(filePath) },
            position: {
              line: position.line - 1,
              character: position.character - 1
            },
            context: { includeDeclaration: params.includeDeclaration ?? true }
          }) ?? []
        if (locations.length === 0) {
          return textResult(withNote(position, 'No references found.'),
            { count: 0 })
        }
        const body = locations.map((l) => formatLocation(manager.rootDir, l))
          .join('\n')
        return textResult(withNote(position,
          `${locations.length} reference(s) found:\n\n` +
          truncateOutput(body, 'references')), { count: locations.length })
      } catch (error) {
        return textResult(
          `LSP references request failed: ${errorMessage(error)}`, { count: 0 })
      }
    },
    renderCall (args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('lsp_references ')) +
        positionLabel(args, theme), 0, 0)
    },
    renderResult (result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Searching...'), 0, 0)
      }
      const { count } = result.details
      return count === 0
        ? new Text(theme.fg('dim', 'No references found'), 0, 0)
        : new Text(theme.fg('success', `${count} reference(s)`), 0, 0)
    }
  })
}

export { createReferencesTool }
