import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { SKIP_DIRS } from '../tree-sitter/file-walk.ts'
import { extractSymbols } from '../tree-sitter/symbol-extractor.ts'
import { kindName } from './symbols-tool.ts'
import { textResult, truncateOutput } from './tool-support.ts'

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

import type { LspRuntime } from '../lsp-runtime.ts'

const parameters = Type.Object({
  path: Type.Optional(Type.String({
    description: 'Root directory to analyze (defaults to project root)'
  })),
  depth: Type.Optional(Type.Number({
    description: 'Maximum directory depth (default: 3)'
  }))
})

interface OverviewDetails {
  readonly files: number
  readonly symbols: number
}

const MANIFESTS = [
  'package.json', 'Cargo.toml', 'go.mod', 'go.sum', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'requirements.txt', 'pyproject.toml',
  'setup.py', 'setup.cfg', 'Gemfile', 'Makefile', 'CMakeLists.txt'
]

const ENTRY_POINTS = [
  'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
  'main.py', 'app.py', '__init__.py', 'main.rs', 'lib.rs', 'main.go',
  'Main.java', 'Application.java'
]

const ENTRY_DIRS = ['.', 'src', 'lib', 'app']
const DEFAULT_DEPTH = 3
const MAX_TREE_ENTRIES = 200
const MAX_KEY_FILES = 10
const SYMBOLS_PER_FILE = 20

/**
 * An indented directory tree: directories first, hidden entries left out
 * (except `.github`), dependency and build directories marked skipped.
 *
 * @param dir - The directory to list.
 * @param maxDepth - How deep to descend.
 * @returns Tree lines; directories end with `/`.
 */
async function directoryTree (
  dir: string,
  maxDepth: number
): Promise<string[]> {
  const lines: string[] = []
  const visit = async (current: string, prefix: string,
    depth: number): Promise<void> => {
    if (depth > maxDepth) {
      return
    }
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    const visible = entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.github')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name))
    for (const [i, entry] of visible.entries()) {
      if (lines.length > MAX_TREE_ENTRIES) {
        lines.push(`${prefix}... (truncated)`)
        return
      }
      const last = i === visible.length - 1
      const branch = prefix + (last ? '└── ' : '├── ')
      if (!entry.isDirectory()) {
        lines.push(branch + entry.name)
      } else if (SKIP_DIRS.has(entry.name)) {
        lines.push(`${branch}${entry.name}/ (skipped)`)
      } else {
        lines.push(`${branch}${entry.name}/`)
        await visit(join(current, entry.name),
          prefix + (last ? '    ' : '│   '), depth + 1)
      }
    }
  }
  await visit(dir, '', 0)
  return lines
}

async function keyFileSections (
  runtime: LspRuntime,
  dir: string
): Promise<{ sections: string[], symbols: number }> {
  const files = [...new Set(ENTRY_DIRS.flatMap((d) =>
    ENTRY_POINTS.map((name) => resolve(dir, d, name))))]
    .filter((file) => existsSync(file))
    .slice(0, MAX_KEY_FILES)
  const sections: string[] = []
  let symbols = 0
  for (const file of files) {
    const languageId = runtime.treeSitter.getLanguageId(file)
    if (languageId === undefined) {
      continue
    }
    try {
      const tree = await runtime.treeSitter.parse(file,
        await readFile(file, 'utf8'))
      const found = tree === undefined ? [] : extractSymbols(tree, languageId)
      if (found.length === 0) {
        continue
      }
      symbols += found.length
      const lines = found.slice(0, SYMBOLS_PER_FILE)
        .map((s) => `  ${kindName(s.kind)} ${s.name} (line ${s.line})`)
      if (found.length > SYMBOLS_PER_FILE) {
        lines.push(`  ... and ${found.length - SYMBOLS_PER_FILE} more`)
      }
      sections.push(`### ${relative(dir, file)}\n${lines.join('\n')}`)
    } catch {}
  }
  return { sections, symbols }
}

/**
 * Creates `code_overview` (tree-sitter only; no server needed).
 *
 * @param runtime - The LSP runtime.
 */
function createCodeOverviewTool (
  runtime: LspRuntime
): ToolDefinition<typeof parameters, OverviewDetails> {
  return defineTool({
    name: 'code_overview',
    label: 'Code Overview',
    description: 'Summarize project structure: directory tree, top-level symbols per key file, dependency manifests. Uses tree-sitter for symbol extraction — no LSP required.',
    promptSnippet: 'Get a structural overview of the project (directories, key files, symbols)',
    parameters,
    async execute (_id, params) {
      const dir = resolve(runtime.rootDir, params.path ?? '.')
      const tree = await directoryTree(dir, params.depth ?? DEFAULT_DEPTH)
      const sections = ['## Directory Structure\n\n```\n' + tree.join('\n') +
        '\n```']
      const manifests = MANIFESTS.filter((m) => existsSync(join(dir, m)))
      if (manifests.length > 0) {
        sections.push('## Dependency Manifests\n\n' +
          manifests.map((m) => `- ${m}`).join('\n'))
      }
      const keyFiles = await keyFileSections(runtime, dir)
      if (keyFiles.sections.length > 0) {
        sections.push(`## Key Files\n\n${keyFiles.sections.join('\n\n')}`)
      }
      if (runtime.workspaceIndex.isBuilt) {
        const stats = runtime.workspaceIndex.stats()
        sections.push(`## Index Stats\n\n- ${stats.files} indexed files\n` +
          `- ${stats.symbols} symbols`)
      }
      return textResult(truncateOutput(sections.join('\n\n')), {
        files: tree.filter((line) => !line.endsWith('/') &&
          !line.endsWith('(skipped)') && !line.endsWith('(truncated)')).length,
        symbols: keyFiles.symbols
      })
    },
    renderCall (args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('code_overview ')) +
        (args.path === undefined
          ? theme.fg('dim', '(project root)')
          : theme.fg('accent', args.path)), 0, 0)
    },
    renderResult (result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg('warning', 'Analyzing...'), 0, 0)
      }
      const { files, symbols } = result.details
      return new Text(theme.fg('success', `${files} files, ${symbols} symbols`),
        0, 0)
    }
  })
}

export { createCodeOverviewTool, directoryTree }
