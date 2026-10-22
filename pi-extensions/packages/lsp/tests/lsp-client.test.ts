import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { FileSync } from '../src/file-sync.ts'
import { LspClient } from '../src/lsp/lsp-client.ts'
import { LspManager } from '../src/lsp/lsp-manager.ts'

const FAKE_SERVER = fileURLToPath(
  new URL('./fixtures/fake-lsp-server.ts', import.meta.url))
const fakeServer = { command: process.execPath, args: [FAKE_SERVER] }

const waitFor = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-lsp-client-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('LspClient (direct)', () => {
  test('initializes, answers configuration, caches diagnostics', async () => {
    const client = new LspClient({
      ...fakeServer,
      rootDir: dir,
      languageId: 'fake',
      settings: { fake: { level: 3 } }
    })
    await client.start()
    try {
      expect(client.initialized).toBe(true)
      expect(client.serverCapabilities?.hoverProvider).toBe(true)

      const uri = pathToFileURL(join(dir, 'a.fake')).toString()
      client.didOpen(uri, 'fake', 1, 'text')
      await waitFor(() => client.getDiagnostics(uri).length > 0)
      expect(client.getDiagnostics(uri)[0]?.message).toBe('fake error v1')

      const hover = await client.sendRequest<{ contents: { value: string } }>(
        'textDocument/hover',
        { textDocument: { uri }, position: { line: 2, character: 3 } })
      expect(hover.contents.value).toContain('hover 2:3 config=[{"level":3}]')
    } finally {
      await client.shutdown()
    }
    expect(client.disposed).toBe(true)
    await client.shutdown()
  })

  test('a missing command fails to start', async () => {
    const client = new LspClient({
      command: join(dir, 'no-such-server'),
      args: [],
      rootDir: dir,
      languageId: 'fake'
    })
    await expect(client.start()).rejects.toThrow(/Failed to start/)
    await client.shutdown()
  })

  test('requests time out', async () => {
    const client = new LspClient({
      ...fakeServer,
      rootDir: dir,
      languageId: 'fake',
      requestTimeoutMs: 50
    })
    await client.start()
    try {
      await expect(client.sendRequest('test/never', {}))
        .rejects.toThrow(/timed out/)
    } finally {
      await client.shutdown()
    }
  })
})

describe('LspManager and FileSync', () => {
  test('starts lazily, syncs writes and reports status', async () => {
    const errors: string[] = []
    const manager = new LspManager({
      rootDir: dir,
      servers: { typescript: fakeServer },
      callbacks: { onServerError: (_id, message) => errors.push(message) }
    })
    const sync = new FileSync(manager)
    try {
      const file = join(dir, 'a.ts')
      writeFileSync(file, 'one')
      expect(manager.getClientForFile(file)).toBeUndefined()
      expect(manager.unavailableReason(file)).toMatch(/is starting/)
      await waitFor(() => manager.getRunningClient('typescript') !== undefined)

      const client = manager.getRunningClient('typescript')
      const uri = manager.getFileUri(file)
      await sync.handleFileWrite(file)
      await waitFor(() => client?.getDiagnostics(uri)[0]?.message ===
        'fake error v1')
      writeFileSync(file, 'two')
      await sync.handleFileWrite(file)
      await waitFor(() => client?.getDiagnostics(uri)[0]?.message ===
        'fake error v2')
      expect(sync.getTrackedVersion(uri)).toBe(2)

      const status = manager.getStatus()
        .find((s) => s.languageId === 'typescript')
      expect(status).toMatchObject({ running: true, diagnosticsCount: 1 })
      expect(errors).toEqual([])
    } finally {
      await manager.shutdownAll()
    }
  })

  test('evicts the least recently used document', async () => {
    const manager = new LspManager({
      rootDir: dir,
      servers: { typescript: fakeServer }
    })
    const sync = new FileSync(manager, { maxTracked: 2 })
    try {
      manager.startEagerly(['typescript'])
      await waitFor(() => manager.getRunningClient('typescript') !== undefined)
      for (const name of ['a.ts', 'b.ts', 'c.ts']) {
        writeFileSync(join(dir, name), name)
        await sync.handleFileWrite(join(dir, name))
      }
      expect(sync.trackedCount).toBe(2)
      expect(sync.getTrackedVersion(manager.getFileUri(join(dir, 'a.ts'))))
        .toBeUndefined()
    } finally {
      await manager.shutdownAll()
    }
  })

  test('document locks run in order', async () => {
    const sync = new FileSync(new LspManager({ rootDir: dir }))
    const order: string[] = []
    const slow = sync.withDocumentLock('u', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push('first')
    })
    const fast = sync.withDocumentLock('u', async () => {
      order.push('second')
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(['first', 'second'])
  })

  test('a server started during shutdown is stopped', async () => {
    const manager = new LspManager({
      rootDir: dir,
      servers: { typescript: fakeServer }
    })
    manager.startEagerly(['typescript'])
    await manager.shutdownAll()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(manager.getRunningClient('typescript')).toBeUndefined()
  })

  test('a crashed server is restarted', async () => {
    const crashes: number[] = []
    const manager = new LspManager({
      rootDir: dir,
      servers: { typescript: fakeServer },
      callbacks: { onServerCrash: (_id, _restarting, n) => crashes.push(n) }
    })
    try {
      manager.startEagerly(['typescript'])
      await waitFor(() => manager.getRunningClient('typescript') !== undefined)
      const first = manager.getRunningClient('typescript')
      first?.notify('exit', null)
      await waitFor(() => crashes.length === 1)
      await waitFor(() => {
        const next = manager.getRunningClient('typescript')
        return next !== undefined && next !== first
      }, 5000)
    } finally {
      await manager.shutdownAll()
    }
  })
})
