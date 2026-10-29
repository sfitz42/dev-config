import { homedir } from 'node:os'

import { isToolCallEventType } from '@earendil-works/pi-coding-agent'

import {
  announceFeature,
  emitBlocked,
  emitRiskDetected,
  withPromptEvents
} from '../events.ts'
import { createRuntime } from '../runtime.ts'
import { assessCommand, autoDenyReason, sessionGrant } from './gate-check.ts'
import {
  createGatePrompt,
  SELECT_OPTIONS,
  selectTitle
} from './gate-prompt.ts'

import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

import type { GateAnswer } from './gate-prompt.ts'

async function askGate (
  ctx: ExtensionContext,
  command: string,
  description: string
): Promise<GateAnswer> {
  if (ctx.mode === 'tui') {
    return await ctx.ui.custom<GateAnswer>(
      createGatePrompt(command, description))
  }
  const choice = await ctx.ui.select(selectTitle(command, description),
    SELECT_OPTIONS.map((option) => option.label))
  return SELECT_OPTIONS.find((option) => option.label === choice)?.answer ??
    'deny'
}

/**
 * Pi entry point: asks before dangerous bash commands run.
 *
 * @param pi - The extension API.
 */
export default function permissionGate (pi: ExtensionAPI): void {
  const runtime = createRuntime(pi)
  announceFeature(pi, 'permissionGate')

  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('bash', event)) {
      return undefined
    }
    await runtime.ensureLoaded(ctx)
    const config = runtime.loader.config
    if (!config.enabled || !config.features.permissionGate) {
      return undefined
    }
    const command = event.input.command
    const input = { ...event.input }
    const action = { kind: 'command' as const, command, origin: 'bash' }
    const decision = assessCommand(command, config.permissionGate, {
      cwd: ctx.cwd, home: homedir(), environment: process.env
    })

    if (decision.kind === 'allow') {
      return undefined
    }
    if (decision.kind === 'deny') {
      const reason = autoDenyReason(decision.pattern)
      emitBlocked(pi, {
        feature: 'permissionGate',
        action,
        reason,
        block: { source: 'permission', metadata: decision.pattern },
        context: { toolName: 'bash', input }
      })
      return { block: true, reason }
    }

    const { finding } = decision
    const metadata = {
      command,
      description: finding.description,
      pattern: finding.pattern,
      segment: finding.segment
    }
    emitRiskDetected(pi, {
      feature: 'permissionGate',
      risk: { action, reason: finding.description, metadata },
      context: { toolName: 'bash', input }
    })
    if (!config.permissionGate.requireConfirmation) {
      ctx.ui.notify(`Dangerous command detected: ${finding.description}`,
        'warning')
      return undefined
    }
    if (!ctx.hasUI) {
      const reason =
        `Dangerous command blocked (no UI to confirm): ${finding.description}`
      emitBlocked(pi, {
        feature: 'permissionGate',
        action,
        reason,
        block: { source: 'nonInteractive', metadata },
        context: { toolName: 'bash', input }
      })
      return { block: true, reason }
    }

    const answer = await withPromptEvents(pi, {
      feature: 'permissionGate',
      action,
      reason: finding.description,
      prompt: { kind: 'permission', metadata },
      context: { toolName: 'bash', input }
    }, async () => await askGate(ctx, command, finding.description))

    if (answer === 'allow') {
      return undefined
    }
    if (answer === 'allow-session') {
      const memory = runtime.loader.raw('memory') ?? {}
      await runtime.loader.save('memory', {
        ...memory,
        permissionGate: {
          ...memory.permissionGate,
          allowedPatterns: [
            ...(memory.permissionGate?.allowedPatterns ?? []),
            sessionGrant(command)
          ]
        }
      })
      return undefined
    }
    const stopped = answer === 'stop'
    const reason = stopped
      ? 'User declined and stopped dangerous command'
      : 'User denied dangerous command'
    emitBlocked(pi, {
      feature: 'permissionGate',
      action,
      reason,
      block: { source: stopped ? 'user-stop' : 'user', metadata },
      context: { toolName: 'bash', input }
    })
    if (stopped) {
      ctx.abort()
    }
    return { block: true, reason }
  })
}
