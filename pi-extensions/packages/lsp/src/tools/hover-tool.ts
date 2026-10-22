import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import {
  enclosingDeclaration,
  signatureText
} from '../tree-sitter/symbol-extractor.ts'
import {
  cleanPath,
  ensureDocumentOpen,
  errorMessage,
  parseFile,
  positionFields,
  positionLabel,
  resolvePosition,
  textResult,
  useTreeSitter,
  withNote
} from './tool-support.ts'

import type {
  AgentToolResult,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { Hover, MarkedString } from 'vscode-languageserver-protocol'

import type { LspRuntime } from '../lsp-runtime.ts'
import type { ResolvedPosition } from './tool-support.ts'

const parameters = Type.Object(positionFields)

interface HoverDetails {
  readonly hasResult: boolean
}

type HoverResult = AgentToolResult<HoverDetails>

function markedText (value: MarkedString): string {
  return typeof value === 'string'
    ? value
    : `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

/**
 * Hover contents as plain text: markup is passed through, code blocks
 * are fenced.
 *
 * @param hover - The server's hover result.
 */
function hoverText (hover: Hover): string {
  const { contents } = hover
  if (Array.isArray(contents)) {
    return contents.map(markedText).join('\n\n')
  }
  if (typeof contents === 'object' && 'kind' in contents) {
    return contents.value
  }
  return markedText(contents)
}

async function treeSitterHover (
  runtime: LspRuntime,
  filePath: string,
  position: ResolvedPosition
): Promise<HoverResult | undefined> {
  const parsed = await parseFile(runtime, filePath)
  if (parsed === undefined) {
    return undefined
  }
  const declaration = enclosingDeclaration(parsed.tree, position.line - 1,
    position.character - 1)
  if (declaration === undefined) {
    return textResult(withNote(position,
      'No hover information available at this position. [tree-sitter]'),
    { hasResult: false })
  }
  const kind = declaration.type.replace(/_/g, ' ')
  return textResult(withNote(position, `${kind} [tree-sitter]\n\n` +
    `\`\`\`\n${signatureText(declaration)}\n\`\`\``), { hasResult: true })
}

async function hover (
  runtime: LspRuntime,
  filePath: string,
  position: ResolvedPosition
): Promise<HoverResult> {
  const manager = runtime.manager
  const client = manager.getClientForFile(filePath)
  if (client !== undefined) {
    try {
      await ensureDocumentOpen(runtime, client, filePath)
      const result = await client.sendRequest<Hover | null>(
        'textDocument/hover', {
          textDocument: { uri: manager.getFileUri(filePath) },
          position: {
            line: position.line - 1,
            character: position.character - 1
          }
        })
      return result === null
        ? textResult(withNote(position,
          'No hover information available at this position.'),
        { hasResult: false })
        : textResult(withNote(position, hoverText(result)),
          { hasResult: true })
    } catch (error) {
      return textResult(`LSP hover request failed: ${errorMessage(error)}`,
        { hasResult: false })
    }
  }
  if (useTreeSitter(runtime, filePath)) {
    const fallback = await treeSitterHover(runtime, filePath, position)
    if (fallback !== undefined) {
      return fallback
    }
  }
  return textResult(manager.unavailableReason(filePath), { hasResult: false })
}

/**
 * Creates `lsp_hover`.
 *
 * @param runtime - The LSP runtime.
 */
function createHoverTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, HoverDetails> {
  return defineTool({
    name: 'lsp_hover',
    label: 'LSP Hover',
    description: 'Get type information and documentation for a symbol at a specific position in a file. Line and character are 1-indexed.',
    promptSnippet: 'Get type info and docs for a symbol at a file position via LSP',
    parameters,
    async execute (_id, params) {
      const position = await resolvePosition(runtime, params)
      if (typeof position === 'string') {
        return textResult(position, { hasResult: false })
      }
      return await hover(runtime, cleanPath(params.path), position)
    },
    renderCall (args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('lsp_hover ')) +
        positionLabel(args, theme), 0, 0)
    },
    renderResult (result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Looking up...'), 0, 0)
      }
      const [first] = result.content
      if (!result.details.hasResult || first?.type !== 'text') {
        return new Text(theme.fg('dim', 'No info'), 0, 0)
      }
      const lines = first.text.split('\n').slice(0, 5)
      return new Text(lines.map((l) => theme.fg('dim', l)).join('\n'), 0, 0)
    }
  })
}

export { createHoverTool, hoverText }
