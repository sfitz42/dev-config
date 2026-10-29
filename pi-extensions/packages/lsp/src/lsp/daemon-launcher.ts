import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { encodeMessage } from './message-framing.ts'

import type { ServerConfig } from '../project-config.ts'
import type { WorkspaceFolder } from './workspace-provider.ts'

const DAEMON_SCRIPT = fileURLToPath(new URL('./lsp-daemon.ts', import.meta.url))
const PROBE_TIMEOUT_MS = 1_000
const STOP_TIMEOUT_MS = 3_000
const STOP_DAEMON_METHOD = '$/pi-lsp/stopDaemon'
const SAFE_LANGUAGE_ID = /^[A-Za-z0-9_+-]+$/

interface DaemonLaunch {
  readonly socketPath: string
  readonly rootDir: string
  readonly languageId: string
  readonly config: ServerConfig
  readonly args: readonly string[]
  readonly workspaceFolders?: readonly WorkspaceFolder[]
  readonly initializationOptions?: Readonly<Record<string, unknown>>
}

/**
 * The daemon socket for a language under a provider's state directory.
 *
 * @param stateDir - The workspace provider's state directory.
 * @param languageId - The language; must be a plain identifier.
 * @returns The socket path, or undefined for an unsafe language id.
 */
function daemonSocketPath (
  stateDir: string,
  languageId: string
): string | undefined {
  if (!SAFE_LANGUAGE_ID.test(languageId)) {
    return undefined
  }
  return join(stateDir, 'sockets', `lsp-${languageId}.sock`)
}

/**
 * Whether a socket directory is safe to trust: a real directory owned by
 * the current user with no group or world access.
 *
 * @param dir - The directory holding daemon sockets.
 * @returns True when other local users cannot plant or reach sockets.
 */
function isPrivateDir (dir: string): boolean {
  const stats = lstatSync(dir, { throwIfNoEntry: false })
  if (stats === undefined || !stats.isDirectory()) {
    return false
  }
  const uid = process.getuid?.()
  return (uid === undefined || stats.uid === uid) &&
    (stats.mode & 0o077) === 0
}

/**
 * Whether a daemon is listening on a socket.
 *
 * @param socketPath - The daemon socket.
 * @returns True when a connection succeeds.
 */
async function isDaemonListening (socketPath: string): Promise<boolean> {
  if (lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket() !== true) {
    return false
  }
  return await new Promise<boolean>((resolve) => {
    const socket = connect(socketPath)
    const finish = (listening: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(listening)
    }
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * Starts a detached daemon that outlives this Pi process.
 *
 * @param launch - The server to run and where to listen.
 */
function spawnDaemon (launch: DaemonLaunch): void {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...launch.config.env,
    LSP_ROOT_DIR: launch.rootDir,
    LSP_LANGUAGE_ID: launch.languageId
  }
  if (launch.workspaceFolders !== undefined &&
    launch.workspaceFolders.length > 0) {
    env.LSP_WORKSPACE_FOLDERS = JSON.stringify(launch.workspaceFolders)
  }
  if (launch.initializationOptions !== undefined) {
    env.LSP_INITIALIZATION_OPTIONS =
      JSON.stringify(launch.initializationOptions)
  }
  if (launch.config.settings !== undefined) {
    env.LSP_SETTINGS = JSON.stringify(launch.config.settings)
  }
  const child = spawn(process.execPath,
    [DAEMON_SCRIPT, launch.socketPath, launch.config.command, ...launch.args],
    { cwd: launch.rootDir, env, detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/**
 * Asks a daemon to stop, over its own socket (never by pid, so a stale or
 * planted pid file cannot make this kill an unrelated process).
 *
 * @param socketPath - The daemon socket.
 */
async function stopDaemon (socketPath: string): Promise<void> {
  if (!(await isDaemonListening(socketPath))) {
    return
  }
  await new Promise<void>((resolve) => {
    const socket = connect(socketPath)
    const finish = (): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve()
    }
    const timer = setTimeout(finish, STOP_TIMEOUT_MS)
    socket.once('connect', () => {
      socket.write(encodeMessage({
        jsonrpc: '2.0',
        id: 1,
        method: STOP_DAEMON_METHOD
      }))
    })
    socket.once('data', finish)
    socket.once('error', finish)
    socket.once('close', finish)
  })
}

export {
  DAEMON_SCRIPT,
  daemonSocketPath,
  isDaemonListening,
  isPrivateDir,
  spawnDaemon,
  STOP_DAEMON_METHOD,
  stopDaemon
}
export type { DaemonLaunch }
