const CHECKPOINT_TRIGGERS = ['resume', 'turn', 'before-restore'] as const

type CheckpointTrigger = typeof CHECKPOINT_TRIGGERS[number]

/** The state of the repository's files at one moment, as git trees. */
interface Snapshot {
  /** Branch name, or null on a detached HEAD. */
  readonly branch: string | null
  /** HEAD commit, or null before the first commit. */
  readonly headSha: string | null
  /** Tree of the staged index. */
  readonly indexTree: string
  /** Tree of the index plus every snapshotted worktree change. */
  readonly worktreeTree: string
  /** Untracked files present at snapshot time; restore never removes them. */
  readonly untracked: readonly string[]
  /** Untracked files left out for size. */
  readonly skippedFiles: readonly string[]
  /** Directories left out for holding too many untracked files. */
  readonly skippedDirs: readonly string[]
}

interface Checkpoint extends Snapshot {
  /** Ref name under `refs/pi-checkpoints/`. */
  readonly id: string
  readonly sessionId: string
  readonly trigger: CheckpointTrigger
  readonly turnIndex: number
  readonly description: string
  /** Epoch milliseconds. */
  readonly timestamp: number
}

export { CHECKPOINT_TRIGGERS }
export type { Checkpoint, CheckpointTrigger, Snapshot }
