import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { languageIdForPath } from '../language-map.ts'
import {
  daemonSocketPath,
  isDaemonListening,
  isPrivateDir,
  spawnDaemon,
  stopDaemon
} from './daemon-launcher.ts'
import {
  findLombokJar,
  javaInitializationOptions,
  jdtlsDataDir,
  recoverCorruptJavaWorkspace
} from './java-support.ts'
import { LspClient } from './lsp-client.ts'
import { DEFAULT_SERVERS, expectedStartTime } from './server-defaults.ts'
import { DEFAULT_WORKSPACE_PROVIDER } from './workspace-provider.ts'

import type { ServerConfig } from '../project-config.ts'
import type { WorkspaceProvider } from './workspace-provider.ts'

const MAX_RESTART_ATTEMPTS = 3
const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const DAEMON_POLL_MS = 500
const DAEMON_LISTEN_ATTEMPTS = 20
const DAEMON_INIT_RETRY_MS = 5_000
const DAEMON_INIT_ATTEMPTS = 60

/** UI hooks for server lifecycle changes. */
interface LspManagerCallbacks {
  readonly onWorkspaceSetupStart?: () => void
  readonly onWorkspaceSetupEnd?: (success: boolean, durationMs: number) => void
  readonly onServerStart?: (languageId: string, command: string) => void
  readonly onServerReady?: (languageId: string) => void
  readonly onServerError?: (languageId: string, message: string) => void
  readonly onServerNotice?: (languageId: string, message: string,
    level: 'info' | 'warning') => void
  readonly onServerCrash?: (languageId: string, restarting: boolean,
    attempt: number) => void
}

interface ServerStatus {
  readonly languageId: string
  readonly command: string
  readonly running: boolean
  readonly diagnosticsCount: number
  readonly shared: boolean
}

interface LspManagerOptions {
  readonly rootDir: string
  readonly callbacks?: LspManagerCallbacks
  readonly sessionId?: string
  readonly workspace?: WorkspaceProvider
  readonly servers?: Readonly<Record<string, ServerConfig>>
  /** The LOMBOK_JAR environment variable. */
  readonly lombokEnv?: string
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Starts, tracks and restarts one language server per language. */
class LspManager {
  readonly rootDir: string
  private readonly configs: Map<string, ServerConfig>
  private readonly clients = new Map<string, LspClient>()
  private readonly starting = new Map<string, Promise<LspClient>>()
  private readonly restartAttempts = new Map<string, number>()
  private readonly callbacks: LspManagerCallbacks
  private readonly sessionId: string
  private readonly lombokEnv: string | undefined
  private provider: WorkspaceProvider
  private workspaceReady: Promise<void> | undefined
  private lombokPath: string | undefined
  private shuttingDown = false

  constructor (options: LspManagerOptions) {
    this.rootDir = resolve(options.rootDir)
    this.configs = new Map(Object.entries({
      ...DEFAULT_SERVERS,
      ...options.servers
    }))
    this.callbacks = options.callbacks ?? {}
    this.sessionId = options.sessionId ?? `${process.pid}-${Date.now()}`
    this.provider = options.workspace ?? DEFAULT_WORKSPACE_PROVIDER
    this.lombokEnv = options.lombokEnv
  }

  get workspace (): WorkspaceProvider {
    return this.provider
  }

  setWorkspaceProvider (provider: WorkspaceProvider): void {
    this.provider = provider
    this.workspaceReady = undefined
  }

  setServerConfig (languageId: string, config: ServerConfig): void {
    this.configs.set(languageId, config)
  }

  setLombokJar (jarPath: string): void {
    this.lombokPath = resolve(this.rootDir, jarPath)
  }

