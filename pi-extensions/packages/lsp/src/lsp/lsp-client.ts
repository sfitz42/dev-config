import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-languageserver-protocol/node'

import { answerConfiguration, buildInitializeParams } from './initialize-params.ts'

import type { ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'
import type {
  Diagnostic,
  InitializeResult,
  PublishDiagnosticsParams,
  ServerCapabilities
} from 'vscode-languageserver-protocol'
import type {
  MessageConnection,
  MessageReader,
  MessageWriter
} from 'vscode-languageserver-protocol/node'

import type { WorkspaceFolder } from './workspace-provider.ts'

const CONNECT_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 3_000
const KILL_GRACE_MS = 2_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

interface LspClientOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly rootDir: string
  readonly languageId: string
  readonly env?: Readonly<Record<string, string>>
  readonly workspaceFolders?: readonly WorkspaceFolder[]
  /** Connect to a shared daemon instead of spawning the server. */
  readonly socketPath?: string
  readonly initializationOptions?: Readonly<Record<string, unknown>>
  readonly settings?: Readonly<Record<string, unknown>>
  readonly requestTimeoutMs?: number
  /** Called when the server or daemon goes away without being asked to. */
  readonly onUnexpectedExit?: (code: number | null) => void
}

interface Transport {
  readonly reader: MessageReader
  readonly writer: MessageWriter
}

function isPublishDiagnostics (
  value: unknown
): value is PublishDiagnosticsParams {
  return typeof value === 'object' && value !== null &&
    'uri' in value && typeof value.uri === 'string' &&
    'diagnostics' in value && Array.isArray(value.diagnostics)
}

/** JSON-RPC client for one language server, direct or via a daemon. */
class LspClient {
  readonly languageId: string
  readonly command: string
  private readonly options: LspClientOptions
  private process: ChildProcess | undefined
  private socket: Socket | undefined
  private connection: MessageConnection | undefined
  private capabilities: ServerCapabilities | undefined
  private readonly diagnostics = new Map<string, Diagnostic[]>()
  private isInitialized = false
  private isDisposed = false

  constructor (options: LspClientOptions) {
    this.options = options
    this.languageId = options.languageId
    this.command = options.command
  }

  get initialized (): boolean {
    return this.isInitialized
  }

  get disposed (): boolean {
    return this.isDisposed
  }

  get serverCapabilities (): ServerCapabilities | undefined {
    return this.capabilities
  }

  /** True when this client talks to a shared daemon. */
  get shared (): boolean {
    return this.options.socketPath !== undefined
  }

  getDiagnostics (uri: string): readonly Diagnostic[] {
    return this.diagnostics.get(uri) ?? []
  }

  getAllDiagnostics (): ReadonlyMap<string, readonly Diagnostic[]> {
    return new Map(this.diagnostics)
  }

  /** Starts (or connects to) the server and completes `initialize`. */
  async start (): Promise<void> {
    if (this.isInitialized || this.isDisposed) {
      return
    }
    const transport = this.options.socketPath === undefined
      ? await this.spawnServer()
      : await this.connectSocket(this.options.socketPath)
    const connection = createMessageConnection(transport.reader,
      transport.writer)
    this.connection = connection
    this.registerHandlers(connection)
    connection.listen()

    const rootUri = pathToFileURL(this.options.rootDir).toString()
    const params = buildInitializeParams({
      processId: process.pid,
      rootUri,
      rootName: basename(this.options.rootDir) || 'workspace',
      ...(this.options.workspaceFolders === undefined
        ? {}
        : { workspaceFolders: this.options.workspaceFolders }),
      ...(this.options.initializationOptions === undefined
        ? {}
        : { initializationOptions: this.options.initializationOptions })
    })
    const result = await connection.sendRequest<InitializeResult>(
      'initialize', params)
    this.capabilities = result.capabilities
    this.notify('initialized', {})
    this.isInitialized = true
  }

  private registerHandlers (connection: MessageConnection): void {
    connection.onNotification('textDocument/publishDiagnostics',
      (params: unknown) => {
        if (isPublishDiagnostics(params)) {
          this.diagnostics.set(params.uri, params.diagnostics)
        }
      })
    connection.onRequest('workspace/configuration', (params: unknown) =>
      answerConfiguration(params, this.options.settings))
    connection.onError(() => {})
    connection.onClose(() => {
      this.isInitialized = false
    })
  }

