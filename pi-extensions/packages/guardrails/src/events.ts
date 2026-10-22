import { randomUUID } from 'node:crypto'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import type { FeatureId } from './config/config-schema.ts'

const ACTION_BLOCKED = 'guardrails:action:blocked'
const RISK_DETECTED = 'guardrails:risk:detected'
const FEATURE_REQUEST = 'guardrails:feature:request'
const FEATURE_REGISTER = 'guardrails:feature:register'
const PROMPT_OPENED = 'guardrails:prompt:opened'
const PROMPT_CLOSED = 'guardrails:prompt:closed'
/** @deprecated Kept for listeners of earlier releases; use PROMPT_OPENED. */
const ACTION_PROMPTED = 'guardrails:action:prompted'
/** Settings were saved; every guardrails extension reloads its config. */
const CONFIG_CHANGED = 'guardrails:config:changed'

/** What a feature checked: a file access or a shell command. */
type GuardedAction =
  | { readonly kind: 'file', readonly path: string, readonly origin?: string }
  | { readonly kind: 'command', readonly command: string, readonly origin?: string }

type BlockSource = 'policy' | 'permission' | 'user' | 'user-stop' |
  'nonInteractive'

interface ToolContext {
  readonly toolName?: string
  readonly input?: Record<string, unknown>
}

interface BlockedEvent {
  readonly feature: FeatureId
  readonly action: GuardedAction
  readonly reason: string
  readonly block: { readonly source: BlockSource, readonly metadata?: unknown }
  readonly context?: ToolContext
}

interface PromptDetails {
  readonly feature: FeatureId
  readonly action: GuardedAction
  readonly reason: string
  readonly prompt: {
    readonly kind: 'confirmation' | 'permission'
    readonly metadata?: unknown
  }
  readonly context?: ToolContext
}

interface OpenedPrompt {
  readonly feature: FeatureId
  readonly id: string
}

function timestamp (): string {
  return new Date().toISOString()
}

function emitBlocked (pi: ExtensionAPI, event: BlockedEvent): void {
  pi.events.emit(ACTION_BLOCKED, {
    source: 'guardrails', timestamp: timestamp(), ...event
  })
}

function emitRiskDetected (
  pi: ExtensionAPI,
  event: {
    feature: FeatureId
    risk: { action: GuardedAction, reason: string, metadata?: unknown }
    context?: ToolContext
  }
): void {
  pi.events.emit(RISK_DETECTED, {
    source: 'guardrails',
    timestamp: timestamp(),
    feature: event.feature,
    risk: { kind: 'dangerous', key: event.feature, ...event.risk },
    context: event.context
  })
}

/**
 * Emits the prompt-opened event (and its deprecated alias), runs the
 * prompt, then always emits prompt-closed with the same id.
 *
 * @param pi - The extension API.
 * @param details - What is being asked.
 * @param ask - Shows the prompt and resolves with the answer.
 * @returns The answer.
 */
async function withPromptEvents<T> (
  pi: ExtensionAPI,
  details: PromptDetails,
  ask: () => Promise<T>
): Promise<T> {
  const opened: OpenedPrompt = { feature: details.feature, id: randomUUID() }
  const base = { source: 'guardrails', timestamp: timestamp() }
  pi.events.emit(PROMPT_OPENED, {
    ...base, ...details, prompt: { ...details.prompt, id: opened.id }
  })
  pi.events.emit(ACTION_PROMPTED, { ...base, ...details })
  try {
    return await ask()
  } finally {
    pi.events.emit(PROMPT_CLOSED, {
      source: 'guardrails',
      feature: opened.feature,
      timestamp: timestamp(),
      prompt: { id: opened.id }
    })
  }
}

/** Answers feature discovery requests from the settings command. */
function announceFeature (pi: ExtensionAPI, feature: FeatureId): void {
  const stop = pi.events.on(FEATURE_REQUEST, () => {
    pi.events.emit(FEATURE_REGISTER, {
      source: 'guardrails', timestamp: timestamp(), feature: { id: feature }
    })
  })
  pi.on('session_shutdown', () => stop())
}

export {
  ACTION_BLOCKED,
  ACTION_PROMPTED,
  announceFeature,
  CONFIG_CHANGED,
  emitBlocked,
  emitRiskDetected,
  FEATURE_REGISTER,
  FEATURE_REQUEST,
  PROMPT_CLOSED,
  PROMPT_OPENED,
  RISK_DETECTED,
  timestamp,
  withPromptEvents
}
export type { BlockedEvent, BlockSource, GuardedAction, PromptDetails }
