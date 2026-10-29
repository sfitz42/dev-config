import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'

import { isInside } from '../src/tools/code-rewrite-tool.ts'
import { TreeSitterManager } from '../src/tree-sitter/parser-manager.ts'
import { compilePattern } from '../src/tree-sitter/pattern-compiler.ts'
import {
  applyRewrites,
  previewRewrites,
  substituteCaptures,
  unknownMetavars
} from '../src/tree-sitter/rewrite-engine.ts'
import { searchFiles } from '../src/tree-sitter/search-engine.ts'
import {
  enclosingDeclaration,
  extractSymbols,
  findDefinitions,
  signatureText,
  SymbolKind,
  syntaxErrors
} from '../src/tree-sitter/symbol-extractor.ts'
import { WorkspaceIndex } from '../src/tree-sitter/workspace-index.ts'

const treeSitter = new TreeSitterManager()
afterAll(() => treeSitter.shutdown())

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-lsp-ts-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write (name: string, content: string): string {
  const path = join(dir, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

async function parse (name: string, content: string) {
  const tree = await treeSitter.parse(join(dir, name), content)
  if (tree === undefined) {
    throw new Error(`no tree for ${name}`)
  }
  return tree
}

describe('grammars', () => {
  test.each(treeSitter.supportedLanguages())('%s loads', async (id) => {
    expect(await treeSitter.parseAs(undefined, '', id)).toBeDefined()
  })
})

describe('symbols', () => {
  test('TypeScript declarations, exports and class members', async () => {
    const tree = await parse('a.ts', [
      'export function top () {}',
      'export class Widget {',
      '  size = 1',
      '  render () {}',
      '}',
      'const answer = 42',
      'interface Shape { area (): number }'
    ].join('\n'))
    const symbols = extractSymbols(tree, 'typescript')
    expect(symbols.map((s) => s.name))
      .toEqual(['top', 'Widget', 'answer', 'Shape'])
    const widget = symbols[1]
    expect(widget?.kind).toBe(SymbolKind.Class)
    expect(widget?.children?.map((s) => s.name)).toEqual(['size', 'render'])
    expect(widget?.column).toBe(14)
  })

  test('Python decorated definitions and Rust impls', async () => {
    const py = await parse('a.py', '@cached\ndef load():\n  pass\n')
    expect(extractSymbols(py, 'python')[0]?.name).toBe('load')
    const rs = await parse('a.rs', 'struct S;\nimpl S { fn go(&self) {} }\n')
    const symbols = extractSymbols(rs, 'rust')
    expect(symbols.map((s) => s.name)).toEqual(['S', 'impl S'])
    expect(symbols[0]?.kind).toBe(SymbolKind.Struct)
    expect(symbols[1]?.children?.[0]?.name).toBe('go')
  })

  test('definitions, enclosing declarations and signatures', async () => {
    const tree = await parse('b.ts',
      'function add (a: number, b: number): number {\n  return a + b\n}\n')
    expect(findDefinitions(tree, 'add', 'typescript')[0]?.line).toBe(1)
    const decl = enclosingDeclaration(tree, 1, 9)
    expect(decl === undefined ? '' : signatureText(decl))
      .toBe('function add (a: number, b: number): number')
  })

  test('syntax errors', async () => {
    const tree = await parse('c.ts', 'const x = (\n')
    expect(syntaxErrors(tree).length).toBeGreaterThan(0)
    expect(syntaxErrors(await parse('d.ts', 'const x = 1\n'))).toEqual([])
  })

  test('the tree cache notices edits in the middle of a file', async () => {
    const before = 'a'.repeat(5000) + 'X' + 'b'.repeat(5000)
    const after = 'a'.repeat(5000) + 'Y' + 'b'.repeat(5000)
    const first = await treeSitter.parse(join(dir, 'm.js'), `/*${before}*/`)
    const second = await treeSitter.parse(join(dir, 'm.js'), `/*${after}*/`)
    expect(second).not.toBe(first)
    expect(second?.rootNode.text).toContain('Y')
  })
})

describe('structural search', () => {
  test('metavariables capture single nodes', async () => {
    write('a.ts', 'console.log(user)\nconsole.log("done")\nfoo(1)\n')
    const pattern = await compilePattern('console.log($ARG)', 'typescript',
      treeSitter)
    const matches = await searchFiles(pattern, dir, treeSitter)
    expect(matches.map((m) => m.captures.ARG)).toEqual(['user', '"done"'])
    expect(matches[0]).toMatchObject({ line: 1, column: 1 })
  })

  test('variadics capture the arguments without parentheses', async () => {
    write('a.ts', 'log(a, b, c)\nlog()\n')
    const pattern = await compilePattern('log($$$ARGS)', 'typescript',
      treeSitter)
    const matches = await searchFiles(pattern, dir, treeSitter)
    expect(matches.map((m) => m.captures.ARGS)).toEqual(['a, b, c', ''])
  })

  test('repeated metavariables must match the same text', async () => {
    write('a.ts', 'x = x\nx = y\n')
    const pattern = await compilePattern('$A = $A', 'typescript', treeSitter)
    const matches = await searchFiles(pattern, dir, treeSitter)
    expect(matches.map((m) => m.matchedText)).toEqual(['x = x'])
  })

  test('operators are part of the pattern', async () => {
    write('a.ts', 'const p = a + b\nconst q = a - b\n')
    const pattern = await compilePattern('$X + $Y', 'typescript', treeSitter)
    const matches = await searchFiles(pattern, dir, treeSitter)
    expect(matches.map((m) => m.matchedText)).toEqual(['a + b'])
  })

  test('positional children must all match; extra ones do not', async () => {
    const file = write('a.ts', 'foo(a)\nfoo(a, b)\n')
    const pattern = await compilePattern('foo($A)', 'typescript', treeSitter)
    await applyRewrites(pattern, 'bar($A)', [file], treeSitter)
    expect(readFileSync(file, 'utf8')).toBe('bar(a)\nfoo(a, b)\n')
  })

  test('unmentioned fields such as return types are ignored', async () => {
    write('a.ts', 'function f (x: number): number { return x }\n')
    const pattern = await compilePattern(
      'function $NAME ($$$PARAMS) { $$$BODY }', 'typescript', treeSitter)
    const matches = await searchFiles(pattern, dir, treeSitter)
    expect(matches.map((m) => m.captures.NAME)).toEqual(['f'])
  })

  test('Python patterns', async () => {
    write('a.py', 'print(x)\nprint(y, z)\n')
    const pattern = await compilePattern('print($A)', 'python', treeSitter)
    const matches = await searchFiles(pattern, dir, treeSitter)
    expect(matches.map((m) => m.captures.A)).toEqual(['x'])
  })

  test('an unparseable pattern or language is an error', async () => {
    await expect(compilePattern('(((', 'typescript', treeSitter))
      .rejects.toThrow(/Failed to parse/)
    await expect(compilePattern('x', 'cobol', treeSitter))
      .rejects.toThrow(/No tree-sitter grammar/)
  })
})

describe('rewrite', () => {
  test('templates and unknown references', () => {
    expect(substituteCaptures('f($$$A, $B, $C)', { A: '1, 2', B: 'x' }))
      .toBe('f(1, 2, x, $C)')
    expect(unknownMetavars('$A $$$B $C', ['A'])).toEqual(['B', 'C'])
  })

  test('preview and apply, keeping non-ASCII text intact', async () => {
    const file = write('a.ts',
      'const s = "héllo 😀"\nvar count = 0\nvar name = "é"\n')
    const pattern = await compilePattern('var $N = $V', 'typescript',
      treeSitter)
    const matches = await searchFiles(pattern, dir, treeSitter)
    expect(previewRewrites(matches, 'let $N = $V').map((c) => c.after))
      .toEqual(['let count = 0', 'let name = "é"'])

    const result = await applyRewrites(pattern, 'let $N = $V', [file],
      treeSitter)
    expect(result.filesModified).toBe(1)
    expect(readFileSync(file, 'utf8'))
      .toBe('const s = "héllo 😀"\nlet count = 0\nlet name = "é"\n')
  })

  test('apply re-matches the current file content', async () => {
    const file = write('a.ts', 'old(1)\n')
    const pattern = await compilePattern('old($A)', 'typescript', treeSitter)
    writeFileSync(file, '// moved\n\nold(2)\n')
    await applyRewrites(pattern, 'renamed($A)', [file], treeSitter)
    expect(readFileSync(file, 'utf8')).toBe('// moved\n\nrenamed(2)\n')
  })

  test('only files inside the root may be rewritten', () => {
    const inside = write('in.ts', '')
    const outsideDir = mkdtempSync(join(tmpdir(), 'pi-lsp-out-'))
    try {
      const outside = join(outsideDir, 'x.ts')
      writeFileSync(outside, '')
      symlinkSync(outside, join(dir, 'link.ts'))
      expect(isInside(dir, inside)).toBe(true)
      expect(isInside(dir, outside)).toBe(false)
      expect(isInside(dir, join(dir, 'link.ts'))).toBe(false)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})

describe('workspace index', () => {
  test('indexes, searches and skips generated directories', async () => {
    write('src/a.ts', 'export function parseConfig () {}\n')
    write('src/b.py', 'def parse_args():\n  pass\n')
    write('node_modules/x/index.js', 'function parseHidden () {}\n')
    const index = new WorkspaceIndex(dir, treeSitter)
    await index.build()
    expect(index.search('parse').map((e) => e.name).sort())
      .toEqual(['parseConfig', 'parse_args'])
    expect(index.stats()).toEqual({ files: 2, symbols: 2 })

    write('src/a.ts', 'export function renamed () {}\n')
    await index.indexFile(join(dir, 'src/a.ts'))
    expect(index.search('parseConfig')).toEqual([])
  })
})