  private async spawnServer (): Promise<Transport> {
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.rootDir,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.process = child
    // spawn reports a missing command asynchronously, as an 'error' event.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn)
        reject(new Error(
          `Failed to start "${this.options.command}": ${error.message}`))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })

    child.stderr.resume()
    // Writes after the server exits fail with EPIPE; the exit handler
    // below reports the exit itself.
    child.stdin.on('error', () => {})
    child.on('error', () => {
      this.isInitialized = false
    })
    child.on('exit', (code) => {
      if (!this.isDisposed) {
        this.isInitialized = false
        this.disposeConnection()
        this.options.onUnexpectedExit?.(code)
      }
    })
    return {
      reader: new StreamMessageReader(child.stdout),
      writer: new StreamMessageWriter(child.stdin)
    }
  }

  private async connectSocket (socketPath: string): Promise<Transport> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(socketPath)
      const timer = setTimeout(() => {
        candidate.destroy()
        reject(new Error('Timed out connecting to the LSP daemon'))
      }, CONNECT_TIMEOUT_MS)
      candidate.once('connect', () => {
        clearTimeout(timer)
        resolve(candidate)
      })
      candidate.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`Failed to connect to the LSP daemon: ${error.message}`))
      })
    })
    this.socket = socket
    socket.on('error', () => {
      this.isInitialized = false
    })
    socket.on('close', () => {
      if (!this.isDisposed) {
        this.isInitialized = false
        this.disposeConnection()
        this.options.onUnexpectedExit?.(null)
      }
    })
    return {
      reader: new SocketMessageReader(socket),
      writer: new SocketMessageWriter(socket)
    }
  }

  private disposeConnection (): void {
    try {
      this.connection?.dispose()
    } catch {}
    this.connection = undefined
  }

  /**
   * Sends a request, failing after the request timeout.
   *
   * @param method - The LSP method.
   * @param params - Its parameters.
   * @returns The server's result.
   * @throws When the server is not ready, errors, or times out.
   */
  async sendRequest<R> (method: string, params: unknown): Promise<R> {
    const connection = this.connection
    if (connection === undefined || !this.isInitialized) {
      throw new Error(`LSP ${this.languageId} is not initialized`)
    }
    const timeoutMs = this.options.requestTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)
    })
    try {
      return await Promise.race([
        connection.sendRequest<R>(method, params),
        timeout
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Sends a notification; failures (a dead server) are ignored. */
  notify (method: string, params: unknown): void {
    this.connection?.sendNotification(method, params).catch(() => {})
  }

  didOpen (uri: string, languageId: string, version: number,
    text: string): void {
    if (this.isInitialized) {
      this.notify('textDocument/didOpen',
        { textDocument: { uri, languageId, version, text } })
    }
  }

  didChange (uri: string, version: number, text: string): void {
    if (this.isInitialized) {
      this.notify('textDocument/didChange',
        { textDocument: { uri, version }, contentChanges: [{ text }] })
    }
  }

  didClose (uri: string): void {
    if (this.isInitialized) {
      this.notify('textDocument/didClose', { textDocument: { uri } })
    }
  }

  /**
   * Shuts the server down, or only disconnects when it is a shared daemon.
   * Safe to call more than once.
   */
  async shutdown (): Promise<void> {
    if (this.isDisposed) {
      return
    }
    this.isDisposed = true
    this.isInitialized = false
    const connection = this.connection

    if (this.socket !== undefined) {
      this.disposeConnection()
      this.socket.destroy()
      this.socket = undefined
      return
    }

    if (connection !== undefined) {
      const request = connection.sendRequest('shutdown').catch(() => {})
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        request,
        new Promise((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
        })
      ])
      clearTimeout(timer)
      connection.sendNotification('exit').catch(() => {})
    }
    this.disposeConnection()

    const child = this.process
    this.process = undefined
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM')
      const force = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL')
        }
      }, KILL_GRACE_MS)
      force.unref()
    }
  }
}

export { LspClient }
export type { LspClientOptions }
