import { currentBranch } from './checkpoints.ts'
import { checkpointLabel } from './labels.ts'

import type {
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeForkEvent,
  SessionBeforeForkResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeResult,
  SessionEntry
} from '@earendil-works/pi-coding-agent'

import type { Checkpoint } from './checkpoint-types.ts'
import type { RewindSession } from './rewind-session.ts'

const MAX_LISTED = 25
const MAX_DIFF_CHARS = 2000

const UNDO = '↩ Undo last rewind'
const CANCEL = 'Cancel'

const MODE_ALL = 'Restore all (files + conversation)'
const MODE_FILES = 'Files only (keep conversation)'
const MODE_CONVERSATION = 'Conversation only (keep files)'

const FORK_CONVERSATION = 'Conversation only (keep files)'
const FORK_ALL = 'Restore all (files + conversation)'
const FORK_FILES = 'Code only (restore files, keep conversation)'

const TREE_KEEP = 'Keep current files'
const TREE_RESTORE = 'Restore files to that point'
const TREE_CANCEL = 'Cancel navigation'

function errorText (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Finds the newest session entry created at or before `timestamp`.
 *
 * @param entries - The current branch, oldest first.
 * @returns The entry's id, or undefined when every entry is newer.
 */
function entryAtOrBefore (
  entries: readonly SessionEntry[],
  timestamp: number
): string | undefined {
  let found: string | undefined
  for (const entry of entries) {
    const time = Date.parse(entry.timestamp)
    if (!Number.isNaN(time) && time <= timestamp) {
      found = entry.id
    }
  }
  return found
}

async function restoreFiles (
  session: RewindSession,
  ctx: ExtensionContext,
  target: Checkpoint
): Promise<boolean> {
  try {
    await session.restore(target)
    return true
  } catch (error) {
    ctx.ui.notify(`Restore failed: ${errorText(error)}`, 'error')
    return false
  }
}

async function undoLastRewind (
  session: RewindSession,
  ctx: ExtensionContext
): Promise<void> {
  try {
    if (await session.undo()) {
      ctx.ui.notify('Files restored to before the last rewind.', 'info')
    } else {
      ctx.ui.notify('Nothing to undo.', 'warning')
    }
  } catch (error) {
    ctx.ui.notify(`Undo failed: ${errorText(error)}`, 'error')
  }
}

/** Asks for confirmation, showing what the restore would change. */
async function confirmRestore (
  session: RewindSession,
  ctx: ExtensionContext,
  target: Checkpoint,
  position: number
): Promise<boolean> {
  const preview = await session.preview(target)
  if (preview.branch !== target.branch) {
    ctx.ui.notify(
      `Checkpoint #${position} is from another branch ` +
        `(${target.branch ?? 'detached'}). Switch back to it first.`,
      'error'
    )
    return false
  }
  const notes: string[] = []
  if (preview.diff !== '') {
    notes.push(`Files changed since checkpoint #${position}:\n\n` +
      preview.diff.slice(0, MAX_DIFF_CHARS))
  }
  if (preview.headMoved) {
    notes.push('HEAD has moved since this checkpoint. Commits are kept; ' +
      'only files change.')
  }
  if (notes.length === 0) {
    return true
  }
  return await ctx.ui.confirm('Proceed with restore?', notes.join('\n\n'))
}

/**
 * The `/rewind` flow: pick a checkpoint (or undo), preview, choose what to
 * restore, restore.
 *
 * @param session - Checkpoints for this session.
 * @param ctx - The command context.
 * @param navigate - Moves the conversation to an entry without triggering
 *   the tree-restore prompt.
 */
async function runRewind (
  session: RewindSession,
  ctx: ExtensionCommandContext,
  navigate: (entryId: string) => Promise<void>
): Promise<void> {
  const listed = session.checkpoints().slice(0, MAX_LISTED)
  const canUndo = session.undoStack().length > 0
  if (listed.length === 0 && !canUndo) {
    ctx.ui.notify('No checkpoints available.', 'warning')
    return
  }

  const branch = await currentBranch(session.git)
  const labels = listed.map((cp, index) =>
    checkpointLabel(cp, index + 1, branch))
  const choice = await ctx.ui.select('Rewind to checkpoint:',
    canUndo ? [UNDO, ...labels] : labels)
  if (choice === undefined) {
    ctx.ui.notify('Rewind cancelled.', 'info')
    return
  }
  if (choice === UNDO) {
    await undoLastRewind(session, ctx)
    return
  }

  const index = labels.indexOf(choice)
  const target = listed[index]
  if (target === undefined) {
    return
  }
  const position = index + 1
  if (!await confirmRestore(session, ctx, target, position)) {
    ctx.ui.notify('Rewind cancelled.', 'info')
    return
  }

  const mode = await ctx.ui.select('Restore mode:',
    [MODE_ALL, MODE_FILES, MODE_CONVERSATION, CANCEL])
  if (mode === undefined || mode === CANCEL) {
    ctx.ui.notify('Rewind cancelled.', 'info')
    return
  }

  if (mode !== MODE_CONVERSATION &&
    !await restoreFiles(session, ctx, target)) {
    return
  }
  if (mode !== MODE_FILES) {
    const entryId = entryAtOrBefore(ctx.sessionManager.getBranch(),
      target.timestamp)
    if (entryId === undefined) {
      ctx.ui.notify('No conversation entry that old; kept the conversation.',
        'warning')
    } else {
      try {
        await navigate(entryId)
      } catch (error) {
        ctx.ui.notify(`Conversation rewind failed: ${errorText(error)}`,
          'warning')
      }
    }
  }

  const what = mode === MODE_ALL
    ? 'files and conversation'
    : mode === MODE_FILES ? 'files' : 'conversation'
  ctx.ui.notify(`Rewound ${what} to checkpoint #${position}.`, 'info')
}

function entryTime (ctx: ExtensionContext, entryId: string): number {
  const entry = ctx.sessionManager.getEntry(entryId)
  const time = entry === undefined ? Number.NaN : Date.parse(entry.timestamp)
  return Number.isNaN(time) ? Date.now() : time
}

/**
 * Before `/fork`: offer to restore the files to the fork point too.
 *
 * @returns Pi's fork result: cancel, skip the conversation, or proceed.
 */
async function handleFork (
  session: RewindSession,
  event: SessionBeforeForkEvent,
  ctx: ExtensionContext
): Promise<SessionBeforeForkResult | undefined> {
  if (!ctx.hasUI) {
    return undefined
  }
  const target = session.closestBefore(entryTime(ctx, event.entryId))
  const options = [FORK_CONVERSATION]
  if (target !== undefined) {
    options.push(FORK_ALL, FORK_FILES)
  }
  if (session.undoStack().length > 0) {
    options.push(UNDO)
  }
  options.push(CANCEL)

  const choice = await ctx.ui.select('Restore options', options)
  if (choice === undefined || choice === CANCEL) {
    return { cancel: true }
  }
  if (choice === UNDO) {
    await undoLastRewind(session, ctx)
    return { cancel: true }
  }
  if (choice === FORK_CONVERSATION || target === undefined) {
    return undefined
  }
  if (!await restoreFiles(session, ctx, target)) {
    return { cancel: true }
  }
  ctx.ui.notify('Files restored from checkpoint.', 'info')
  return choice === FORK_FILES ? { skipConversationRestore: true } : undefined
}

/**
 * Before `/tree` navigation (Pi's double-Escape by default): offer to
 * restore the files to that point too.
 *
 * @returns Pi's tree result: cancel, or proceed.
 */
async function handleTree (
  session: RewindSession,
  event: SessionBeforeTreeEvent,
  ctx: ExtensionContext
): Promise<SessionBeforeTreeResult | undefined> {
  if (!ctx.hasUI) {
    return undefined
  }
  const target = session.closestBefore(
    entryTime(ctx, event.preparation.targetId))
  const options = [TREE_KEEP]
  if (target !== undefined) {
    options.push(TREE_RESTORE)
  }
  if (session.undoStack().length > 0) {
    options.push(UNDO)
  }
  options.push(TREE_CANCEL)

  const choice = await ctx.ui.select('Restore options', options)
  if (choice === undefined || choice === TREE_CANCEL) {
    return { cancel: true }
  }
  if (choice === UNDO) {
    await undoLastRewind(session, ctx)
    return { cancel: true }
  }
  if (choice === TREE_RESTORE && target !== undefined) {
    if (!await restoreFiles(session, ctx, target)) {
      return { cancel: true }
    }
    ctx.ui.notify('Files restored to checkpoint.', 'info')
  }
  return undefined
}

export { entryAtOrBefore, handleFork, handleTree, runRewind }
