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
  truncateOutput,
  withNote
} from './tool-support.ts'
import { formatRenameEdit } from './workspace-edit-format.ts'

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { WorkspaceEdit } from 'vscode-languageserver-protocol'

import type { LspRuntime } from '../lsp-runtime.ts'

const parameters = Type.Object({
  ...positionFields,
  newName: Type.String({ description: 'New name for the symbol' })
})

interface RenameDetails {
  readonly fileCount: number
  readonly editCount: number
}

const NONE: RenameDetails = { fileCount: 0, editCount: 0 }

/**
 * Creates `lsp_rename`. It previews the edits only; the model applies
 * them with edit or write.
 *
 * @param runtime - The LSP runtime.
 */
function createRenameTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, RenameDetails> {
  return defineTool({
    name: 'lsp_rename',
    label: 'LSP Rename',
    description: 'Preview a rename refactoring for a symbol at a position. Returns the list of changes that would be made across all files. Does NOT apply the changes — use edit/write tools to apply them. Line and character are 1-indexed.',
    promptSnippet: 'Preview rename refactoring for a symbol (returns planned edits, does not apply them)',
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
      try {
        await ensureDocumentOpen(runtime, client, filePath)
        const edit = await client.sendRequest<WorkspaceEdit | null>(
          'textDocument/rename', {
            textDocument: { uri: manager.getFileUri(filePath) },
            position: {
              line: position.line - 1,
              character: position.character - 1
            },
            newName: params.newName
          })
        if (edit === null) {
          return textResult(withNote(position,
            'Rename not possible at this position.'), NONE)
        }
        const preview = formatRenameEdit(manager.rootDir, edit)
        if (preview.editCount === 0) {
          return textResult(withNote(position,
            'No edits needed for this rename.'), NONE)
        }
        return textResult(withNote(position,
          `Rename "${params.newName}": ${preview.editCount} edit(s) across ` +
          `${preview.fileCount} file(s)\n\nNOTE: These changes are NOT ` +
          'applied. Use edit/write tools to make the changes.\n\n' +
          truncateOutput(preview.text)), {
          fileCount: preview.fileCount,
          editCount: preview.editCount
        })
      } catch (error) {
        return textResult(`LSP rename request failed: ${errorMessage(error)}`,
          NONE)
      }
    },
    renderCall (args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('lsp_rename ')) +
        positionLabel(args, theme) + theme.fg('muted', ` → ${args.newName}`),
      0, 0)
    },
    renderResult (result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Computing...'), 0, 0)
      }
      const { editCount, fileCount } = result.details
      return editCount === 0
        ? new Text(theme.fg('dim', 'No edits'), 0, 0)
        : new Text(theme.fg('success', `${editCount} edit(s) in ${fileCount} ` +
          'file(s) (preview only)'), 0, 0)
    }
  })
}

export { createRenameTool }
