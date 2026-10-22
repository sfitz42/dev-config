import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { compilePattern } from '../tree-sitter/pattern-compiler.ts'
import { searchFiles } from '../tree-sitter/search-engine.ts'
import {
  displayPath,
  errorMessage,
  textResult,
  truncateOutput
} from './tool-support.ts'

import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent'

import type { LspRuntime } from '../lsp-runtime.ts'
import type { SearchMatch } from '../tree-sitter/search-engine.ts'

const parameters = Type.Object({
  pattern: Type.String({
    description: 'Structural pattern with metavariables ($NAME for single node, $$$NAME for variadic)'
  }),
  language: Type.String({
    description: 'Target language (typescript, python, rust, java, etc.)'
  }),
  path: Type.Optional(Type.String({
    description: 'File or directory to search (default: workspace root)'
  })),
  max_results: Type.Optional(Type.Number({
    description: 'Maximum results to return (default: 50)'
  }))
})

interface MatchSummary {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly text: string
  readonly captures: Readonly<Record<string, string>>
}

interface SearchDetails {
  readonly matchCount: number
  readonly fileCount: number
  readonly matches: readonly MatchSummary[]
}

const NONE: SearchDetails = { matchCount: 0, fileCount: 0, matches: [] }
const MATCH_TEXT_LIMIT = 200
const CAPTURE_LIMIT = 100
const COLLAPSED_MATCHES = 20
const PREVIEW_TEXT_LIMIT = 60

function clip (text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function describeMatches (
  rootDir: string,
  matches: readonly SearchMatch[]
): string {
  const lines = [`Found ${matches.length} ` +
    `match${matches.length === 1 ? '' : 'es'}:\n`]
  for (const m of matches) {
    const text = clip(m.matchedText, MATCH_TEXT_LIMIT)
    lines.push(`${displayPath(rootDir, m.file)}:${m.line}:${m.column}`)
    lines.push(`  ${text.replace(/\n/g, '\n  ')}`)
    for (const [name, value] of Object.entries(m.captures)) {
      lines.push(`  $${name} = ${clip(value, CAPTURE_LIMIT)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Matches grouped by file: `line:col  text  $NAME = value`.
 *
 * @param matches - Matches to show.
 * @param theme - The active theme.
 */
function groupedMatchLines (
  matches: readonly MatchSummary[],
  theme: Theme
): string[] {
  const lines: string[] = []
  let file: string | undefined
  for (const m of matches) {
    if (m.file !== file) {
      file = m.file
      lines.push('', theme.fg('accent', `${m.file}:`))
    }
    const captures = Object.entries(m.captures)
      .map(([name, value]) => `$${name} = ${clip(value, PREVIEW_TEXT_LIMIT)}`)
      .join(', ')
    const text = clip(m.text.replace(/\s+/g, ' '), PREVIEW_TEXT_LIMIT)
    lines.push(`  ${theme.fg('dim', `${m.line}:${m.column}`)}  ${text}` +
      (captures === '' ? '' : `  ${theme.fg('muted', captures)}`))
  }
  return lines
}

/**
 * Creates `ast_search`.
 *
 * @param runtime - The LSP runtime.
 */
function createAstSearchTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, SearchDetails> {
  return defineTool({
    name: 'ast_search',
    label: 'Code Search',
    description: 'Find code matching a structural pattern using AST matching. Use $NAME to match any single node, $$$NAME to match zero-or-more nodes. More precise than grep — matches code structure, not text.',
    parameters,
    async execute (_id, params) {
      const rootDir = runtime.rootDir
      let matches: SearchMatch[]
      try {
        const pattern = await compilePattern(params.pattern, params.language,
          runtime.treeSitter)
        matches = await searchFiles(pattern, rootDir, runtime.treeSitter, {
          ...(params.path === undefined ? {} : { path: params.path }),
          maxResults: params.max_results ?? 50
        })
      } catch (error) {
        return textResult(`Error: ${errorMessage(error)}`, NONE)
      }
      if (matches.length === 0) {
        return textResult('No matches found.', NONE)
      }
      return textResult(truncateOutput(describeMatches(rootDir, matches)), {
        matchCount: matches.length,
        fileCount: new Set(matches.map((m) => m.file)).size,
        matches: matches.map((m) => ({
          file: displayPath(rootDir, m.file),
          line: m.line,
          column: m.column,
          text: m.matchedText,
          captures: m.captures
        }))
      })
    },
    renderCall (args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('ast_search ')) +
        theme.fg('accent', args.pattern) + theme.fg('dim', ` ${args.language}`) +
        (args.path === undefined ? '' : theme.fg('dim', ` ${args.path}`)), 0, 0)
    },
    renderResult (result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Searching...'), 0, 0)
      }
      const { matchCount, fileCount, matches } = result.details
      if (matchCount === 0) {
        const [first] = result.content
        return new Text(theme.fg('dim',
          first?.type === 'text' ? first.text : 'No matches'), 0, 0)
      }
      const shown = expanded ? matches : matches.slice(0, COLLAPSED_MATCHES)
      return new Text([
        theme.fg('success', `${matchCount} matches in ${fileCount} files`),
        ...groupedMatchLines(shown, theme)
      ].join('\n'), 0, 0)
    }
  })
}

export { createAstSearchTool }
export type { MatchSummary }
