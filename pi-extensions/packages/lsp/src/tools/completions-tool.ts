import { readFile } from 'node:fs/promises'

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

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  CompletionItem,
  CompletionList,
  MarkupContent
} from 'vscode-languageserver-protocol'

import type { LspClient } from '../lsp/lsp-client.ts'
import type { LspRuntime } from '../lsp-runtime.ts'

const parameters = Type.Object({
  ...positionFields,
  limit: Type.Optional(Type.Number({
    description: 'Max results to return (default: 20)'
  })),
  trigger: Type.Optional(Type.Union([Type.Literal('auto'),
    Type.Literal('none')], {
    description: 'Synthetic trigger mode (default: "auto"). When "auto", if the position is at the end of an identifier (no trailing dot), a dot is temporarily inserted to trigger member completions. Use "none" to skip this.'
  }))
})

interface CompletionDetails {
  readonly count: number
  readonly total: number
}

const NONE: CompletionDetails = { count: 0, total: 0 }
const DEFAULT_LIMIT = 20
const SETTLE_MS = 100
const RESOLVE_TIMEOUT_MS = 2_000
const DOC_LIMIT = 120

const KIND_LABELS: readonly string[] = [
  'unknown', 'text', 'method', 'function', 'constructor', 'field',
  'variable', 'class', 'interface', 'module', 'property', 'unit', 'value',
  'enum', 'keyword', 'snippet', 'color', 'file', 'reference', 'folder',
  'enum member', 'constant', 'struct', 'event', 'operator', 'type param'
]

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether a temporary `.` at a position would ask for member completions:
 * the character before is an identifier character or a closing bracket,
 * and the character at the position is not already a dot.
 *
 * @param content - The file text.
 * @param line - 0-indexed line.
 * @param character - 0-indexed column.
 */
function canInsertDot (
  content: string,
  line: number,
  character: number
): boolean {
  const text = content.split('\n')[line]
  if (text === undefined || character < 1 || character > text.length) {
    return false
  }
  return text[character] !== '.' && /[\w)\]]/.test(text[character - 1] ?? '')
}

/**
 * The content with a `.` inserted at a position.
 *
 * @param content - The file text.
 * @param line - 0-indexed line.
 * @param character - 0-indexed column.
 */
function insertDot (content: string, line: number, character: number): string {
  const lines = content.split('\n')
  const text = lines[line] ?? ''
  lines[line] = `${text.slice(0, character)}.${text.slice(character)}`
  return lines.join('\n')
}

/** The first two non-empty lines of documentation, code blocks removed. */
function docSummary (
  doc: string | MarkupContent | undefined
): string | undefined {
  const text = typeof doc === 'string' ? doc : doc?.value
  if (text === undefined || text === '') {
    return undefined
  }
  const summary = text.replace(/```[\s\S]*?```/g, '').split('\n')
    .map((l) => l.trim()).filter((l) => l !== '').slice(0, 2).join(' ')
  if (summary === '') {
    return undefined
  }
  return summary.length > DOC_LIMIT
    ? `${summary.slice(0, DOC_LIMIT - 3)}...`
    : summary
}

/** One item: kind, label, detail and a short doc line. */
function formatItem (item: CompletionItem): string {
  const kind = KIND_LABELS[item.kind ?? 0] ?? 'unknown'
  const labelDetail = item.labelDetails?.detail ?? ''
  const detail = item.detail === undefined ? '' : ` ${item.detail}`
  const description = item.labelDetails?.description === undefined
    ? ''
    : ` — ${item.labelDetails.description}`
  const line = `${kind.padEnd(12)} ${item.label}${labelDetail}${detail}` +
    description
  const doc = docSummary(item.documentation)
  return doc === undefined ? line : `${line}\n${' '.repeat(13)}${doc}`
}

/** Server ranking (sortText, else label), then the first `limit`. */
function topItems (
  items: readonly CompletionItem[],
  limit: number
): CompletionItem[] {
  const key = (item: CompletionItem): string => item.sortText ?? item.label
  return [...items].sort((a, b) => key(a).localeCompare(key(b)))
    .slice(0, limit)
}

async function resolveItems (
  client: LspClient,
  items: readonly CompletionItem[]
): Promise<CompletionItem[]> {
  const provider = client.serverCapabilities?.completionProvider
  if (provider?.resolveProvider !== true) {
    return [...items]
  }
  return await Promise.all(items.map(async (item) => {
    try {
      return await Promise.race([
        client.sendRequest<CompletionItem>('completionItem/resolve', item),
        sleep(RESOLVE_TIMEOUT_MS).then(() => item)
      ])
    } catch {
      return item
    }
  }))
}

