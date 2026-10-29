import { FileSync } from './file-sync.ts'
import { LspManager } from './lsp/lsp-manager.ts'
import { DEFAULT_WORKSPACE_PROVIDER } from './lsp/workspace-provider.ts'
import { EMPTY_CONFIG } from './project-config.ts'
import { TreeSitterManager } from './tree-sitter/parser-manager.ts'
import { WorkspaceIndex } from './tree-sitter/workspace-index.ts'

import type { LspManagerCallbacks } from './lsp/lsp-manager.ts'
import type { WorkspaceProvider } from './lsp/workspace-provider.ts'
import type { ProjectConfig } from './project-config.ts'

interface RuntimeParts {
  readonly manager: LspManager
  readonly fileSync: FileSync
  readonly treeSitter: TreeSitterManager
  readonly workspaceIndex: WorkspaceIndex
}

/**
 * The per-session LSP state. Tools read it through this holder, so they
 * always see the instances for the current session even though the
 * session can be replaced while the tools stay registered.
 */
class LspRuntime {
  private parts: RuntimeParts | undefined
  private provider: WorkspaceProvider = DEFAULT_WORKSPACE_PROVIDER
  private config: ProjectConfig = EMPTY_CONFIG
  private readonly callbacks: LspManagerCallbacks

  constructor (callbacks: LspManagerCallbacks) {
    this.callbacks = callbacks
  }

  private current (): RuntimeParts {
    this.parts ??= this.create(process.cwd(), EMPTY_CONFIG)
    return this.parts
  }

  get manager (): LspManager {
    return this.current().manager
  }

  get fileSync (): FileSync {
    return this.current().fileSync
  }

  get treeSitter (): TreeSitterManager {
    return this.current().treeSitter
  }

  get workspaceIndex (): WorkspaceIndex {
    return this.current().workspaceIndex
  }

  get projectConfig (): ProjectConfig {
    return this.config
  }

  /** The running manager, without creating one. */
  get activeManager (): LspManager | undefined {
    return this.parts?.manager
  }

  get rootDir (): string {
    return this.current().manager.rootDir
  }

  private create (cwd: string, config: ProjectConfig): RuntimeParts {
    const manager = new LspManager({
      rootDir: cwd,
      callbacks: this.callbacks,
      workspace: this.provider,
      servers: config.servers,
      ...(process.env.LOMBOK_JAR === undefined
        ? {}
        : { lombokEnv: process.env.LOMBOK_JAR })
    })
    const treeSitter = new TreeSitterManager()
    const workspaceIndex = new WorkspaceIndex(cwd, treeSitter)
    const fileSync = new FileSync(manager, {
      onFileChanged: (path) => {
        treeSitter.invalidate(path)
        workspaceIndex.indexFile(path).catch(() => {})
      }
    })
    return { manager, fileSync, treeSitter, workspaceIndex }
  }

  /**
   * Replaces the state for a new session.
   *
   * @param cwd - The session's working directory.
   * @param config - The project config to apply (already trust-filtered).
   */
  async reset (cwd: string, config: ProjectConfig): Promise<void> {
    await this.shutdown()
    this.config = config
    this.parts = this.create(cwd, config)
  }

  /** Uses a workspace provider from another extension. */
  setWorkspaceProvider (provider: WorkspaceProvider): void {
    this.provider = provider
    this.parts?.manager.setWorkspaceProvider(provider)
  }

  get workspaceProvider (): WorkspaceProvider {
    return this.provider
  }

  async shutdown (): Promise<void> {
    const parts = this.parts
    this.parts = undefined
    if (parts !== undefined) {
      await parts.manager.shutdownAll().catch(() => {})
      parts.treeSitter.shutdown()
    }
  }
}

export { LspRuntime }
