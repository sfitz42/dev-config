import { readFile } from 'node:fs/promises'

import type { LspClient } from './lsp/lsp-client.ts'
import type { LspManager } from './lsp/lsp-manager.ts'

const MAX_TRACKED_DOCUMENTS = 100

interface TrackedDocument {
  readonly languageId: string
  version: number
}

interface FileSyncOptions {
  readonly maxTracked?: number
  /** Called with the absolute path after every write or edit. */
  readonly onFileChanged?: (absolutePath: string) => void
}

/**
 * Keeps language servers in step with Pi's reads, writes and edits:
 * `didOpen` on first sight, `didChange` with the full text after a write,
 * and `didClose` for the least recently used document beyond the limit.
 * Each document has a lock so temporary edits (completions) and real
 * writes never interleave.
 */
class FileSync {
  private readonly manager: LspManager
  private readonly tracked = new Map<string, TrackedDocument>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly maxTracked: number
  private readonly onFileChanged: ((absolutePath: string) => void) | undefined

  constructor (manager: LspManager, options: FileSyncOptions = {}) {
    this.manager = manager
    this.maxTracked = options.maxTracked ?? MAX_TRACKED_DOCUMENTS
    this.onFileChanged = options.onFileChanged
  }

  get trackedCount (): number {
    return this.tracked.size
  }

  /**
   * Runs `fn` while holding the document's lock.
   *
   * @param uri - The document.
   * @param fn - Work that sends changes for the document.
   * @returns What `fn` returns.
   */
  async withDocumentLock<T> (uri: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(uri) ?? Promise.resolve()
    let release = (): void => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = previous.then(async () => await current)
    this.locks.set(uri, chained)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(uri) === chained) {
        this.locks.delete(uri)
      }
    }
  }

  /** A read: open the document if its server is already running. */
  async handleFileRead (filePath: string): Promise<void> {
    const uri = this.manager.getFileUri(filePath)
    if (this.tracked.has(uri)) {
      this.touch(uri)
      return
    }
    const languageId = this.manager.getLanguageId(filePath)
    const client = languageId === undefined
      ? undefined
      : this.manager.getRunningClient(languageId)
    if (languageId === undefined || client === undefined) {
      return
    }
    await this.withDocumentLock(uri, async () => {
      await this.sendContent(client, uri, languageId, filePath)
    })
  }

  /** A write or edit: send the new content, starting a server if needed. */
  async handleFileWrite (filePath: string): Promise<void> {
    this.onFileChanged?.(this.manager.resolvePath(filePath))
    const languageId = this.manager.getLanguageId(filePath)
    if (languageId === undefined) {
      return
    }
    const client = this.manager.getClientForFile(filePath)
    if (client === undefined) {
      return
    }
    const uri = this.manager.getFileUri(filePath)
    await this.withDocumentLock(uri, async () => {
      await this.sendContent(client, uri, languageId, filePath)
    })
  }

  /**
   * Opens a document that is not tracked yet. Call while holding its lock.
   *
   * @returns The document's current version, or undefined when unreadable.
   */
  async ensureOpen (
    client: LspClient,
    filePath: string
  ): Promise<number | undefined> {
    const uri = this.manager.getFileUri(filePath)
    const existing = this.tracked.get(uri)
    if (existing !== undefined) {
      return existing.version
    }
    const languageId = this.manager.getLanguageId(filePath)
    if (languageId === undefined) {
      return undefined
    }
    await this.sendContent(client, uri, languageId, filePath)
    return this.tracked.get(uri)?.version
  }

  /**
   * Sends replacement text for an open document and records its version.
   * Call while holding the document's lock.
   */
  sendChange (client: LspClient, uri: string, text: string): void {
    const doc = this.tracked.get(uri)
    if (doc !== undefined) {
      doc.version += 1
      client.didChange(uri, doc.version, text)
    }
  }

  getTrackedVersion (uri: string): number | undefined {
    return this.tracked.get(uri)?.version
  }

  private async sendContent (
    client: LspClient,
    uri: string,
    languageId: string,
    filePath: string
  ): Promise<void> {
    let text: string
    try {
      text = await readFile(this.manager.resolvePath(filePath), 'utf8')
    } catch {
      return
    }
    const doc = this.tracked.get(uri)
    if (doc === undefined) {
      this.tracked.set(uri, { languageId, version: 1 })
      client.didOpen(uri, languageId, 1, text)
    } else {
      doc.version += 1
      client.didChange(uri, doc.version, text)
    }
    this.touch(uri)
  }

  private touch (uri: string): void {
    const doc = this.tracked.get(uri)
    if (doc !== undefined) {
      this.tracked.delete(uri)
      this.tracked.set(uri, doc)
    }
    while (this.tracked.size > this.maxTracked) {
      const oldest = this.tracked.keys().next()
      if (oldest.done === true) {
        return
      }
      const evicted = this.tracked.get(oldest.value)
      this.tracked.delete(oldest.value)
      if (evicted !== undefined) {
        this.manager.getRunningClient(evicted.languageId)
          ?.didClose(oldest.value)
      }
    }
  }
}

export { FileSync, MAX_TRACKED_DOCUMENTS }
export type { FileSyncOptions }
