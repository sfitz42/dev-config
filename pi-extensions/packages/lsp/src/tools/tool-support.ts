import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { matchSymbol } from '../symbol-match.ts'
import {
  extractSymbols,
  flattenSymbols
} from '../tree-sitter/symbol-extractor.ts'

import type { AgentToolResult, Theme } from '@earendil-works/pi-coding-agent'
import type {
  DocumentSymbol,
  Location,
  LocationLink,
  SymbolInformation
} from 'vscode-languageserver-protocol'
import type { Tree } from 'web-tree-sitter'

import type { LspClient } from '../lsp/lsp-client.ts'
import type { LspRuntime } from '../lsp-runtime.ts'
import type { SymbolCandidate } from '../symbol-match.ts'

/** Position parameters shared by the position-based tools. */
const positionFields = {
  path: Type.String({ description: 'File path' }),
  line: Type.Optional(Type.Number({
    description: 'Line number (1-indexed). Required unless query is provided.'
  })),
  character: Type.Optional(Type.Number({
    description: 'Column number (1-indexed). Required unless query is provided.'
  })),
  query: Type.Optional(Type.String({
    description: "Symbol name to find in the file. Alternative to line/character — resolves the symbol's position automatically."
  }))
}

interface PositionInput {
  readonly path: string
  readonly line?: number | undefined
  readonly character?: number | undefined
  readonly query?: string | undefined
}

/** A resolved 1-indexed position, with a note when it came from a query. */
interface ResolvedPosition {
  readonly line: number
  readonly character: number
  readonly note?: string
}

/**
 * Builds a tool result with one text block.
 *
 * @param text - Model-facing text.
 * @param details - Structured details for rendering.
 */
function textResult<T> (text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text', text }], details }
}

/**
 * Truncates long output to Pi's limits, saying how much was kept.
 *
 * @param text - The output.
 * @param unit - What a line is ("diagnostics", "lines", ...).
 */
