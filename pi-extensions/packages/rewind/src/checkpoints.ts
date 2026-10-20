import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import { CHECKPOINT_TRIGGERS } from './checkpoint-types.ts'
import { splitNul } from './git-runner.ts'
import {
  findCrowdedDirs,
  isIgnoredPath,
  isWithinAny,
  MAX_UNTRACKED_FILE_BYTES,
  parsePorcelainV2
} from './snapshot-filter.ts'

import type {
  Checkpoint,
  CheckpointTrigger,
  Snapshot
} from './checkpoint-types.ts'
import type { GitRunner } from './git-runner.ts'

const REF_PREFIX = 'refs/pi-checkpoints/'
const MESSAGE_HEADER = 'pi-rewind checkpoint'
const AUTHOR = 'pi-rewind'
const AUTHOR_EMAIL = 'pi-rewind@localhost'

class CrossBranchError extends Error {
  constructor (checkpointBranch: string | null, currentBranch: string | null) {
    super(`This checkpoint was taken on ${branchName(checkpointBranch)}, ` +
      `but you are on ${branchName(currentBranch)}. Switch back first.`)
    this.name = 'CrossBranchError'
  }
}

function branchName (branch: string | null): string {
  return branch === null ? 'a detached HEAD' : `"${branch}"`
}

/** Ref-safe: letters, digits, `.`, `_`, `-`; no `..`, no `.lock` suffix. */
function isSafeId (id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..') &&
    !id.endsWith('.lock')
}

async function tryRun (
  git: GitRunner,
  args: readonly string[]
): Promise<string | null> {
  try {
    return (await git.run(args)).trim()
  } catch {
    return null
  }
}