  getLombokJar (): string | undefined {
    return findLombokJar({
      rootDir: this.rootDir,
      ...(this.lombokPath === undefined
        ? {}
        : { explicitPath: this.lombokPath }),
      ...(this.lombokEnv === undefined ? {} : { envPath: this.lombokEnv }),
      ...(this.provider.workspaceRoot === null
        ? {}
        : { workspaceRoot: this.provider.workspaceRoot })
    })
  }

  getLanguageId (filePath: string): string | undefined {
    return languageIdForPath(filePath)
  }

  resolvePath (filePath: string): string {
    return resolve(this.rootDir, filePath)
  }

  getFileUri (filePath: string): string {
    return pathToFileURL(this.resolvePath(filePath)).toString()
  }

  isServerStarting (languageId: string): boolean {
    return this.starting.has(languageId)
  }

  /**
   * The client for a language, only if it is already initialized.
   *
   * @param languageId - The language.
   * @returns The ready client, or undefined.
   */
  getRunningClient (languageId: string): LspClient | undefined {
    const client = this.clients.get(languageId)
    return client !== undefined && client.initialized && !client.disposed
      ? client
      : undefined
  }

  /**
   * The ready client for a file. When none is running, starts one in the
   * background and returns undefined, so tools can say it is starting.
   *
   * @param filePath - A file of the language.
   * @returns The ready client, or undefined.
   */
  getClientForFile (filePath: string): LspClient | undefined {
    const languageId = this.getLanguageId(filePath)
    return languageId === undefined
      ? undefined
      : this.getClientForLanguage(languageId)
  }

  getClientForLanguage (languageId: string): LspClient | undefined {
    const running = this.getRunningClient(languageId)
    if (running !== undefined) {
      return running
    }
    this.startInBackground(languageId)
    return undefined
  }

  /** Starts servers ahead of first use (project `autoStart`). */
  startEagerly (languageIds: readonly string[]): void {
    for (const languageId of languageIds) {
      if (this.getRunningClient(languageId) === undefined) {
        this.startInBackground(languageId)
      }
    }
  }

  /**
   * Why no client is available for a file, for tool output.
   *
   * @param filePath - The file a tool was asked about.
   * @returns A sentence telling the model what to do next.
   */
  unavailableReason (filePath: string): string {
    const languageId = this.getLanguageId(filePath)
    if (languageId === undefined) {
      return `No LSP server configured for file type: ${filePath}`
    }
    if (this.starting.has(languageId)) {
      return `LSP server for ${languageId} is starting. ` +
        `${expectedStartTime(languageId)} Retry shortly.`
    }
    if (!this.configs.has(languageId)) {
      return `No LSP server configured for ${languageId}. ` +
        `Configure one with /lsp-config ${languageId} <command> [args].`
    }
    return `No LSP server available for: ${filePath}. If you just opened ` +
      'this project, call any LSP tool on a file to trigger server startup.'
  }

  getStatus (): ServerStatus[] {
    return [...this.configs].map(([languageId, config]) => {
      const client = this.clients.get(languageId)
      let diagnosticsCount = 0
      for (const list of client?.getAllDiagnostics().values() ?? []) {
        diagnosticsCount += list.length
      }
      return {
        languageId,
        command: config.command,
        running: client !== undefined && client.initialized &&
          !client.disposed,
        diagnosticsCount,
        shared: client?.shared === true
      }
    })
  }

  private startInBackground (languageId: string): void {
    if (this.shuttingDown || this.starting.has(languageId)) {
      return
    }
    const config = this.configs.get(languageId)
    if (config === undefined) {
      return
    }
    const start = this.startServer(languageId, config)
    this.starting.set(languageId, start)
    start.then(() => {
      this.starting.delete(languageId)
    }, (error: unknown) => {
      this.starting.delete(languageId)
      this.callbacks.onServerError?.(languageId,
        `Failed to start LSP server for ${languageId}: ${errorMessage(error)}`)
    })
  }

