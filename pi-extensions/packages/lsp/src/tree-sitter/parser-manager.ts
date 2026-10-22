import { createRequire } from 'node:module'

import { Language, Parser } from 'web-tree-sitter'

import { languageIdForPath } from '../language-map.ts'

import type { Tree } from 'web-tree-sitter'

const require = createRequire(import.meta.url)

/**
 * Grammar wasm files from the official tree-sitter grammar packages.
 * Kotlin and Swift have none from an official source, so they get no
 * tree-sitter fallback.
 */
const GRAMMARS: Readonly<Record<string, string>> = {
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  typescriptreact: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  javascriptreact: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  rust: 'tree-sitter-rust/tree-sitter-rust.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  java: 'tree-sitter-java/tree-sitter-java.wasm',
  c: 'tree-sitter-c/tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp/tree-sitter-cpp.wasm',
  ruby: 'tree-sitter-ruby/tree-sitter-ruby.wasm',
  scala: 'tree-sitter-scala/tree-sitter-scala.wasm',
  lua: '@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm',
  bash: 'tree-sitter-bash/tree-sitter-bash.wasm',
  json: 'tree-sitter-json/tree-sitter-json.wasm',
  html: 'tree-sitter-html/tree-sitter-html.wasm',
  css: 'tree-sitter-css/tree-sitter-css.wasm'
}

interface CachedTree {
  readonly tree: Tree
  readonly content: string
  readonly languageId: string
}

/** Loads grammars on demand and caches one parsed tree per file. */
class TreeSitterManager {
  private ready: Promise<void> | undefined
  private readonly languages = new Map<string, Promise<Language | undefined>>()
  private readonly parsers = new Map<string, Parser>()
  private readonly trees = new Map<string, CachedTree>()

  /** Initialises the wasm runtime once. */
  async init (): Promise<void> {
    this.ready ??= Parser.init()
    await this.ready
  }

  getLanguageId (filePath: string): string | undefined {
    return languageIdForPath(filePath)
  }

  hasGrammar (languageId: string): boolean {
    return Object.hasOwn(GRAMMARS, languageId)
  }

  supportedLanguages (): string[] {
    return Object.keys(GRAMMARS)
  }

  private async loadLanguage (
    languageId: string
  ): Promise<Language | undefined> {
    const grammar = GRAMMARS[languageId]
    if (grammar === undefined) {
      return undefined
    }
    let loading = this.languages.get(languageId)
    if (loading === undefined) {
      loading = this.init()
        .then(async () => await Language.load(require.resolve(grammar)))
        .catch(() => undefined)
      this.languages.set(languageId, loading)
    }
    return await loading
  }

  private async parserFor (languageId: string): Promise<Parser | undefined> {
    const existing = this.parsers.get(languageId)
    if (existing !== undefined) {
      return existing
    }
    const language = await this.loadLanguage(languageId)
    if (language === undefined) {
      return undefined
    }
    const parser = new Parser()
    parser.setLanguage(language)
    this.parsers.set(languageId, parser)
    return parser
  }

  /**
   * Parses a file's content, reusing the cached tree when the content and
   * language are unchanged.
   *
   * @param filePath - Cache key; also picks the language.
   * @param content - The source text.
   * @returns The tree, or undefined when no grammar is available.
   */
  async parse (filePath: string, content: string): Promise<Tree | undefined> {
    const languageId = this.getLanguageId(filePath)
    return languageId === undefined
      ? undefined
      : await this.parseAs(filePath, content, languageId)
  }

  /**
   * Parses content with an explicit language.
   *
   * @param key - Cache key (a file path), or undefined to skip caching.
   * @param content - The source text.
   * @param languageId - The grammar to use.
   * @returns The tree, or undefined when no grammar is available.
   */
  async parseAs (
    key: string | undefined,
    content: string,
    languageId: string
  ): Promise<Tree | undefined> {
    const cached = key === undefined ? undefined : this.trees.get(key)
    if (cached !== undefined && cached.content === content &&
      cached.languageId === languageId) {
      return cached.tree
    }
    const parser = await this.parserFor(languageId)
    const tree = parser?.parse(content) ?? undefined
    if (tree === undefined || key === undefined) {
      return tree
    }
    cached?.tree.delete()
    this.trees.set(key, { tree, content, languageId })
    return tree
  }

  invalidate (filePath: string): void {
    this.trees.get(filePath)?.tree.delete()
    this.trees.delete(filePath)
  }

  /** Frees every tree and parser. */
  shutdown (): void {
    for (const cached of this.trees.values()) {
      cached.tree.delete()
    }
    this.trees.clear()
    for (const parser of this.parsers.values()) {
      parser.delete()
    }
    this.parsers.clear()
    this.languages.clear()
  }
}

export { GRAMMARS, TreeSitterManager }
