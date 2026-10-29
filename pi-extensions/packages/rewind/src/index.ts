import { createGitRunner, findRepoRoot } from './git-runner.ts'
import {
  describeToolCall,
  describeTurn,
  MUTATING_TOOLS,
  truncate
} from './labels.ts'
import { handleFork, handleTree, runRewind } from './rewind-flows.ts'
import { RewindSession } from './rewind-session.ts'

import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

const STATUS_KEY = 'rewind'

function showStatus (
  session: RewindSession | undefined,
  ctx: ExtensionContext
): void {
  if (!ctx.hasUI) {
    return
  }
  if (session === undefined) {
    ctx.ui.setStatus(STATUS_KEY, undefined)
    return
  }
  const count = session.checkpoints().length
  const { theme } = ctx.ui
  ctx.ui.setStatus(STATUS_KEY, theme.fg('dim', '◆ ') +
    theme.fg('muted', `${count} checkpoint${count === 1 ? '' : 's'}`))
}

/**
 * Pi entry point: git-backed checkpoints after each turn that changed
 * files, `/rewind`, and file-restore prompts on `/fork` and `/tree`.
 *
 * @param pi - The extension API for this runtime.
 */
export default function rewind (pi: ExtensionAPI): void {
  let session: RewindSession | undefined
  let prompt = ''
  let turnTools: string[] = []
  let turnMutated = false
  let navigating = false
  const pendingTools = new Map<string, string>()

  const resetTurn = (): void => {
    turnTools = []
    turnMutated = false
  }

  pi.on('session_start', async (_event, ctx) => {
    session = undefined
    prompt = ''
    resetTurn()
    pendingTools.clear()

    const root = await findRepoRoot(ctx.cwd)
    if (root === undefined) {
      showStatus(undefined, ctx)
      return
    }
    const current = new RewindSession(createGitRunner(root),
      ctx.sessionManager.getSessionId())
    session = current
    try {
      await current.load()
      await current.checkpoint('resume', 0, 'Session start')
    } catch {
      // Rewind is best-effort; never block the session.
    }
    showStatus(current, ctx)
    current.prune()
      .then(() => showStatus(current, ctx), () => {})
  })

  pi.on('before_agent_start', (event) => {
    if (event.messageType === 'user') {
      prompt = truncate(event.prompt, 60)
    }
    resetTurn()
  })

  pi.on('tool_call', (event) => {
    if (MUTATING_TOOLS.has(event.toolName)) {
      pendingTools.set(event.toolCallId,
        describeToolCall(event.toolName, event.input))
    }
  })

  pi.on('tool_execution_end', (event) => {
    if (!MUTATING_TOOLS.has(event.toolName)) {
      return
    }
    turnMutated = true
    turnTools.push(pendingTools.get(event.toolCallId) ?? event.toolName)
    pendingTools.delete(event.toolCallId)
  })

  pi.on('turn_end', async (event, ctx) => {
    const current = session
    const mutated = turnMutated
    const description = describeTurn(prompt, turnTools, event.turnIndex)
    resetTurn()
    if (current === undefined || !mutated) {
      return
    }
    try {
      await current.checkpoint('turn', event.turnIndex, description)
      await current.prune()
    } catch {
      // A failed checkpoint must not interrupt the agent.
    }
    showStatus(current, ctx)
  })

  pi.on('session_before_fork', async (event, ctx) =>
    session === undefined ? undefined : await handleFork(session, event, ctx))

  pi.on('session_before_tree', async (event, ctx) =>
    session === undefined || navigating
      ? undefined
      : await handleTree(session, event, ctx))

  pi.on('session_shutdown', async () => {
    await session?.idle()
  })

  pi.registerCommand('rewind', {
    description: 'Rewind files and/or conversation to a checkpoint',
    handler: async (_args, ctx) => {
      if (session === undefined) {
        ctx.ui.notify('Rewind needs a git repository.', 'warning')
        return
      }
      await runRewind(session, ctx, async (entryId) => {
        navigating = true
        try {
          await ctx.navigateTree(entryId, { summarize: true })
        } finally {
          navigating = false
        }
      })
      showStatus(session, ctx)
    }
  })
}
