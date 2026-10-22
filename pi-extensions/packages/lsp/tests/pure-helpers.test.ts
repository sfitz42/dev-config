import { describe, expect, test } from 'vitest'

import { languageIdForPath } from '../src/language-map.ts'
import { encodeMessage, MessageParser } from '../src/lsp/message-framing.ts'
import { footerStatus, statusReport } from '../src/lsp-status.ts'
import { matchSymbol } from '../src/symbol-match.ts'
import {
  canInsertDot,
  docSummary,
  insertDot,
  topItems
} from '../src/tools/completions-tool.ts'
import {
  byPreference,
  isCommand,
  overlapping
} from '../src/tools/code-actions-tool.ts'
import {
  formatDiagnostic,
  injectedErrorNote
} from '../src/tools/diagnostic-format.ts'
import {
  formatRenameEdit,
  summarizeActionEdit
} from '../src/tools/workspace-edit-format.ts'

import type { Diagnostic } from 'vscode-languageserver-protocol'

import type { JsonRpcMessage } from '../src/lsp/message-framing.ts'

const range = (line: number, start: number, end = start) => ({
  start: { line, character: start },
  end: { line, character: end }
})

describe('languageIdForPath', () => {
  test.each([
    ['src/app.ts', 'typescript'],
    ['App.TSX', 'typescriptreact'],
    ['lib/x.mjs', 'javascript'],
    ['main.rs', 'rust'],
    ['script.zsh', 'bash']
  ])('%s is %s', (path, id) => {
    expect(languageIdForPath(path)).toBe(id)
  })

  test('unknown or missing extensions are undefined', () => {
    expect(languageIdForPath('Makefile')).toBeUndefined()
    expect(languageIdForPath('notes.xyz')).toBeUndefined()
    expect(languageIdForPath('dir.ts/file')).toBeUndefined()
  })
})

describe('matchSymbol', () => {
  const candidates = [
    { name: 'render', line: 1, character: 1 },
    { name: 'Widget', line: 3, character: 7 },
    { name: 'render', line: 5, character: 3, parent: 'Widget' },
    { name: 'renderAll', line: 9, character: 3 }
  ]

  test('prefers exact, then case-insensitive, then substring', () => {
    expect(matchSymbol(candidates, 'render')?.line).toBe(1)
    expect(matchSymbol(candidates, 'widget')?.line).toBe(3)
    expect(matchSymbol(candidates, 'All')?.name).toBe('renderAll')
  })

  test('dot-qualified queries look in the parent first', () => {
    expect(matchSymbol(candidates, 'Widget.render')?.line).toBe(5)
    expect(matchSymbol(candidates, 'Other.render')?.line).toBe(1)
  })

  test('no match is undefined', () => {
    expect(matchSymbol(candidates, 'missing')).toBeUndefined()
  })
})

describe('message framing', () => {
  test('parses messages split across and joined within chunks', () => {
    const received: JsonRpcMessage[] = []
    const parser = new MessageParser((m) => received.push(m))
    const a = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' })
    const b = encodeMessage({ jsonrpc: '2.0', method: 'b', params: 'é' })
    const all = Buffer.concat([a, b])
    parser.feed(all.subarray(0, 10))
    parser.feed(all.subarray(10, a.length + 5))
    parser.feed(all.subarray(a.length + 5))
    expect(received.map((m) => m.method)).toEqual(['a', 'b'])
    expect(received[1]?.params).toBe('é')
  })

  test('reports bad headers and non-JSON-RPC bodies', () => {
    const errors: string[] = []
    const parser = new MessageParser(() => {}, (e) => errors.push(e.message))
    parser.feed(Buffer.from('Content-Length: 2\r\n\r\n{}'))
    parser.feed(Buffer.from('Bogus: 1\r\n\r\n'))
    expect(errors).toEqual(['Not a JSON-RPC 2.0 message',
      'Invalid LSP message header'])
  })
})