  private async ensureWorkspace (): Promise<void> {
    if (this.workspaceReady === undefined) {
      this.callbacks.onWorkspaceSetupStart?.()
      const started = Date.now()
      this.workspaceReady = this.provider.ensureReady(this.sessionId)
        .catch(() => false)
        .then((success) => {
          this.callbacks.onWorkspaceSetupEnd?.(success, Date.now() - started)
        })
    }
    await this.workspaceReady
  }

  private javaLaunch (config: ServerConfig): {
    args: readonly string[]
    initializationOptions?: Readonly<Record<string, unknown>>
  } {
    const lombokJar = this.getLombokJar()
    return {
      args: lombokJar === undefined
        ? config.args
        : [`--jvm-arg=-javaagent:${lombokJar}`, ...config.args],
      initializationOptions: config.initializationOptions ??
        javaInitializationOptions(lombokJar)
    }
  }

  private async startServer (
    languageId: string,
    config: ServerConfig
  ): Promise<LspClient> {
    await this.ensureWorkspace()
    const java = languageId === 'java' ? this.javaLaunch(config) : undefined
    const args = java?.args ?? config.args
    const initializationOptions = java?.initializationOptions ??
      config.initializationOptions
    const folders = this.provider.getWorkspaceFolders()
    const base = {
      command: config.command,
      args,
      rootDir: this.rootDir,
      languageId,
      ...(config.settings === undefined ? {} : { settings: config.settings }),
      ...(initializationOptions === undefined ? {} : { initializationOptions }),
      onUnexpectedExit: () => this.handleUnexpectedExit(languageId)
    }

    const stateDir = this.provider.stateDir
    const socketPath = stateDir === null
      ? undefined
      : daemonSocketPath(stateDir, languageId)
    if (socketPath !== undefined) {
      const shared = await this.connectShared(languageId, socketPath, base,
        () => {
          if (languageId === 'java') {
            this.recoverJava(languageId)
          }
          spawnDaemon({
            socketPath,
            rootDir: this.rootDir,
            languageId,
            config,
            args,
            ...(folders.length > 0 ? { workspaceFolders: folders } : {}),
            ...(initializationOptions === undefined
              ? {}
              : { initializationOptions })
          })
        })
      if (shared !== undefined) {
        return shared
      }
    }

    if (languageId === 'java') {
      this.recoverJava(languageId)
    }
    this.callbacks.onServerStart?.(languageId, config.command)
    const client = new LspClient({
      ...base,
      ...(config.env === undefined ? {} : { env: config.env }),
      ...(folders.length > 0 ? { workspaceFolders: folders } : {})
    })
    return await this.adopt(languageId, client)
  }

  private recoverJava (languageId: string): void {
    recoverCorruptJavaWorkspace(jdtlsDataDir(this.rootDir),
      (message, level) => {
        this.callbacks.onServerNotice?.(languageId, message, level)
      })
  }

  /**
   * Connects to the language's shared daemon, starting one if none is
   * listening. Returns undefined to fall back to a direct server.
   */
  private async connectShared (
    languageId: string,
    socketPath: string,
    base: ConstructorParameters<typeof LspClient>[0],
    launch: () => void
  ): Promise<LspClient | undefined> {
    const socketDir = dirname(socketPath)
    try {
      if (existsSync(socketDir) && !isPrivateDir(socketDir)) {
        throw new Error(`${socketDir} is accessible to other users`)
      }
      if (!(await isDaemonListening(socketPath))) {
        launch()
        if (!(await this.waitForListening(socketPath))) {
          throw new Error('the daemon did not start listening')
        }
      }
      if (!isPrivateDir(socketDir)) {
        throw new Error(`${socketDir} is accessible to other users`)
      }
      this.callbacks.onServerStart?.(languageId, `${base.command} (shared)`)
      for (let attempt = 0; attempt < DAEMON_INIT_ATTEMPTS; attempt++) {
        const client = new LspClient({ ...base, socketPath })
        try {
          return await this.adopt(languageId, client)
        } catch (error) {
          await client.shutdown()
          // The daemon answers "still initializing" until its server is up.
          if (!errorMessage(error).includes('initializing') ||
            this.shuttingDown) {
            throw error
          }
          await sleep(DAEMON_INIT_RETRY_MS)
        }
      }
      throw new Error('the shared server did not finish initializing')
    } catch (error) {
      if (this.shuttingDown) {
        throw error
      }
      this.callbacks.onServerError?.(languageId,
        `Shared daemon unavailable, starting directly: ${errorMessage(error)}`)
      return undefined
    }
  }

