import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { extractSymbols } from '../tree-sitter/symbol-extractor.ts'
import {
  cleanPath,
  displayPath,
  ensureDocumentOpen,
  errorMessage,
  parseFile,
  textResult,
  truncateOutput,
  useTreeSitter
} from './tool-support.ts'

import type {
  AgentToolResult,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type {
  DocumentSymbol,
  SymbolInformation,
  WorkspaceSymbol
} from 'vscode-languageserver-protocol'

import type { LspRuntime } from '../lsp-runtime.ts'
import type { SymbolInfo } from '../tree-sitter/symbol-extractor.ts'

const parameters = Type.Object({
  path: Type.Optional(Type.String({
    description: 'File path for document symbols'
  })),
  query: Type.Optional(Type.String({
    description: 'Search query for workspace symbols (searches across all files)'
  }))
})

interface SymbolsDetails {
  readonly count: number
}

type SymbolsResult = AgentToolResult<SymbolsDetails>

const KIND_NAMES: readonly string[] = [
  '', 'file', 'module', 'namespace', 'package', 'class', 'method',
  'property', 'field', 'constructor', 'enum', 'interface', 'function',
  'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object',
  'key', 'null', 'enum-member', 'struct', 'event', 'operator', 'type-param'
]

/** The readable name of an LSP SymbolKind. */
function kindName (kind: number): string {
  return KIND_NAMES[kind] ?? `kind(${kind})`
}

function documentSymbolLines (
  symbols: readonly DocumentSymbol[],
  depth = 0
): string[] {
  return symbols.flatMap((s) => [
    `${'  '.repeat(depth)}${kindName(s.kind)} ${s.name} ` +
      `(line ${s.range.start.line + 1})`,
    ...documentSymbolLines(s.children ?? [], depth + 1)
  ])
}

function treeSitterSymbolLines (
  symbols: readonly SymbolInfo[],
  depth = 0
): string[] {
  return symbols.flatMap((s) => [
    `${'  '.repeat(depth)}${kindName(s.kind)} ${s.name} (line ${s.line})`,
    ...treeSitterSymbolLines(s.children ?? [], depth + 1)
  ])
}

function flatSymbolLine (
  rootDir: string,
  symbol: SymbolInformation | WorkspaceSymbol
): string {
  const { location } = symbol
  const line = 'range' in location ? `:${location.range.start.line + 1}` : ''
  return `${kindName(symbol.kind)} ${symbol.name} ` +
    `${displayPath(rootDir, location.uri)}${line}`
}

function listing (lines: readonly string[], heading: string): SymbolsResult {
  return textResult(`${heading}:\n\n${truncateOutput(lines.join('\n'))}`,
    { count: lines.length })
}

async function documentSymbols (
  runtime: LspRuntime,
  filePath: string
): Promise<SymbolsResult> {
  const manager = runtime.manager
  const client = manager.getClientForFile(filePath)
  if (client !== undefined) {
    try {
      await ensureDocumentOpen(runtime, client, filePath)
      const result = await client.sendRequest<
      DocumentSymbol[] | SymbolInformation[] | null
      >('textDocument/documentSymbol',
        { textDocument: { uri: manager.getFileUri(filePath) } }) ?? []
      const [first] = result
      if (first === undefined) {
        return textResult('No symbols found in this file.', { count: 0 })
      }
      const lines = 'range' in first && 'selectionRange' in first
        ? documentSymbolLines(result as DocumentSymbol[])
        : (result as SymbolInformation[])
            .map((s) => flatSymbolLine(manager.rootDir, s))
      return listing(lines, `${lines.length} symbol(s)`)
    } catch (error) {
      return textResult('LSP document symbols request failed: ' +
        errorMessage(error), { count: 0 })
    }
  }
  if (useTreeSitter(runtime, filePath)) {
    const parsed = await parseFile(runtime, filePath)
    if (parsed !== undefined) {
      const lines = treeSitterSymbolLines(
        extractSymbols(parsed.tree, parsed.languageId))
      return lines.length === 0
        ? textResult('No symbols found in this file.', { count: 0 })
        : listing(lines, `${lines.length} symbol(s) [tree-sitter]`)
    }
  }
  return textResult(manager.unavailableReason(filePath), { count: 0 })
}

async function workspaceSymbols (
  runtime: LspRuntime,
  query: string
): Promise<SymbolsResult> {
  const manager = runtime.manager
  const running = manager.getStatus().find((s) => s.running)
  const client = running === undefined
    ? undefined
    : manager.getRunningClient(running.languageId)
  if (client !== undefined) {
    try {
      const result = await client.sendRequest<
      Array<SymbolInformation | WorkspaceSymbol> | null
      >('workspace/symbol', { query }) ?? []
      if (result.length === 0) {
        return textResult(`No workspace symbols found for query: "${query}"`,
          { count: 0 })
      }
      return listing(result.map((s) => flatSymbolLine(manager.rootDir, s)),
        `${result.length} symbol(s) found`)
    } catch (error) {
      return textResult('LSP workspace symbols request failed: ' +
        errorMessage(error), { count: 0 })
    }
  }
  if (query !== '') {
    await runtime.workspaceIndex.build()
    const entries = runtime.workspaceIndex.search(query)
    if (entries.length === 0) {
      return textResult(
        `No workspace symbols found for query: "${query}" [tree-sitter]`,
        { count: 0 })
    }
    return listing(entries.map((e) => `${kindName(e.kind)} ${e.name} ` +
      `${displayPath(manager.rootDir, e.file)}:${e.line}`),
    `${entries.length} symbol(s) found [tree-sitter]`)
  }
  return textResult('No LSP servers are currently running and no workspace ' +
    'index is available. Use lsp_diagnostics or lsp_hover on a file first ' +
    'to start a server.', { count: 0 })
}

/**
 * Creates `lsp_symbols`.
 *
 * @param runtime - The LSP runtime.
 */
function createSymbolsTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, SymbolsDetails> {
  return defineTool({
    name: 'lsp_symbols',
    label: 'LSP Symbols',
    description: "List symbols in a file (document symbols) or search for symbols across the workspace. Provide 'path' for file symbols or 'query' for workspace search.",
    promptSnippet: 'List symbols in a file or search workspace symbols via LSP',
    parameters,
    async execute (_id, params) {
      if (params.path !== undefined && params.path !== '') {
        return await documentSymbols(runtime, cleanPath(params.path))
      }
      if (params.query === undefined) {
        return textResult("Please provide either 'path' for file symbols or " +
          "'query' for workspace symbol search.", { count: 0 })
      }
      return await workspaceSymbols(runtime, params.query)
    },
    renderCall (args, theme) {
      let text = theme.fg('toolTitle', theme.bold('lsp_symbols '))
      if (args.path !== undefined) {
        text += theme.fg('accent', args.path)
      }
      if (args.query !== undefined) {
        text += theme.fg('accent', ` query="${args.query}"`)
      }
      return new Text(text, 0, 0)
    },
    renderResult (result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Loading symbols...'), 0, 0)
      }
      const { count } = result.details
      return count === 0
        ? new Text(theme.fg('dim', 'No symbols'), 0, 0)
        : new Text(theme.fg('success', `${count} symbol(s)`), 0, 0)
    }
  })
}

export { createSymbolsTool, kindName }
