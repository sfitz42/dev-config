import { homedir } from 'node:os'

import { getAgentDir } from '@earendil-works/pi-coding-agent'

import {
  emitBlocked,
  FEATURE_REGISTER,
  FEATURE_REQUEST,
  timestamp
} from './events.ts'
import { checkToolCall, redactGrepOutput } from './policies/policy-check.ts'
import {
  compilePolicies,
  selfProtectionPolicy
} from './policies/policy-rules.ts'
import { createRuntime } from './runtime.ts'
import { registerExamplesCommand } from './ui/examples-command.ts'
import { registerOnboardingCommand } from './ui/onboarding.ts'
import { registerSettingsCommand } from './ui/settings-command.ts'

import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

import type { FeatureId } from './config/config-schema.ts'
import type { CompiledPolicy } from './policies/policy-rules.ts'
import type { Runtime } from './runtime.ts'

const FEATURE_IDS = new Set<string>(['policies', 'permissionGate', 'pathAccess'])

function report (ctx: ExtensionContext, messages: string[]): void {
  ctx.ui.notify(messages.length === 1
    ? `Guardrails: ${messages[0] ?? ''}`
    : ['Guardrails:', ...messages.map((message) => `- ${message}`)].join('\n'),
  'warning')
}

function registeredFeature (data: unknown): FeatureId | undefined {
  if (typeof data !== 'object' || data === null || !('feature' in data)) {
    return undefined
  }
  const feature: unknown = data.feature
  if (typeof feature !== 'object' || feature === null || !('id' in feature)) {
    return undefined
  }
  return typeof feature.id === 'string' && FEATURE_IDS.has(feature.id)
    ? feature.id as FeatureId
    : undefined
}

/** Policies in force: configured rules when enabled, plus self-protection. */
function activePolicies (runtime: Runtime, agentDir: string): CompiledPolicy[] {
  const config = runtime.loader.config
  if (!config.enabled) {
    return []
  }
  const rules = config.features.policies
    ? compilePolicies(config.policies.rules)
    : []
  return [...rules, selfProtectionPolicy(agentDir)]
}

/**
 * Pi entry point: file protection policies and the guardrails commands.
 *
 * @param pi - The extension API.
 */
export default function guardrails (pi: ExtensionAPI): void {
  const runtime = createRuntime(pi, { report })
  const agentDir = getAgentDir()
  const home = homedir()
  const loaded = new Set<FeatureId>(['policies'])

  const stopRegister = pi.events.on(FEATURE_REGISTER, (data) => {
    const feature = registeredFeature(data)
    if (feature !== undefined) {
      loaded.add(feature)
    }
  })
  pi.on('session_shutdown', () => stopRegister())

  registerSettingsCommand(pi, runtime, () => loaded)
  registerExamplesCommand(pi, runtime)
  registerOnboardingCommand(pi, runtime)

  pi.on('session_start', () => {
    loaded.clear()
    loaded.add('policies')
    pi.events.emit(FEATURE_REQUEST, {
      source: 'guardrails', timestamp: timestamp()
    })
  })

  pi.on('tool_call', async (event, ctx) => {
    await runtime.ensureLoaded(ctx)
    const policies = activePolicies(runtime, agentDir)
    if (policies.length === 0) {
      return undefined
    }
    const input = event.input as Record<string, unknown>
    const match = checkToolCall(event.toolName, input, policies, {
      cwd: ctx.cwd, home, environment: process.env
    })
    if (match === undefined) {
      return undefined
    }
    emitBlocked(pi, {
      feature: 'policies',
      action: { kind: 'file', path: match.path, origin: event.toolName },
      reason: match.reason,
      block: { source: 'policy', metadata: match },
      context: { toolName: event.toolName, input }
    })
    return { block: true, reason: match.reason }
  })

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName !== 'grep') {
      return undefined
    }
    await runtime.ensureLoaded(ctx)
    const policies = activePolicies(runtime, agentDir)
    const searchPath = typeof event.input.path === 'string'
      ? event.input.path
      : undefined
    let changed = false
    const content = event.content.map((part) => {
      if (part.type !== 'text') {
        return part
      }
      const result = redactGrepOutput(part.text, searchPath, policies, {
        cwd: ctx.cwd, home
      })
      changed ||= result.redacted
      return { ...part, text: result.text }
    })
    return changed ? { content, structuredContent: undefined } : undefined
  })
}
