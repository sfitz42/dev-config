import {
  CrossBranchError,
  currentBranch,
  currentHead,
  deleteCheckpoint,
  diffStat,
  loadCheckpoints,
  restoreCheckpoint,
  saveCheckpoint,
  selectPrunable,
  takeSnapshot
} from './checkpoints.ts'

import type { Checkpoint, CheckpointTrigger } from './checkpoint-types.ts'
import type { GitRunner } from './git-runner.ts'

const MAX_CHECKPOINTS_PER_SESSION = 50
const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000

interface RestorePreview {
  /** `diff-tree --stat` of what the restore would change; may be empty. */
  readonly diff: string
  /** True when HEAD is no longer the commit the checkpoint was taken on. */
  readonly headMoved: boolean
  /** The current branch (null when detached). */
  readonly branch: string | null
}

function sanitize (text: string): string {
  return text.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 64)
}

/**
 * Checkpoints for one Pi session in one repository. Every git operation is
 * queued, so snapshots, restores and pruning never overlap.
 */
class RewindSession {
  readonly git: GitRunner
  readonly sessionId: string
  private readonly now: () => number
  private all: Checkpoint[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private sequence = 0

  constructor (git: GitRunner, sessionId: string, now = Date.now) {
    this.git = git
    this.sessionId = sessionId
    this.now = now
  }

  /** This session's checkpoints to offer for restore, newest first. */
  checkpoints (): Checkpoint[] {
    return this.own()
      .filter((cp) => cp.trigger !== 'before-restore')
      .reverse()
  }

  /** Safety checkpoints taken before each restore, newest last. */
  undoStack (): Checkpoint[] {
    return this.own().filter((cp) => cp.trigger === 'before-restore')
  }

  /**
   * The newest restorable checkpoint taken at or before `timestamp`, or the
   * oldest one when none is that old.
   */
  closestBefore (timestamp: number): Checkpoint | undefined {
    const list = this.checkpoints()
    return list.find((cp) => cp.timestamp <= timestamp) ?? list.at(-1)
  }

  /** Waits for queued git work to finish. */
  async idle (): Promise<void> {
    await this.enqueue(async () => {})
  }

  async load (): Promise<void> {
    await this.enqueue(async () => {
      this.all = await loadCheckpoints(this.git)
    })
  }

  /**
   * Snapshots the files and stores a checkpoint, unless they are identical
   * to this session's latest checkpoint.
   *
   * @returns The new checkpoint, or undefined when nothing changed.
   */
  async checkpoint (
    trigger: Exclude<CheckpointTrigger, 'before-restore'>,
    turnIndex: number,
    description: string
  ): Promise<Checkpoint | undefined> {
    return await this.enqueue(async () => {
      const snapshot = await takeSnapshot(this.git)
      const latest = this.checkpoints()[0]
      if (latest?.worktreeTree === snapshot.worktreeTree &&
        latest.indexTree === snapshot.indexTree) {
        return undefined
      }
      return await this.store(snapshot, trigger, turnIndex, description)
    })
  }

  /** Describes what restoring `target` would change. */
  async preview (target: Checkpoint): Promise<RestorePreview> {
    return await this.enqueue(async () => {
      const [snapshot, head] = await Promise.all([
        takeSnapshot(this.git),
        currentHead(this.git)
      ])
      return {
        diff: await diffStat(this.git, snapshot.worktreeTree,
          target.worktreeTree),
        headMoved: head !== target.headSha,
        branch: await currentBranch(this.git)
      }
    })
  }

  /**
   * Restores the files to `target`, after saving the current files as a
   * before-restore checkpoint that {@link undo} can return to. Nothing is
   * changed when that safety checkpoint cannot be saved.
   */
  async restore (target: Checkpoint): Promise<void> {
    await this.enqueue(async () => {
      const branch = await currentBranch(this.git)
      if (branch !== target.branch) {
        throw new CrossBranchError(target.branch, branch)
      }
      const snapshot = await takeSnapshot(this.git)
      await this.store(snapshot, 'before-restore', 0, 'Before restore')
      await restoreCheckpoint(this.git, target)
    })
  }

  /**
   * Returns the files to how they were before the latest restore, then
   * drops that safety checkpoint.
   *
   * @returns False when there is nothing to undo.
   */
  async undo (): Promise<boolean> {
    return await this.enqueue(async () => {
      const last = this.undoStack().at(-1)
      if (last === undefined) {
        return false
      }
      await restoreCheckpoint(this.git, last)
      await deleteCheckpoint(this.git, last.id)
      this.all = this.all.filter((cp) => cp.id !== last.id)
      return true
    })
  }

  /**
   * Deletes this session's checkpoints beyond the newest 50, and other
   * sessions' checkpoints older than 7 days.
   *
   * @returns How many were deleted.
   */
  async prune (): Promise<number> {
    return await this.enqueue(async () => {
      this.all = await loadCheckpoints(this.git)
      const ids = new Set(selectPrunable(this.all, this.sessionId,
        MAX_CHECKPOINTS_PER_SESSION, this.now(), STALE_SESSION_MS))
      for (const id of ids) {
        await deleteCheckpoint(this.git, id)
      }
      this.all = this.all.filter((cp) => !ids.has(cp.id))
      return ids.size
    })
  }

  private own (): Checkpoint[] {
    return this.all.filter((cp) => cp.sessionId === this.sessionId)
  }

  private async store (
    snapshot: Awaited<ReturnType<typeof takeSnapshot>>,
    trigger: CheckpointTrigger,
    turnIndex: number,
    description: string
  ): Promise<Checkpoint> {
    const timestamp = this.now()
    this.sequence += 1
    const checkpoint: Checkpoint = {
      ...snapshot,
      id: `${trigger}-${sanitize(this.sessionId)}-${timestamp}-` +
        `${this.sequence}`,
      sessionId: this.sessionId,
      trigger,
      turnIndex,
      description,
      timestamp
    }
    await saveCheckpoint(this.git, checkpoint)
    this.all.push(checkpoint)
    return checkpoint
  }

  private async enqueue<T> (task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return await run
  }
}

export { MAX_CHECKPOINTS_PER_SESSION, RewindSession, STALE_SESSION_MS }
export type { RestorePreview }
