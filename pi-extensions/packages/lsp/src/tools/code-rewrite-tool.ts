import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { compilePattern } from '../tree-sitter/pattern-compiler.ts'
import {
  applyRewrites,
  previewRewrites,
  unknownMetavars
} from '../tree-sitter/rewrite-engine.ts'
import { searchFiles } from '../tree-sitter/search-engine.ts'
import {
  displayPath,
  errorMessage,
  textResult,
  truncateOutput
} from './tool-support.ts'

import type { Theme, ToolDefinition } from '@earendil-works/pi-coding-agent'

import type { LspRuntime } from '../lsp-runtime.ts'
import type { RewriteChange } from '../tree-sitter/rewrite-engine.ts'

const parameters = Type.Object({
  pattern: Type.String({
    description: 'Structural pattern to match (with $NAME / $$$NAME metavariables)'
  }),
  replacement: Type.String({
    description: 'Replacement template using the same metavariables'
  }),
  language: Type.String({
    description: 'Target language (typescript, python, rust, java, etc.)'
  }),
  path: Type.Optional(Type.String({
    description: 'File or directory scope (default: workspace root)'
  })),
  dry_run: Type.Optional(Type.Boolean({
    description: 'Preview changes without applying (default: true)'
  }))
})

interface ReplacementSummary {
  readonly file: string
  readonly line: number
  readonly before: string
  readonly after: string
}

interface RewriteDetails {
  readonly matchCount: number
  readonly filesModified: number
  readonly dryRun: boolean
  readonly replacements: readonly ReplacementSummary[]
}

const MAX_MATCHES = 500
const SHORT_LIMIT = 80
const COLLAPSED_REPLACEMENTS = 10

function noChanges (dryRun: boolean): RewriteDetails {
  return { matchCount: 0, filesModified: 0, dryRun, replacements: [] }
}

