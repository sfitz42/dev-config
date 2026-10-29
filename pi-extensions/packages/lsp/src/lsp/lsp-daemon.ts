/*
 * Shared LSP daemon: runs one language server and lets several Pi sessions
 * use it over a Unix socket. Started by daemon-launcher.ts as
 *   node lsp-daemon.ts <socketPath> <command> [args...]
 * with LSP_ROOT_DIR, LSP_LANGUAGE_ID, LSP_WORKSPACE_FOLDERS,
 * LSP_INITIALIZATION_OPTIONS and LSP_SETTINGS in the environment.
 *
 * Node runs this file directly (type stripping), so it must stay erasable
 * TypeScript importing only node built-ins and the two modules below.
 *
 * The daemon answers each client's `initialize` with the server's original
 * result and never forwards a client's `shutdown` or `exit`, so one session
 * cannot stop the server for the others. The socket directory must belong
 * to the current user with no group or world access; the socket is 0600.
 */

import { spawn } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  answerConfiguration,
  buildInitializeParams
} from './initialize-params.ts'
import { encodeMessage, MessageParser } from './message-framing.ts'

import type { Socket } from 'node:net'

import type { InitializeFolder } from './initialize-params.ts'
import type { JsonRpcMessage } from './message-framing.ts'

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000
const INITIALIZE_TIMEOUT_MS = 5 * 60 * 1000
const STOP_DAEMON_METHOD = '$/pi-lsp/stopDaemon'
const SERVER_NOT_INITIALIZED = -32002
const NO_CLIENT = -32001

interface Client {
  readonly id: number
  readonly socket: Socket
}

const [socketPath, command, ...serverArgs] = process.argv.slice(2)
if (socketPath === undefined || command === undefined) {
  process.stderr.write('Usage: lsp-daemon.ts <socketPath> <command> [args]\n')
  process.exit(1)
}
const SOCKET = socketPath
const LOG_PATH = SOCKET.replace(/\.sock$/, '') + '.log'
const PID_PATH = SOCKET.replace(/\.sock$/, '') + '.pid'
const rootDir = process.env.LSP_ROOT_DIR ?? process.cwd()