  private async waitForListening (socketPath: string): Promise<boolean> {
    for (let attempt = 0; attempt < DAEMON_LISTEN_ATTEMPTS; attempt++) {
      await sleep(DAEMON_POLL_MS)
      if (await isDaemonListening(socketPath)) {
        return true
      }
    }
    return false
  }

  private async adopt (
    languageId: string,
    client: LspClient
  ): Promise<LspClient> {
    try {
      await client.start()
    } catch (error) {
      await client.shutdown()
      throw error
    }
    // Shut down while this server was starting: do not leave it running.
    if (this.shuttingDown) {
      await client.shutdown()
      throw new Error('LSP manager shut down during startup')
    }
    this.clients.set(languageId, client)
    this.restartAttempts.delete(languageId)
    this.callbacks.onServerReady?.(languageId)
    if (languageId === 'java') {
      // Rebuild so diagnostics reflect Lombok-generated code.
      client.sendRequest('java/buildWorkspace', true).catch(() => {})
    }
    return client
  }

  private handleUnexpectedExit (languageId: string): void {
    if (this.shuttingDown) {
      return
    }
    this.clients.delete(languageId)
    const attempts = this.restartAttempts.get(languageId) ?? 0
    if (attempts >= MAX_RESTART_ATTEMPTS) {
      this.callbacks.onServerError?.(languageId, `LSP server for ${languageId} ` +
        `crashed ${attempts} times; not restarting it again`)
      this.callbacks.onServerCrash?.(languageId, false, attempts)
      return
    }
    this.restartAttempts.set(languageId, attempts + 1)
    this.callbacks.onServerCrash?.(languageId, true, attempts + 1)
    const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** attempts,
      MAX_BACKOFF_MS)
    setTimeout(() => {
      if (!this.shuttingDown && !this.clients.has(languageId)) {
        this.startInBackground(languageId)
      }
    }, backoff).unref()
  }

  /**
   * Restarts a language server, stopping its shared daemon too so new
   * settings (such as a Lombok jar) take effect.
   *
   * @param languageId - The language to restart.
   * @throws When no server is configured or the new one fails to start.
   */
  async restartServer (languageId: string): Promise<void> {
    const config = this.configs.get(languageId)
    if (config === undefined) {
      throw new Error(`No server configured for ${languageId}`)
    }
    await this.starting.get(languageId)?.catch(() => {})
    const existing = this.clients.get(languageId)
    this.clients.delete(languageId)
    await existing?.shutdown()
    const stateDir = this.provider.stateDir
    const socketPath = stateDir === null
      ? undefined
      : daemonSocketPath(stateDir, languageId)
    if (socketPath !== undefined) {
      await stopDaemon(socketPath)
    }
    this.restartAttempts.delete(languageId)
    const start = this.startServer(languageId, config)
    this.starting.set(languageId, start)
    try {
      await start
    } finally {
      this.starting.delete(languageId)
    }
  }

  /** Stops direct servers and disconnects from shared daemons. */
  async shutdownAll (): Promise<void> {
    this.shuttingDown = true
    try {
      this.provider.shutdown()
    } catch {}
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(clients.map(async (client) => await client.shutdown()))
  }
}

export { LspManager }
export type { LspManagerCallbacks, LspManagerOptions, ServerStatus }
