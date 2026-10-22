import { homedir } from 'node:os'

import { getAgentDir } from '@earendil-works/pi-coding-agent'

import { ConfigLoader } from './config/config-loader.ts'
import { CONFIG_CHANGED } from './events.ts'

import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

import type { ConfigFiles } from './config/config-loader.ts'
import type { RawConfig } from './config/config-migrations.ts'

const SHARED_MEMORY = Symbol.for('@dev-config/pi-guardrails/memory')

/**
 * Session-only settings, shared by the four guardrails extensions in this
 * process and keyed by Pi session, so a new session starts clean.
 */
function sharedMemory (): Map<string, RawConfig> {
  const holder = globalThis as Record<symbol, unknown>
  const existing = holder[SHARED_MEMORY]
  if (existing instanceof Map) {
    return existing as Map<string, RawConfig>
  }
  const created = new Map<string, RawConfig>()
  holder[SHARED_MEMORY] = created
  return created
}

interface Runtime {
  readonly loader: ConfigLoader
  /** Loads config for this context if it has not been loaded yet. */
  ensureLoaded: (ctx: ExtensionContext) => Promise<void>
  /** Saves happened elsewhere; reload and tell the other extensions. */
  notifyChanged: () => void
}

interface RuntimeOptions {
  readonly agentDir?: string
  readonly home?: string
  readonly files?: ConfigFiles
  /** Reports loader messages (migrations, ignored files). */
  readonly report?: (ctx: ExtensionContext, messages: string[]) => void
}

/**
 * Per-extension config state. Each guardrails extension owns a loader;
 * they stay in step through the config-changed event.
 *
 * @param pi - The extension API.
 * @param options - Overrides for tests.
 * @returns Access to the loader.
 */
function createRuntime (
  pi: ExtensionAPI,
  options: RuntimeOptions = {}
): Runtime {
  let sessionId = ''
  const shared = sharedMemory()
  const loader = new ConfigLoader({
    agentDir: options.agentDir ?? getAgentDir(),
    home: options.home ?? homedir(),
    files: options.files,
    memory: {
      get: () => shared.get(sessionId),
      set: (config) => { shared.set(sessionId, config) }
    }
  })
  let lastContext: ExtensionContext | undefined

  const load = async (ctx: ExtensionContext): Promise<void> => {
    lastContext = ctx
    sessionId = ctx.sessionManager.getSessionId()
    await loader.load({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() })
    const messages = loader.drainMessages()
    if (messages.length > 0) {
      options.report?.(ctx, messages)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    await load(ctx)
  })
  const stop = pi.events.on(CONFIG_CHANGED, () => {
    if (lastContext !== undefined) {
      load(lastContext).catch(() => undefined)
    }
  })
  pi.on('session_shutdown', () => stop())

  return {
    loader,
    ensureLoaded: async (ctx) => {
      if (!loader.isLoaded) {
        await load(ctx)
      }
    },
    notifyChanged: () => {
      pi.events.emit(CONFIG_CHANGED, { source: 'guardrails' })
    }
  }
}

export { createRuntime }
export type { Runtime, RuntimeOptions }