async function currentBranch (git: GitRunner): Promise<string | null> {
  return await tryRun(git, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

async function currentHead (git: GitRunner): Promise<string | null> {
  return await tryRun(git, ['rev-parse', '--verify', '--quiet',
    'HEAD^{commit}'])
}

async function fileSize (root: string, path: string): Promise<number | null> {
  try {
    const stats = await lstat(join(root, path))
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

/**
 * Captures the repository's files as git trees without touching the real
 * index, HEAD or any file.
 *
 * Tracked changes are always included. Untracked files are included unless
 * gitignored, under an ignored directory name, larger than 10 MiB, or in a
 * directory holding 200 or more of them.
 *
 * @param git - Runner for the repository root.
 * @returns The snapshot. Its trees are written to the object store.
 */
async function takeSnapshot (git: GitRunner): Promise<Snapshot> {
  const [branch, headSha] = await Promise.all([
    currentBranch(git),
    currentHead(git)
  ])
  const indexTree = (await git.run(['write-tree'])).trim()
  const status = parsePorcelainV2(splitNul(await git.run([
    'status', '--porcelain=2', '-z', '--untracked-files=all'
  ])))

  // A trailing slash marks a nested repository; it is never snapshotted.
  const candidates = status.untracked
    .filter((path) => !path.endsWith('/') && !isIgnoredPath(path))
  const skippedDirs = findCrowdedDirs(candidates)
  const untracked = candidates
    .filter((path) => !isWithinAny(path, skippedDirs))
  const skippedFiles: string[] = []
  const toAdd: string[] = [...status.changedTracked]
  for (const path of untracked) {
    const size = await fileSize(git.root, path)
    if (size !== null && size > MAX_UNTRACKED_FILE_BYTES) {
      skippedFiles.push(path)
    } else {
      toAdd.push(path)
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'pi-rewind-'))
  try {
    const env = { GIT_INDEX_FILE: join(tempDir, 'index') }
    await git.run(['read-tree', indexTree], { env })
    if (toAdd.length > 0) {
      // update-index takes exact paths (no pathspec matching): it adds files
      // that exist and drops index entries for files that do not.
      await git.run(['update-index', '--add', '--remove', '-z', '--stdin'], {
        env,
        input: toAdd.map((path) => `${path}\0`).join('')
      })
    }
    const worktreeTree = (await git.run(['write-tree'], { env })).trim()
    return {
      branch,
      headSha,
      indexTree,
      worktreeTree,
      untracked: untracked.filter((path) => !skippedFiles.includes(path)),
      skippedFiles,
      skippedDirs
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

/**
 * Stores a snapshot as a checkpoint: a parentless commit of the worktree
 * tree, with the metadata as JSON in its message, under
 * `refs/pi-checkpoints/<id>`. Refs there are not pushed by default.
 *
 * @param git - Runner for the repository root.
 * @param checkpoint - The checkpoint; its id must be ref-safe.
 * @throws {Error} When the id is not ref-safe or git fails.
 */
async function saveCheckpoint (
  git: GitRunner,
  checkpoint: Checkpoint
): Promise<void> {
  if (!isSafeId(checkpoint.id)) {
    throw new Error(`Unsafe checkpoint id: ${checkpoint.id}`)
  }
  const date = new Date(checkpoint.timestamp).toISOString()
  const commit = (await git.run(['commit-tree', checkpoint.worktreeTree], {
    input: `${MESSAGE_HEADER} ${checkpoint.id}\n\n` +
      `${JSON.stringify(checkpoint)}\n`,
    env: {
      GIT_AUTHOR_NAME: AUTHOR,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: AUTHOR,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_DATE: date
    }
  })).trim()
  await git.run(['update-ref', `${REF_PREFIX}${checkpoint.id}`, commit])
}

function isStringArray (value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === 'string')
}

function isNullableString (value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isTrigger (value: unknown): value is CheckpointTrigger {
  return CHECKPOINT_TRIGGERS.some((trigger) => trigger === value)
}

/**
 * Reads a checkpoint back from its commit message.
 *
 * @param id - The ref name the message was read from.
 * @param message - The commit message.
 * @returns The checkpoint, or undefined when the message is not a valid
 *   checkpoint or names a different id.
 */
function parseCheckpointMessage (
  id: string,
  message: string
): Checkpoint | undefined {
  const header = `${MESSAGE_HEADER} ${id}\n\n`
  if (!message.startsWith(header)) {
    return undefined
  }
  let data: unknown
  try {
    data = JSON.parse(message.slice(header.length))
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null) {
    return undefined
  }
  const record = data as Record<string, unknown>
  const {
    sessionId, trigger, turnIndex, description, timestamp, branch, headSha,
    indexTree, worktreeTree, untracked, skippedFiles, skippedDirs
  } = record
  if (record.id !== id || typeof sessionId !== 'string' ||
    !isTrigger(trigger) || typeof turnIndex !== 'number' ||
    typeof description !== 'string' || typeof timestamp !== 'number' ||
    !isNullableString(branch) || !isNullableString(headSha) ||
    typeof indexTree !== 'string' || typeof worktreeTree !== 'string' ||
    !isStringArray(untracked) || !isStringArray(skippedFiles) ||
    !isStringArray(skippedDirs)) {
    return undefined
  }
  return {
    id,
    sessionId,
    trigger,
    turnIndex,
    description,
    timestamp,
    branch,
    headSha,
    indexTree,
    worktreeTree,
    untracked,
    skippedFiles,
    skippedDirs
  }
}

/**
 * Loads every checkpoint in the repository, oldest first.
 *
 * @param git - Runner for the repository root.
 * @returns Valid checkpoints; malformed refs are skipped.
 */
async function loadCheckpoints (git: GitRunner): Promise<Checkpoint[]> {
  const output = await git.run([
    'for-each-ref', '--format=%(refname)%00%(contents)%00', REF_PREFIX
  ])
  const fields = output.split('\0')
  const checkpoints: Checkpoint[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const ref = (fields[index] ?? '').replace(/^\n/, '')
    if (!ref.startsWith(REF_PREFIX)) {
      continue
    }
    const checkpoint = parseCheckpointMessage(
      ref.slice(REF_PREFIX.length),
      fields[index + 1] ?? ''
    )
    if (checkpoint !== undefined) {
      checkpoints.push(checkpoint)
    }
  }
  return checkpoints.sort((a, b) => a.timestamp - b.timestamp)
}

async function deleteCheckpoint (git: GitRunner, id: string): Promise<void> {
  if (isSafeId(id)) {
    await git.run(['update-ref', '-d', `${REF_PREFIX}${id}`])
  }
}

async function removeUntrackedFile (root: string, path: string): Promise<void> {
  const target = resolve(root, path)
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..') {
    return
  }
  try {
    const stats = await lstat(target)
    if (stats.isFile() || stats.isSymbolicLink()) {
      await rm(target)
    }
  } catch {
    // Already gone, or not ours to remove.
  }
}

/**
 * Restores the files (worktree and staged index) to a checkpoint.
 *
 * HEAD and branch refs are never moved, so commits made since the
 * checkpoint are kept. Untracked files created since the checkpoint are
 * removed, except ones under ignored directory names, ones that were too
 * large or crowded to snapshot, and gitignored files.
 *
 * @param git - Runner for the repository root.
 * @param checkpoint - The checkpoint to restore.
 * @throws {CrossBranchError} When the current branch differs from the
 *   checkpoint's.
 */
async function restoreCheckpoint (
  git: GitRunner,
  checkpoint: Snapshot
): Promise<void> {
  const branch = await currentBranch(git)
  if (branch !== checkpoint.branch) {
    throw new CrossBranchError(checkpoint.branch, branch)
  }

  await git.run(['read-tree', '--reset', '-u', checkpoint.worktreeTree])

  const keep = new Set([...checkpoint.untracked, ...checkpoint.skippedFiles])
  const others = splitNul(await git.run([
    'ls-files', '-z', '--others', '--exclude-standard'
  ]))
  for (const path of others) {
    if (!keep.has(path) && !isIgnoredPath(path) &&
      !isWithinAny(path, checkpoint.skippedDirs)) {
      await removeUntrackedFile(git.root, path)
    }
  }

  await git.run(['read-tree', '--reset', checkpoint.indexTree])
}

/**
 * Summarises what restoring `to` would change in files that look like
 * `from`.
 *
 * @returns `git diff-tree --stat` output; empty when nothing differs.
 */
async function diffStat (
  git: GitRunner,
  fromTree: string,
  toTree: string
): Promise<string> {
  return (await git.run(['diff-tree', '-r', '--stat', fromTree, toTree]))
    .trim()
}

/**
 * Picks checkpoints to prune: in `sessionId`, all but the newest `max`
 * (before-restore checkpoints are never counted or pruned here); in other
 * sessions, any older than `maxAgeMs`.
 *
 * @returns The ids to delete.
 */
function selectPrunable (
  checkpoints: readonly Checkpoint[],
  sessionId: string,
  max: number,
  now: number,
  maxAgeMs: number
): string[] {
  const own = checkpoints
    .filter((cp) => cp.sessionId === sessionId &&
      cp.trigger !== 'before-restore')
    .sort((a, b) => a.timestamp - b.timestamp)
  const excess = own.slice(0, Math.max(0, own.length - max))
  const stale = checkpoints.filter((cp) => cp.sessionId !== sessionId &&
    now - cp.timestamp > maxAgeMs)
  return [...excess, ...stale].map((cp) => cp.id)
}

export {
  currentBranch,
  currentHead,
  CrossBranchError,
  deleteCheckpoint,
  diffStat,
  isSafeId,
  loadCheckpoints,
  parseCheckpointMessage,
  REF_PREFIX,
  restoreCheckpoint,
  saveCheckpoint,
  selectPrunable,
  takeSnapshot
}
