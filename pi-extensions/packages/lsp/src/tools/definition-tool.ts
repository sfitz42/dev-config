import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import {
  findDefinitions,
  nodeAt
} from '../tree-sitter/symbol-extractor.ts'
import {
  cleanPath,
  displayPath,
  ensureDocumentOpen,
  errorMessage,
  formatLocation,
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
import type { Location, LocationLink } from 'vscode-languageserver-protocol'

import type { LspRuntime } from '../lsp-runtime.ts'
import type { ResolvedPosition } from './tool-support.ts'

const parameters = Type.Object(positionFields)

interface DefinitionDetails {
  readonly count: number
}

type DefinitionResult = AgentToolResult<DefinitionDetails>

const MAX_INDEX_DEFINITIONS = 10

function listLocations (locations: readonly string[], tag = ''): string {
  return locations.length === 1
    ? `Definition${tag}: ${locations[0] ?? ''}`
    : `Definitions${tag}:\n${locations.map((l) => `  ${l}`).join('\n')}`
}

async function treeSitterDefinition (
  runtime: LspRuntime,
  filePath: string,
  position: ResolvedPosition
): Promise<DefinitionResult | undefined> {
  const parsed = await parseFile(runtime, filePath)
  const node = parsed === undefined
    ? undefined
    : nodeAt(parsed.tree, position.line - 1, position.character - 1)
  if (parsed === undefined || node === undefined) {
    return undefined
  }
  const name = node.text
  const rootDir = runtime.manager.rootDir
  const path = displayPath(rootDir, runtime.manager.resolvePath(filePath))
  const local = findDefinitions(parsed.tree, name, parsed.languageId)
    .map((d) => `${path}:${d.line}:${d.column}`)
  if (local.length > 0) {
    return textResult(withNote(position, listLocations(local, ' [tree-sitter]')),
      { count: local.length })
  }
  await runtime.workspaceIndex.build()
  const indexed = runtime.workspaceIndex.search(name)
    .filter((entry) => entry.name === name)
    .slice(0, MAX_INDEX_DEFINITIONS)
    .map((entry) => `${displayPath(rootDir, entry.file)}:${entry.line}:1`)
  if (indexed.length > 0) {
    return textResult(withNote(position,
      listLocations(indexed, ' [tree-sitter]')), { count: indexed.length })
  }
  return textResult(withNote(position,
    `No definition found for "${name}" [tree-sitter]`), { count: 0 })
}

async function definition (
  runtime: LspRuntime,
  filePath: string,
  position: ResolvedPosition
): Promise<DefinitionResult> {
  const manager = runtime.manager
  const client = manager.getClientForFile(filePath)
  if (client !== undefined) {
    try {
      await ensureDocumentOpen(runtime, client, filePath)
      const result = await client.sendRequest<
      Location | Location[] | LocationLink[] | null
      >('textDocument/definition', {
        textDocument: { uri: manager.getFileUri(filePath) },
        position: { line: position.line - 1, character: position.character - 1 }
      })
      const list = result === null
        ? []
        : Array.isArray(result) ? result : [result]
      if (list.length === 0) {
        return textResult(withNote(position, 'No definition found.'),
          { count: 0 })
      }
      const locations = list.map((l) => formatLocation(manager.rootDir, l))
      return textResult(withNote(position, listLocations(locations)),
        { count: locations.length })
    } catch (error) {
      return textResult(
        `LSP definition request failed: ${errorMessage(error)}`, { count: 0 })
    }
  }
  if (useTreeSitter(runtime, filePath)) {
    const fallback = await treeSitterDefinition(runtime, filePath, position)
    if (fallback !== undefined) {
      return fallback
    }
  }
  return textResult(manager.unavailableReason(filePath), { count: 0 })
}

/**
 * Creates `lsp_definition`.
 *
 * @param runtime - The LSP runtime.
 */
function createDefinitionTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, DefinitionDetails> {
  return defineTool({
    name: 'lsp_definition',
    label: 'LSP Definition',
    description: 'Go to the definition of a symbol at a specific position. Returns the file path and location of the definition. Line and character are 1-indexed.',
    promptSnippet: 'Jump to the definition of a symbol at a file position via LSP',
    parameters,
    async execute (_id, params) {
      const position = await resolvePosition(runtime, params)
      if (typeof position === 'string') {
        return textResult(position, { count: 0 })
      }
      return await definition(runtime, cleanPath(params.path), position)
    },
    renderCall (args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('lsp_definition ')) +
        positionLabel(args, theme), 0, 0)
    },
    renderResult (result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Resolving...'), 0, 0)
      }
      const [first] = result.content
      return new Text(theme.fg('dim',
        first?.type === 'text' ? first.text : 'No result'), 0, 0)
    }
  })
}

export { createDefinitionTool }