type CompletionResponse = CompletionList | CompletionItem[] | null

async function requestCompletions (
  runtime: LspRuntime,
  client: LspClient,
  filePath: string,
  line: number,
  character: number,
  trigger: 'auto' | 'none'
): Promise<{ items: CompletionItem[], synthetic: boolean }> {
  const manager = runtime.manager
  const uri = manager.getFileUri(filePath)
  const request = async (char: number): Promise<CompletionItem[]> => {
    const response = await client.sendRequest<CompletionResponse>(
      'textDocument/completion',
      { textDocument: { uri }, position: { line, character: char } })
    return response === null
      ? []
      : Array.isArray(response) ? response : response.items
  }
  if (trigger === 'none') {
    await ensureDocumentOpen(runtime, client, filePath)
    return { items: await request(character), synthetic: false }
  }
  // The temporary dot and its revert happen under the document's lock, so
  // a real write cannot land in between.
  return await runtime.fileSync.withDocumentLock(uri, async () => {
    await runtime.fileSync.ensureOpen(client, filePath)
    const content = await readFile(manager.resolvePath(filePath), 'utf8')
    if (!canInsertDot(content, line, character)) {
      return { items: await request(character), synthetic: false }
    }
    runtime.fileSync.sendChange(client, uri, insertDot(content, line,
      character))
    try {
      await sleep(SETTLE_MS)
      return { items: await request(character + 1), synthetic: true }
    } finally {
      runtime.fileSync.sendChange(client, uri, content)
    }
  })
}

/**
 * Creates `lsp_completions`.
 *
 * @param runtime - The LSP runtime.
 */
function createCompletionsTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, CompletionDetails> {
  return defineTool({
    name: 'lsp_completions',
    label: 'LSP Completions',
    description: 'Get completion suggestions at a specific position in a file. Returns methods, properties, and other symbols available at that point. Useful for discovering APIs and verifying method names. Line and character are 1-indexed. When trigger is "auto" (default), a dot is temporarily inserted if the position is at the end of an identifier, enabling member completion without editing the file.',
    promptSnippet: 'Get code completion suggestions at a file position via LSP. Use to discover available methods, properties, and APIs on objects. Supports automatic dot insertion for exploring members on identifiers.',
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
      if (client.serverCapabilities?.completionProvider === undefined) {
        return textResult(
          'LSP server for this file does not support completions.', NONE)
      }
      try {
        const { items, synthetic } = await requestCompletions(runtime, client,
          filePath, position.line - 1, position.character - 1,
          params.trigger ?? 'auto')
        if (items.length === 0) {
          return textResult(withNote(position,
            'No completions available at this position.'), NONE)
        }
        const shown = await resolveItems(client,
          topItems(items, params.limit ?? DEFAULT_LIMIT))
        const note = synthetic ? ' (synthetic dot trigger)' : ''
        const header = `${shown.length} of ${items.length} completions at ` +
          `${filePath}:${position.line}:${position.character}${note}`
        return textResult(withNote(position,
          `${header}\n${shown.map(formatItem).join('\n')}`),
        { count: shown.length, total: items.length })
      } catch (error) {
        return textResult(
          `LSP completion request failed: ${errorMessage(error)}`, NONE)
      }
    },
    renderCall (args, theme) {
      const extras = [
        args.limit === undefined ? undefined : `limit: ${args.limit}`,
        args.trigger === 'none' ? 'trigger: none' : undefined
      ].filter((e) => e !== undefined)
      return new Text(theme.fg('toolTitle', theme.bold('lsp_completions ')) +
        positionLabel(args, theme) +
        (extras.length > 0 ? theme.fg('dim', ` (${extras.join(', ')})`) : ''),
      0, 0)
    },
    renderResult (result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Loading completions...'), 0, 0)
      }
      const { count, total } = result.details
      if (count === 0) {
        const [first] = result.content
        return new Text(theme.fg('dim',
          first?.type === 'text' ? first.text : 'No completions'), 0, 0)
      }
      return new Text(theme.fg('dim', `${count} of ${total} completions`), 0, 0)
    }
  })
}

export {
  canInsertDot,
  createCompletionsTool,
  docSummary,
  formatItem,
  insertDot,
  topItems
}
