/*
 * A minimal language server for tests, run as `node fake-lsp-server.ts`.
 *
 * - initialize: answers after FAKE_LSP_INIT_DELAY ms with hover, completion
 *   and code action support.
 * - initialized: asks the client for `workspace/configuration` section
 *   "fake" and remembers the answer.
 * - didOpen / didChange: publishes one error, "fake error v<version>".
 * - hover: "hover <line>:<character> config=<answer> pid=<pid>".
 * - completion: two items; the second only after a "." before the cursor.
 * - shutdown / exit: as the protocol says.
 */

import {
  encodeMessage,
  MessageParser
} from '../../src/lsp/message-framing.ts'

import type { JsonRpcMessage } from '../../src/lsp/message-framing.ts'

interface Params {
  readonly textDocument: { uri: string, version: number, text: string }
  readonly contentChanges: Array<{ text: string }>
  readonly position: { line: number, character: number }
}

const initDelay = Number(process.env.FAKE_LSP_INIT_DELAY ?? '0')
const documents = new Map<string, string>()
let config: unknown = null

function send (message: Record<string, unknown>): void {
  process.stdout.write(encodeMessage({ jsonrpc: '2.0', ...message }))
}

function publish (uri: string, version: number): void {
  send({
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 }
        },
        severity: 1,
        source: 'fake',
        message: `fake error v${version}`
      }]
    }
  })
}

function textAt (uri: string, line: number, character: number): string {
  const text = documents.get(uri)?.split('\n')[line] ?? ''
  return text.slice(0, character)
}

function handle (message: JsonRpcMessage): void {
  const { id, method } = message
  // Test input from our own client: trusted to have the right shape.
  const params = message.params as Params
  if (method === undefined) {
    if (id === 'config') {
      config = message.result
    }
    return
  }
  switch (method) {
    case 'initialize':
      setTimeout(() => send({
        id,
        result: {
          capabilities: {
            hoverProvider: true,
            completionProvider: {},
            codeActionProvider: true
          }
        }
      }), initDelay)
      return
    case 'initialized':
      send({
        id: 'config',
        method: 'workspace/configuration',
        params: { items: [{ section: 'fake' }] }
      })
      return
    case 'textDocument/didOpen':
    case 'textDocument/didChange': {
      const doc = params.textDocument
      const text = method === 'textDocument/didOpen'
        ? doc.text
        : params.contentChanges[0]?.text ?? ''
      documents.set(doc.uri, text)
      publish(doc.uri, doc.version)
      return
    }
    case 'textDocument/hover': {
      const { line, character } = params.position
      send({
        id,
        result: {
          contents: {
            kind: 'plaintext',
            value: `hover ${line}:${character} ` +
              `config=${JSON.stringify(config)} pid=${process.pid}`
          }
        }
      })
      return
    }
    case 'textDocument/completion': {
      const { line, character } = params.position
      const before = textAt(params.textDocument.uri, line, character)
      const items = [{ label: 'plain', kind: 6, sortText: 'b' }]
      if (before.endsWith('.')) {
        items.push({ label: 'member', kind: 2, sortText: 'a' })
      }
      send({ id, result: items })
      return
    }
    case 'shutdown':
      send({ id, result: null })
      return
    case 'test/never':
      // Never answered, to test request timeouts.
      return
    case 'exit':
      process.exit(0)
      return
    default:
      if (id !== undefined) {
        send({ id, result: null })
      }
  }
}

const parser = new MessageParser(handle)
process.stdin.on('data', (chunk: Buffer) => parser.feed(chunk))
process.stdin.on('end', () => process.exit(0))
