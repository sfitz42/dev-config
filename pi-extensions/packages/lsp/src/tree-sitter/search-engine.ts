import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { walkFiles } from './file-walk.ts'
import { findMatches } from './structural-match.ts'

import type { TreeSitterManager } from './parser-manager.ts'
import type { CompiledPattern } from './pattern-compiler.ts'

interface SearchMatch {
  /** Absolute path. */
  readonly file: string
  /** 1-indexed. */
  readonly line: number
  /** 1-indexed, in UTF-16 code units. */
  readonly column: number
  readonly matchedText: string
  /** Offsets into the file's text (UTF-16 code units). */
  readonly start: number
  readonly end: number
  readonly captures: Readonly<Record<string, string>>
}

interface SearchOptions {
  /** File or directory, relative to the root. */
  readonly path?: string
  readonly maxResults?: number
}

const DEFAULT_MAX_RESULTS = 50

/**
 * Matches a pattern against one file's text.
 *
 * @param pattern - The compiled pattern.
 * @param file - Path used in the results.
 * @param content - The file's text.
 * @param treeSitter - The parser manager.
 * @returns Matches in source order.
 */
async function matchContent (
  pattern: CompiledPattern,
  file: string,
  content: string,
  treeSitter: TreeSitterManager
): Promise<SearchMatch[]> {
  const tree = await treeSitter.parseAs(undefined, content, pattern.languageId)
  if (tree === undefined) {
    return []
  }
  try {
    return findMatches(tree.rootNode, pattern.root, content).map((m) => ({
      file,
      line: m.node.startPosition.row + 1,
      column: m.node.startPosition.column + 1,
      matchedText: m.node.text,
      start: m.node.startIndex,
      end: m.node.endIndex,
      captures: m.captures
    }))
  } finally {
    tree.delete()
  }
}

/**
 * The files a search covers: the given file, or every file of the
 * pattern's language under the given directory.
 *
 * @param pattern - Decides the language.
 * @param rootDir - The project root.
 * @param treeSitter - Maps file names to languages.
 * @param path - File or directory relative to the root.
 * @returns Absolute file paths.
 */
async function searchTargets (
  pattern: CompiledPattern,
  rootDir: string,
  treeSitter: TreeSitterManager,
  path: string | undefined
): Promise<string[]> {
  const target = resolve(rootDir, path ?? '.')
  const stats = await stat(target)
  if (stats.isFile()) {
    return [target]
  }
  return await walkFiles(target, {
    include: (name) => treeSitter.getLanguageId(name) === pattern.languageId
  })
}

/**
 * Searches files for a structural pattern.
 *
 * @param pattern - The compiled pattern.
 * @param rootDir - The project root.
 * @param treeSitter - The parser manager.
 * @param options - Scope and result limit.
 * @returns Up to `maxResults` matches.
 * @throws When the scope path does not exist.
 */
async function searchFiles (
  pattern: CompiledPattern,
  rootDir: string,
  treeSitter: TreeSitterManager,
  options: SearchOptions = {}
): Promise<SearchMatch[]> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  const matches: SearchMatch[] = []
  for (const file of await searchTargets(pattern, rootDir, treeSitter,
    options.path)) {
    if (matches.length >= maxResults) {
      break
    }
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const found = await matchContent(pattern, file, content, treeSitter)
    matches.push(...found.slice(0, maxResults - matches.length))
  }
  return matches
}

export { matchContent, searchFiles, searchTargets }
export type { SearchMatch, SearchOptions }
