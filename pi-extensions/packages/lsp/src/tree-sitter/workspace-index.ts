import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { MAX_FILE_BYTES, walkFiles } from './file-walk.ts'
import { extractSymbols, flattenSymbols } from './symbol-extractor.ts'

import type { TreeSitterManager } from './parser-manager.ts'
import type { SymbolKindValue } from './symbol-extractor.ts'

const BATCH_SIZE = 50
const MAX_RESULTS = 100

interface IndexEntry {
  readonly name: string
  readonly kind: SymbolKindValue
  /** Absolute path. */
  readonly file: string
  /** 1-indexed. */
  readonly line: number
}

/** A project-wide symbol index built with tree-sitter. */
class WorkspaceIndex {
  private readonly rootDir: string
  private readonly treeSitter: TreeSitterManager
  private readonly byFile = new Map<string, readonly IndexEntry[]>()
  private building: Promise<void> | undefined
  private built = false

  constructor (rootDir: string, treeSitter: TreeSitterManager) {
    this.rootDir = rootDir
    this.treeSitter = treeSitter
  }

  get isBuilt (): boolean {
    return this.built
  }

  /** Walks and indexes the project once; later calls wait for that. */
  async build (): Promise<void> {
    this.building ??= this.indexAll().then(() => {
      this.built = true
    })
    await this.building
  }

  private async indexAll (): Promise<void> {
    const files = await walkFiles(this.rootDir, {
      include: (name) => {
        const languageId = this.treeSitter.getLanguageId(name)
        return languageId !== undefined &&
          this.treeSitter.hasGrammar(languageId)
      }
    })
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      await Promise.all(files.slice(i, i + BATCH_SIZE)
        .map(async (file) => await this.indexFile(file)))
    }
  }

  /** Re-indexes one file, or drops it when it is gone or too large. */
  async indexFile (filePath: string): Promise<void> {
    const file = resolve(filePath)
    this.byFile.delete(file)
    const languageId = this.treeSitter.getLanguageId(file)
    if (languageId === undefined || !this.treeSitter.hasGrammar(languageId)) {
      return
    }
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) {
        return
      }
      const content = await readFile(file, 'utf8')
      // Not cached: indexing thousands of files must not pin their trees.
      const tree = await this.treeSitter.parseAs(undefined, content,
        languageId)
      if (tree === undefined) {
        return
      }
      try {
        const entries = flattenSymbols(extractSymbols(tree, languageId))
          .map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            file,
            line: symbol.line
          }))
        this.byFile.set(file, entries)
      } finally {
        tree.delete()
      }
    } catch {}
  }

  /**
   * Symbols whose name contains the query, exact matches first, then
   * shorter names.
   *
   * @param query - Case-insensitive text.
   * @returns Up to 100 entries.
   */
  search (query: string): IndexEntry[] {
    if (query === '') {
      return []
    }
    const lower = query.toLowerCase()
    const matches: IndexEntry[] = []
    for (const entries of this.byFile.values()) {
      matches.push(...entries
        .filter((e) => e.name.toLowerCase().includes(lower)))
    }
    const rank = (entry: IndexEntry): number =>
      entry.name.toLowerCase() === lower ? 0 : 1
    return matches
      .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length)
      .slice(0, MAX_RESULTS)
  }

  stats (): { files: number, symbols: number } {
    let symbols = 0
    for (const entries of this.byFile.values()) {
      symbols += entries.length
    }
    return { files: this.byFile.size, symbols }
  }
}

export { WorkspaceIndex }
export type { IndexEntry }
