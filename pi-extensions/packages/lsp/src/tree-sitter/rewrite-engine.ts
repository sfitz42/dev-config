import { readFile, writeFile } from 'node:fs/promises'

import { withFileMutationQueue } from '@earendil-works/pi-coding-agent'

import { METAVAR_SOURCE } from './pattern-compiler.ts'
import { matchContent } from './search-engine.ts'

import type { TreeSitterManager } from './parser-manager.ts'
import type { CompiledPattern } from './pattern-compiler.ts'
import type { SearchMatch } from './search-engine.ts'

interface RewriteChange {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly before: string
  readonly after: string
}

interface RewriteResult {
  readonly changes: readonly RewriteChange[]
  readonly filesModified: number
}

/**
 * Names a replacement uses that the pattern does not capture.
 *
 * @param template - The replacement template.
 * @param captured - The pattern's metavariables.
 * @returns Unknown names, without the `$` prefix.
 */
function unknownMetavars (
  template: string,
  captured: readonly string[]
): string[] {
  const known = new Set(captured)
  const unknown: string[] = []
  for (const match of template.matchAll(METAVAR_SOURCE)) {
    const name = match[1] ?? match[2]
    if (name !== undefined && !known.has(name)) {
      unknown.push(name)
    }
  }
  return [...new Set(unknown)]
}

/**
 * Fills a replacement template with captured text. Unknown references
 * are left as written.
 *
 * @param template - Text with `$NAME` and `$$$NAME` references.
 * @param captures - Captured text by name.
 * @returns The replacement text.
 */
function substituteCaptures (
  template: string,
  captures: Readonly<Record<string, string>>
): string {
  return template.replace(METAVAR_SOURCE,
    (match: string, variadic?: string, single?: string) => {
      const name = variadic ?? single
      return name !== undefined && Object.hasOwn(captures, name)
        ? captures[name] ?? match
        : match
    })
}

/**
 * The replacement for one match. A statement terminator that is part of
 * the matched node but not of the replacement is kept.
 */
function replacementFor (match: SearchMatch, template: string): string {
  const replacement = substituteCaptures(template, match.captures)
  const terminator = /(\s*;)\s*$/.exec(match.matchedText)
  return terminator?.[1] !== undefined && !replacement.trimEnd().endsWith(';')
    ? replacement + terminator[1]
    : replacement
}

/**
 * The changes a rewrite would make, without touching files.
 *
 * @param matches - Search results.
 * @param template - The replacement template.
 * @returns One change per match.
 */
function previewRewrites (
  matches: readonly SearchMatch[],
  template: string
): RewriteChange[] {
  return matches.map((match) => ({
    file: match.file,
    line: match.line,
    column: match.column,
    before: match.matchedText,
    after: replacementFor(match, template)
  }))
}

/**
 * Applies a rewrite to files. Each file is re-read and re-matched inside
 * Pi's mutation queue for that file, so a concurrent edit or write cannot
 * shift the offsets between matching and writing.
 *
 * @param pattern - The compiled pattern.
 * @param template - The replacement template.
 * @param files - Absolute paths to rewrite.
 * @param treeSitter - The parser manager.
 * @returns The changes made and how many files were written.
 */
async function applyRewrites (
  pattern: CompiledPattern,
  template: string,
  files: readonly string[],
  treeSitter: TreeSitterManager
): Promise<RewriteResult> {
  const changes: RewriteChange[] = []
  let filesModified = 0
  for (const file of files) {
    await withFileMutationQueue(file, async () => {
      const content = await readFile(file, 'utf8')
      const matches = await matchContent(pattern, file, content, treeSitter)
      let updated = content
      // Bottom-up, so earlier offsets stay valid.
      for (const match of [...matches].sort((a, b) => b.start - a.start)) {
        const after = replacementFor(match, template)
        updated = updated.slice(0, match.start) + after +
          updated.slice(match.end)
      }
      changes.push(...previewRewrites(matches, template))
      if (updated !== content) {
        await writeFile(file, updated, 'utf8')
        filesModified += 1
      }
    })
  }
  return { changes, filesModified }
}

export {
  applyRewrites,
  previewRewrites,
  substituteCaptures,
  unknownMetavars
}
export type { RewriteChange, RewriteResult }
