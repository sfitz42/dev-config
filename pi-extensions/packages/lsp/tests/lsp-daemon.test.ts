import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  daemonSocketPath,
  isDaemonListening,
  isPrivateDir,
  spawnDaemon,
  stopDaemon
} from '../src/lsp/daemon-launcher.ts'
import { LspManager } from '../src/lsp/lsp-manager.ts'
import { DEFAULT_WORKSPACE_PROVIDER } from '../src/lsp/workspace-provider.ts'

import type { LspClient } from '../src/lsp/lsp-client.ts'
import type { WorkspaceProvider } from '../src/lsp/workspace-provider.ts'

const FAKE_SERVER = fileURLToPath(
  new URL('./fixtures/fake-lsp-server.ts', import.meta.url))
const fakeServer = { command: process.execPath, args: [FAKE_SERVER] }

const waitFor = async (check: () => boolean | Promise<boolean>,
  ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error('timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function serverPid (client: LspClient, dir: string): Promise<string> {
  const hover = await client.sendRequest<{ contents: { value: string } }>(
    'textDocument/hover', {
      textDocument: { uri: pathToFileURL(join(dir, 'a.ts')).toString() },
      position: { line: 0, character: 0 }
    })
  return /pid=(\d+)/.exec(hover.contents.value)?.[1] ?? ''
}

let dir = ''
let stateDir = ''
let provider: WorkspaceProvider
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-lsp-daemon-'))
  stateDir = join(dir, 'state')
  provider = { ...DEFAULT_WORKSPACE_PROVIDER, type: 'test', stateDir }
})
afterEach(async () => {
  const socket = daemonSocketPath(stateDir, 'typescript')
  if (socket !== undefined) {
    await stopDaemon(socket)
  }
  rmSync(dir, { recursive: true, force: true })
})

function manager (): LspManager {
  return new LspManager({
    rootDir: dir,
    workspace: provider,
    servers: { typescript: fakeServer }
  })
}

async function running (m: LspManager): Promise<LspClient> {
  m.startEagerly(['typescript'])
  let client: LspClient | undefined
  await waitFor(() => {
    client = m.getRunningClient('typescript')
    return client !== undefined
  })
  if (client === undefined) {
    throw new Error('not running')
  }
  return client
}

describe('socket paths', () => {
  test('language ids must be plain identifiers', () => {
    expect(daemonSocketPath('/s', 'java')).toBe('/s/sockets/lsp-java.sock')
    expect(daemonSocketPath('/s', '../../etc/x')).toBeUndefined()
  })
})

describe('shared daemon', () => {
  test('sessions share one server; one leaving does not stop it', async () => {
    const first = manager()
    const second = manager()
    try {
      const a = await running(first)
      expect(a.shared).toBe(true)
      expect(a.serverCapabilities?.hoverProvider).toBe(true)
      const b = await running(second)
      expect(await serverPid(b, dir)).toBe(await serverPid(a, dir))

      const socket = join(stateDir, 'sockets', 'lsp-typescript.sock')
      expect(statSync(socket).mode & 0o777).toBe(0o600)
      expect(isPrivateDir(join(stateDir, 'sockets'))).toBe(true)

      // A client's shutdown and exit are not passed on to the server.
      await first.shutdownAll()
      expect(await serverPid(b, dir)).not.toBe('')
    } finally {
      await first.shutdownAll()
      await second.shutdownAll()
    }
  }, 30_000)

  test('restart stops the daemon and starts a new server', async () => {
    const m = manager()
    try {
      const before = await serverPid(await running(m), dir)
      await m.restartServer('typescript')
      const client = m.getRunningClient('typescript')
      expect(client?.shared).toBe(true)
      expect(client === undefined ? '' : await serverPid(client, dir))
        .not.toBe(before)
    } finally {
      await m.shutdownAll()
    }
  }, 30_000)

  test('the daemon refuses a socket directory others can enter', async () => {
    mkdirSync(join(stateDir, 'sockets'), { recursive: true, mode: 0o755 })
    const socketPath = join(stateDir, 'sockets', 'lsp-typescript.sock')
    spawnDaemon({
      socketPath,
      rootDir: dir,
      languageId: 'typescript',
      config: fakeServer,
      args: fakeServer.args
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await isDaemonListening(socketPath)).toBe(false)

    // The manager falls back to a server of its own.
    const m = manager()
    try {
      expect((await running(m)).shared).toBe(false)
    } finally {
      await m.shutdownAll()
    }
  }, 30_000)
})