function truncateOutput (text: string, unit = 'lines'): string {
  const result = truncateHead(text,
    { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
  return result.truncated
    ? `${result.content}\n\n[Output truncated: showing ${result.outputLines} ` +
      `of ${result.totalLines} ${unit}]`
    : result.content
}

/** Strips the `@` the model sometimes copies from file mentions. */
function cleanPath (path: string): string {
  return path.replace(/^@/, '')
}

/**
 * A URI or path relative to the project root, for output.
 *
 * @param rootDir - The project root.
 * @param uriOrPath - A `file:` URI or an absolute path.
 */
function displayPath (rootDir: string, uriOrPath: string): string {
  try {
    const absolute = uriOrPath.startsWith('file:')
      ? fileURLToPath(uriOrPath)
      : uriOrPath
    return relative(rootDir, absolute) || '.'
  } catch {
    return uriOrPath
  }
}

/**
 * `path:line:column` (1-indexed) for a Location or LocationLink.
 *
 * @param rootDir - The project root.
 * @param location - The LSP location.
 */
function formatLocation (
  rootDir: string,
  location: Location | LocationLink
): string {
  const [uri, range] = 'targetUri' in location
    ? [location.targetUri, location.targetSelectionRange]
    : [location.uri, location.range]
  return `${displayPath(rootDir, uri)}:${range.start.line + 1}:` +
    `${range.start.character + 1}`
}

/** Prefixes text with the "Resolved ..." note, when there is one. */
function withNote (
  position: ResolvedPosition | undefined,
  text: string
): string {
  return position?.note === undefined ? text : `${position.note}\n\n${text}`
}

function isHierarchical (
  symbols: readonly DocumentSymbol[] | readonly SymbolInformation[]
): symbols is readonly DocumentSymbol[] {
  const [first] = symbols
  return first !== undefined && 'selectionRange' in first
}

function lspCandidates (
  symbols: readonly DocumentSymbol[] | readonly SymbolInformation[]
): SymbolCandidate[] {
  if (isHierarchical(symbols)) {
    const flatten = (list: readonly DocumentSymbol[],
      parent?: string): SymbolCandidate[] =>
      list.flatMap((s) => [{
        name: s.name,
        line: s.selectionRange.start.line + 1,
        character: s.selectionRange.start.character + 1,
        ...(parent === undefined ? {} : { parent })
      }, ...flatten(s.children ?? [], s.name)])
    return flatten(symbols)
  }
  return (symbols as readonly SymbolInformation[]).map((s) => ({
    name: s.name,
    line: s.location.range.start.line + 1,
    character: s.location.range.start.character + 1,
    ...(s.containerName === undefined ? {} : { parent: s.containerName })
  }))
}

/**
 * Parses a file with tree-sitter, reading it from disk.
 *
 * @returns The tree and language, or undefined without a grammar.
 */
async function parseFile (
  runtime: LspRuntime,
  filePath: string
): Promise<{ tree: Tree, languageId: string } | undefined> {
  const languageId = runtime.treeSitter.getLanguageId(filePath)
  if (languageId === undefined || !runtime.treeSitter.hasGrammar(languageId)) {
    return undefined
  }
  const absolute = runtime.manager.resolvePath(filePath)
  try {
    const content = await readFile(absolute, 'utf8')
    const tree = await runtime.treeSitter.parse(absolute, content)
    return tree === undefined ? undefined : { tree, languageId }
  } catch {
    return undefined
  }
}

/** Symbols for query resolution: from the server, else tree-sitter. */
async function symbolCandidates (
  runtime: LspRuntime,
  filePath: string
): Promise<{ candidates: SymbolCandidate[], source: string }> {
  const client = runtime.manager.getClientForFile(filePath)
  if (client !== undefined) {
    try {
      const symbols = await client.sendRequest<
      DocumentSymbol[] | SymbolInformation[] | null
      >('textDocument/documentSymbol',
        { textDocument: { uri: runtime.manager.getFileUri(filePath) } })
      if (symbols !== null && symbols.length > 0) {
        return { candidates: lspCandidates(symbols), source: 'lsp' }
      }
    } catch {}
  }
  const parsed = await parseFile(runtime, filePath)
  if (parsed === undefined) {
    return { candidates: [], source: 'none' }
  }
  const candidates = flattenSymbols(extractSymbols(parsed.tree,
    parsed.languageId)).map((s) => ({
    name: s.name,
    line: s.line,
    character: s.column,
    ...(s.parent === undefined ? {} : { parent: s.parent })
  }))
  return { candidates, source: 'tree-sitter' }
}

/**
 * Resolves the position a tool should act on: the given line and
 * character, or the location of the symbol named by `query`.
 *
 * @param runtime - The LSP runtime.
 * @param input - The tool parameters.
 * @returns The position, or an error message for the model.
 */
async function resolvePosition (
  runtime: LspRuntime,
  input: PositionInput
): Promise<ResolvedPosition | string> {
  const filePath = cleanPath(input.path)
  if (input.line !== undefined && input.character !== undefined) {
    return { line: input.line, character: input.character }
  }
  if (input.query === undefined) {
    return 'Either line/character or query is required.'
  }
  const { candidates, source } = await symbolCandidates(runtime, filePath)
  const match = matchSymbol(candidates, input.query)
  if (match === undefined) {
    const names = [...new Set(candidates.map((c) => c.name))].slice(0, 20)
    const hint = names.length > 0
      ? `\nAvailable symbols: ${names.join(', ')}`
      : ''
    return `Could not find symbol "${input.query}" in ${filePath}${hint}`
  }
  return {
    line: match.line,
    character: match.character,
    note: `Resolved "${input.query}" → ${match.name} at ` +
      `${match.line}:${match.character} [${source}]`
  }
}

/**
 * Sends a file to its server if it has not seen it yet: servers only
 * answer about, and report diagnostics for, open documents.
 *
 * @param runtime - The LSP runtime.
 * @param client - The file's server.
 * @param filePath - The file.
 * @returns True when the file was opened just now.
 */
async function ensureDocumentOpen (
  runtime: LspRuntime,
  client: LspClient,
  filePath: string
): Promise<boolean> {
  const uri = runtime.manager.getFileUri(filePath)
  if (runtime.fileSync.getTrackedVersion(uri) !== undefined) {
    return false
  }
  await runtime.fileSync.withDocumentLock(uri, async () =>
    await runtime.fileSync.ensureOpen(client, filePath))
  return true
}

/** Whether the tree-sitter fallback applies to a file right now. */
function useTreeSitter (runtime: LspRuntime, filePath: string): boolean {
  const languageId = runtime.manager.getLanguageId(filePath)
  return languageId !== undefined &&
    runtime.manager.getRunningClient(languageId) === undefined &&
    runtime.treeSitter.hasGrammar(languageId)
}

/**
 * How a position-based call is shown: `path:line:col` or the query.
 *
 * @param args - The call's position parameters.
 * @param theme - The active theme.
 */
function positionLabel (args: PositionInput, theme: Theme): string {
  if (args.query !== undefined && args.line === undefined) {
    return theme.fg('accent', args.path) +
      theme.fg('muted', ` query="${args.query}"`)
  }
  return theme.fg('accent',
    `${args.path}:${args.line ?? '?'}:${args.character ?? '?'}`)
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export {
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
  truncateOutput,
  useTreeSitter,
  withNote
}
export type { PositionInput, ResolvedPosition }