describe('completion helpers', () => {
  test('a dot goes after identifiers and closing brackets only', () => {
    expect(canInsertDot('foo\n', 0, 3)).toBe(true)
    expect(canInsertDot('foo()\n', 0, 5)).toBe(true)
    expect(canInsertDot('foo.bar', 0, 3)).toBe(false)
    expect(canInsertDot('foo + ', 0, 6)).toBe(false)
    expect(canInsertDot('foo', 0, 0)).toBe(false)
    expect(canInsertDot('foo', 3, 1)).toBe(false)
  })

  test('insertDot inserts at the position', () => {
    expect(insertDot('a\nfoo bar', 1, 3)).toBe('a\nfoo. bar')
  })

  test('items are ranked by sortText, then label', () => {
    const items = topItems([
      { label: 'b' }, { label: 'z', sortText: 'a' }, { label: 'a' }
    ], 2)
    expect(items.map((i) => i.label)).toEqual(['z', 'a'])
  })

  test('doc summaries drop code blocks and stay short', () => {
    expect(docSummary('```ts\nx\n```\nFirst line\n\nSecond\nThird'))
      .toBe('First line Second')
    expect(docSummary('x'.repeat(200))?.length).toBe(120)
    expect(docSummary(undefined)).toBeUndefined()
  })
})

describe('diagnostic formatting', () => {
  const error: Diagnostic = {
    range: range(2, 4),
    severity: 1,
    message: 'bad',
    code: 'E1',
    source: 'ts'
  }

  test('formats 1-indexed with code and source', () => {
    expect(formatDiagnostic(error, 'a.ts')).toBe('a.ts:3:5 error: bad (E1) [ts]')
  })

  test('the injected note lists errors only, at most ten', () => {
    const warning = { ...error, severity: 2 as const }
    expect(injectedErrorNote([warning], 'a.ts')).toBeUndefined()
    const note = injectedErrorNote(Array(12).fill(error), 'a.ts') ?? ''
    expect(note).toContain('⚠ LSP: 12 error(s) in a.ts')
    expect(note).toContain('... and 2 more error(s)')
    expect(note.split('\n').filter((l) => l.startsWith('a.ts:'))).toHaveLength(10)
  })
})

describe('workspace edits', () => {
  test('rename previews list files and edits from both shapes', () => {
    const preview = formatRenameEdit('/root', {
      changes: { 'file:///root/a.ts': [{ range: range(0, 4), newText: 'x' }] },
      documentChanges: [{
        textDocument: { uri: 'file:///root/b.ts', version: 1 },
        edits: [{ range: range(1, 0), newText: 'x' }]
      }]
    })
    expect(preview).toEqual({
      text: 'b.ts:\n  2:1 → "x"\na.ts:\n  1:5 → "x"',
      fileCount: 2,
      editCount: 2
    })
  })

  test('action summaries cap edits per file and escape newlines', () => {
    const edits = Array.from({ length: 7 },
      (_, i) => ({ range: range(i, 0), newText: 'a\nb' }))
    const lines = summarizeActionEdit('/root',
      { changes: { 'file:///root/a.ts': edits } })
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('     a.ts:1:1 insert "a\\nb"')
    expect(lines[5]).toBe('     ... and 2 more edits in a.ts')
  })
})

describe('code actions', () => {
  test('commands are told apart from actions', () => {
    expect(isCommand({ title: 'run', command: 'x.run' })).toBe(true)
    expect(isCommand({ title: 'fix', command: { title: 'f', command: 'f' } }))
      .toBe(false)
  })

  test('preferred first, then quickfix, refactor, source', () => {
    const sorted = [
      { title: 'source', kind: 'source.organizeImports' },
      { title: 'refactor', kind: 'refactor.extract' },
      { title: 'fix', kind: 'quickfix' },
      { title: 'preferred', kind: 'refactor', isPreferred: true }
    ].sort(byPreference)
    expect(sorted.map((a) => a.title))
      .toEqual(['preferred', 'fix', 'refactor', 'source'])
  })

  test('diagnostics overlapping the range are sent', () => {
    const inside = { range: range(1, 2, 8), message: 'in' }
    const outside = { range: range(5, 0), message: 'out' }
    expect(overlapping([inside, outside], range(1, 4)))
      .toEqual([inside])
  })
})

describe('status text', () => {
  const statuses = [
    {
      languageId: 'typescript',
      command: 'tsls',
      running: true,
      diagnosticsCount: 2,
      shared: false
    },
    {
      languageId: 'java',
      command: 'jdtls',
      running: false,
      diagnosticsCount: 0,
      shared: true
    }
  ]

  test('footer shows running languages and diagnostics', () => {
    expect(footerStatus(statuses))
      .toEqual({ colour: 'accent', text: 'LSP: typescript (2 diagnostics)' })
    expect(footerStatus([])).toEqual({ colour: 'dim', text: 'LSP: idle' })
  })

  test('the report has one line per server', () => {
    expect(statusReport(statuses)).toBe(
      '🟢 typescript: tsls (2 diagnostics)\n⚪ java: jdtls [shared]')
  })
})