function clip (text: string): string {
  return text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}...` : text
}

/**
 * Whether a file is inside the root once symlinks are resolved.
 *
 * @param rootDir - The project root.
 * @param path - An absolute file path.
 */
function isInside (rootDir: string, path: string): boolean {
  let rel: string
  try {
    rel = relative(realpathSync(rootDir), realpathSync(path))
  } catch {
    return false
  }
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
}

function previewText (
  rootDir: string,
  changes: readonly RewriteChange[]
): string {
  const lines = [`Dry run: ${changes.length} change` +
    `${changes.length === 1 ? '' : 's'} would be made:\n`]
  for (const c of changes) {
    lines.push(`${displayPath(rootDir, c.file)}:${c.line}:${c.column}`)
    lines.push(...c.before.split('\n').map((l) => `  - ${l}`))
    lines.push(...c.after.split('\n').map((l) => `  + ${l}`))
    lines.push('')
  }
  lines.push('Run with dry_run=false to apply these changes.')
  return lines.join('\n')
}

function appliedText (
  rootDir: string,
  changes: readonly RewriteChange[],
  filesModified: number
): string {
  return [`Applied ${changes.length} change` +
    `${changes.length === 1 ? '' : 's'} across ${filesModified} ` +
    `file${filesModified === 1 ? '' : 's'}:\n`,
  ...changes.map((c) => `${displayPath(rootDir, c.file)}:${c.line} — ` +
    `${clip(c.before)} → ${clip(c.after)}`)].join('\n')
}

function diffLines (
  replacements: readonly ReplacementSummary[],
  theme: Theme
): string[] {
  const lines: string[] = []
  let file: string | undefined
  for (const r of replacements) {
    if (r.file !== file) {
      file = r.file
      lines.push('', theme.fg('accent', `${r.file}:`))
    }
    lines.push(`  ${r.line}:  ${theme.fg('error', `- ${clip(r.before)}`)}`)
    lines.push(`  ${' '.repeat(String(r.line).length + 1)}  ` +
      theme.fg('success', `+ ${clip(r.after)}`))
  }
  return lines
}

/**
 * Creates `code_rewrite`: a structural find-and-replace, dry run by
 * default. Applying only touches files inside the project root.
 *
 * @param runtime - The LSP runtime.
 */
function createCodeRewriteTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, RewriteDetails> {
  return defineTool({
    name: 'code_rewrite',
    label: 'Code Rewrite',
    description: 'Transform code matching a structural pattern into a replacement. Use $NAME to capture and reuse single nodes, $$$NAME for sequences. Defaults to dry-run mode (preview only). Set dry_run=false to apply changes. For symbol renames, prefer lsp_rename instead (semantically correct).',
    parameters,
    // Writes files: never interleave with another call.
    executionMode: 'sequential',
    async execute (_id, params) {
      const dryRun = params.dry_run !== false
      const rootDir = runtime.rootDir
      const treeSitter = runtime.treeSitter
      try {
        const pattern = await compilePattern(params.pattern, params.language,
          treeSitter)
        const unknown = unknownMetavars(params.replacement, pattern.metavars)
        if (unknown.length > 0) {
          return textResult('Error: Replacement references ' +
            `${unknown.map((n) => `$${n}`).join(', ')} but the pattern ` +
            "doesn't capture it. Pattern captures: " +
            `${pattern.metavars.join(', ') || '(none)'}`, noChanges(dryRun))
        }
        const matches = await searchFiles(pattern, rootDir, treeSitter, {
          ...(params.path === undefined ? {} : { path: params.path }),
          maxResults: MAX_MATCHES
        })
        if (matches.length === 0) {
          return textResult('No matches found. No changes to make.',
            noChanges(dryRun))
        }
        const files = [...new Set(matches.map((m) => m.file))]
        if (dryRun) {
          const changes = previewRewrites(matches, params.replacement)
          return textResult(truncateOutput(previewText(rootDir, changes)), {
            matchCount: matches.length,
            filesModified: files.length,
            dryRun: true,
            replacements: summarize(rootDir, changes)
          })
        }
        const outside = files.filter((f) => !isInside(rootDir, f))
        if (outside.length > 0) {
          return textResult('Error: code_rewrite only applies changes inside ' +
            `the project root (${rootDir}). Outside it: ` +
            outside.join(', '), noChanges(false))
        }
        const result = await applyRewrites(pattern, params.replacement, files,
          treeSitter)
        for (const file of files) {
          runtime.fileSync.handleFileWrite(file).catch(() => {})
        }
        return textResult(truncateOutput(appliedText(rootDir, result.changes,
          result.filesModified)), {
          matchCount: result.changes.length,
          filesModified: result.filesModified,
          dryRun: false,
          replacements: summarize(rootDir, result.changes)
        })
      } catch (error) {
        return textResult(`Error: ${errorMessage(error)}`, noChanges(dryRun))
      }
    },
    renderCall (args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('code_rewrite ')) +
        theme.fg('accent', args.pattern) + ' → ' +
        theme.fg('accent', args.replacement) +
        theme.fg('dim', ` ${args.language} `) +
        theme.fg('dim', args.dry_run === false ? '[apply]' : '[dry-run]'), 0, 0)
    },
    renderResult (result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Rewriting...'), 0, 0)
      }
      const { matchCount, filesModified, dryRun, replacements } =
        result.details
      if (matchCount === 0) {
        const [first] = result.content
        return new Text(theme.fg('dim',
          first?.type === 'text' ? first.text : 'No changes'), 0, 0)
      }
      const summary = dryRun
        ? theme.fg('muted', `${matchCount} replacements in ${filesModified} ` +
          'files (dry-run)')
        : theme.fg('success', `✓ ${matchCount} replacements applied in ` +
          `${filesModified} files`)
      const shown = expanded
        ? replacements
        : replacements.slice(0, COLLAPSED_REPLACEMENTS)
      return new Text([summary, ...diffLines(shown, theme)].join('\n'), 0, 0)
    }
  })
}

function summarize (
  rootDir: string,
  changes: readonly RewriteChange[]
): ReplacementSummary[] {
  return changes.map((c) => ({
    file: displayPath(rootDir, c.file),
    line: c.line,
    before: c.before,
    after: c.after
  }))
}

export { createCodeRewriteTool, isInside }
