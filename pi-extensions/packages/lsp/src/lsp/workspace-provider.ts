interface WorkspaceFolder {
  readonly uri: string
  readonly name: string
}

/**
 * Workspace-specific setup supplied by another extension (for example a
 * build-system integration) over `pi.events`.
 */
interface WorkspaceProvider {
  readonly type: string
  /** The detected workspace root, when it differs from the cwd. */
  readonly workspaceRoot: string | null
  /**
   * Directory for shared-daemon sockets and pid files. Null disables
   * shared daemons; servers then run as children of this Pi process.
   */
  readonly stateDir: string | null
  getWorkspaceFolders: () => readonly WorkspaceFolder[]
  /** One-time setup before the first server starts. */
  ensureReady: (sessionId?: string) => Promise<boolean>
  getStatusText: () => string
  shutdown: () => void
}

/** Event channel other extensions emit a provider on. */
const REGISTER_PROVIDER_EVENT = 'lsp:register-workspace-provider'

/** A plain workspace: no extra folders, no shared daemons. */
const DEFAULT_WORKSPACE_PROVIDER: WorkspaceProvider = {
  type: 'default',
  workspaceRoot: null,
  stateDir: null,
  getWorkspaceFolders: () => [],
  ensureReady: async () => true,
  getStatusText: () => '',
  shutdown: () => {}
}

function isNullableString (value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * Checks that an object received over the event bus has the provider
 * shape, so a malformed one cannot break server startup.
 *
 * @param value - Data received on {@link REGISTER_PROVIDER_EVENT}.
 * @returns True when every member has the right type.
 */
function isWorkspaceProvider (value: unknown): value is WorkspaceProvider {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.type === 'string' &&
    isNullableString(candidate.workspaceRoot) &&
    isNullableString(candidate.stateDir) &&
    typeof candidate.getWorkspaceFolders === 'function' &&
    typeof candidate.ensureReady === 'function' &&
    typeof candidate.getStatusText === 'function' &&
    typeof candidate.shutdown === 'function'
}

export {
  DEFAULT_WORKSPACE_PROVIDER,
  isWorkspaceProvider,
  REGISTER_PROVIDER_EVENT
}
export type { WorkspaceFolder, WorkspaceProvider }