function log (message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`,
      { mode: 0o600 })
  } catch {}
}

function parseJsonEnv (name: string): unknown {
  const raw = process.env[name]
  if (raw === undefined) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    log(`Ignoring invalid JSON in ${name}`)
    return undefined
  }
}

function isFolderList (value: unknown): value is InitializeFolder[] {
  return Array.isArray(value) && value.every((f) =>
    typeof f === 'object' && f !== null &&
    typeof f.uri === 'string' && typeof f.name === 'string')
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The socket directory must be a real directory only we can enter. */
function ensurePrivateDir (dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  const uid = process.getuid?.()
  if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid) ||
    (stats.mode & 0o077) !== 0) {
    throw new Error(`Refusing to use ${dir}: it must be a directory owned ` +
      'by you with mode 700')
  }
}

// Check the socket directory before anything is started.
try {
  ensurePrivateDir(dirname(SOCKET))
  if (lstatSync(SOCKET, { throwIfNoEntry: false })?.isSocket() === true) {
    unlinkSync(SOCKET)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
  process.exit(1)
}

const folders = parseJsonEnv('LSP_WORKSPACE_FOLDERS')
const initOptions = parseJsonEnv('LSP_INITIALIZATION_OPTIONS')
const settingsValue = parseJsonEnv('LSP_SETTINGS')
const settings = isRecord(settingsValue) ? settingsValue : undefined

const clients = new Map<number, Client>()
interface PendingRequest {
  readonly client: number
  readonly id: number | string
}

/** Daemon request id → the client and its own id. */
const pendingRequests = new Map<number, PendingRequest>()
/** Server request id → the client asked to answer it. */
const pendingServerRequests = new Map<number | string, number>()
let nextClientId = 1
let nextRequestId = 1
let initializeResult: unknown
let initializeId: number | undefined
let idleTimer: NodeJS.Timeout | undefined
let shuttingDown = false

const server = spawn(command, serverArgs, {
  cwd: rootDir,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe']
})
server.stderr.resume()
server.stdin.on('error', () => {})

function toServer (message: JsonRpcMessage): void {
  if (server.stdin.writable) {
    server.stdin.write(encodeMessage(message))
  }
}

function toClient (client: Client, message: JsonRpcMessage): void {
  if (!client.socket.destroyed) {
    client.socket.write(encodeMessage(message))
  }
}

function reply (client: Client, id: number | string, result: unknown): void {
  toClient(client, { jsonrpc: '2.0', id, result })
}

function replyError (client: Client, id: number | string, code: number,
  message: string): void {
  toClient(client, { jsonrpc: '2.0', id, error: { code, message } })
}

function armIdleTimer (): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    log('No clients for 5 minutes; stopping')
    shutdown(0)
  }, IDLE_SHUTDOWN_MS)
}

function fromClient (client: Client, message: JsonRpcMessage): void {
  const { id, method } = message
  if (method === undefined) {
    // A response to a request the server sent this client.
    if (id !== undefined && pendingServerRequests.delete(id)) {
      toServer(message)
    }
    return
  }
  if (id === undefined) {
    if (method !== 'initialized' && method !== 'exit') {
      toServer(message)
    }
    return
  }
  if (method === STOP_DAEMON_METHOD) {
    reply(client, id, null)
    shutdown(0)
    return
  }
  if (method === 'shutdown') {
    reply(client, id, null)
    return
  }
  if (initializeResult === undefined) {
    replyError(client, id, SERVER_NOT_INITIALIZED,
      'The language server is still initializing')
    return
  }
  if (method === 'initialize') {
    reply(client, id, initializeResult)
    return
  }
  const daemonId = nextRequestId++
  pendingRequests.set(daemonId, { client: client.id, id })
  toServer({ ...message, id: daemonId })
}

function fromServer (message: JsonRpcMessage): void {
  const { id, method } = message
  if (method === undefined) {
    if (id === initializeId && initializeId !== undefined) {
      initializeId = undefined
      if (message.error !== undefined) {
        log('initialize failed')
        shutdown(1)
        return
      }
      initializeResult = message.result ?? {}
      toServer({ jsonrpc: '2.0', method: 'initialized', params: {} })
      log('Language server initialized')
      return
    }
    const pending = typeof id === 'number'
      ? pendingRequests.get(id)
      : undefined
    if (pending !== undefined && typeof id === 'number') {
      pendingRequests.delete(id)
      const client = clients.get(pending.client)
      if (client !== undefined) {
        toClient(client, { ...message, id: pending.id })
      }
    }
    return
  }
  if (id === undefined) {
    for (const client of clients.values()) {
      toClient(client, message)
    }
    return
  }
  if (method === 'workspace/configuration') {
    const result = answerConfiguration(message.params, settings)
    toServer({ jsonrpc: '2.0', id, result })
    return
  }
  const [first] = clients.values()
  if (first === undefined) {
    toServer({
      jsonrpc: '2.0',
      id,
      error: { code: NO_CLIENT, message: 'No client connected' }
    })
    return
  }
  pendingServerRequests.set(id, first.id)
  toClient(first, message)
}

function shutdown (code: number): void {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  log('Stopping daemon')
  clearTimeout(idleTimer)
  for (const client of clients.values()) {
    client.socket.destroy()
  }
  clients.clear()
  listener.close()
  try {
    unlinkSync(SOCKET)
  } catch {}
  try {
    unlinkSync(PID_PATH)
  } catch {}
  if (server.exitCode === null) {
    toServer({ jsonrpc: '2.0', id: nextRequestId++, method: 'shutdown' })
    setTimeout(() => {
      toServer({ jsonrpc: '2.0', method: 'exit' })
      setTimeout(() => server.kill('SIGTERM'), 1000).unref()
    }, 2000).unref()
  }
  setTimeout(() => process.exit(code), 3500).unref()
}

const listener = createServer((socket) => {
  const client: Client = { id: nextClientId++, socket }
  clients.set(client.id, client)
  clearTimeout(idleTimer)
  log(`Client ${client.id} connected`)
  const parser = new MessageParser((message) => fromClient(client, message),
    () => socket.destroy())
  socket.on('data', (chunk: Buffer) => parser.feed(chunk))
  socket.on('error', () => socket.destroy())
  socket.on('close', () => {
    clients.delete(client.id)
    for (const [daemonId, pending] of pendingRequests) {
      if (pending.client === client.id) {
        pendingRequests.delete(daemonId)
      }
    }
    log(`Client ${client.id} disconnected`)
    if (clients.size === 0) {
      armIdleTimer()
    }
  })
})

server.on('error', (error) => {
  log(`Language server failed to start: ${error.message}`)
  shutdown(1)
})
server.on('exit', (exitCode) => {
  log(`Language server exited with code ${String(exitCode)}`)
  shutdown(0)
})
const serverParser = new MessageParser(fromServer)
server.stdout.on('data', (chunk: Buffer) => serverParser.feed(chunk))

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.stack ?? error.message}`)
  shutdown(1)
})

listener.on('error', (error) => {
  log(`Socket error: ${error.message}`)
  shutdown(1)
})
listener.listen(SOCKET, () => {
  chmodSync(SOCKET, 0o600)
  writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 })
  log(`Listening on ${SOCKET} (${process.env.LSP_LANGUAGE_ID ?? 'unknown'})`)
  armIdleTimer()
})

initializeId = nextRequestId++
toServer({
  jsonrpc: '2.0',
  id: initializeId,
  method: 'initialize',
  params: buildInitializeParams({
    processId: process.pid,
    rootUri: pathToFileURL(rootDir).toString(),
    rootName: basename(rootDir) || 'workspace',
    ...(isFolderList(folders) ? { workspaceFolders: folders } : {}),
    ...(initOptions === undefined ? {} : { initializationOptions: initOptions })
  })
})
setTimeout(() => {
  if (initializeResult === undefined) {
    log('initialize timed out')
    shutdown(1)
  }
}, INITIALIZE_TIMEOUT_MS).unref()
