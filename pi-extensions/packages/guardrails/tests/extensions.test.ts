import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type Handler = (event: unknown, ctx: unknown) => unknown

/** A stand-in for Pi's ExtensionAPI: records handlers and runs an event bus. */
function fakePi (): {
  pi: ExtensionAPI
  fire: (name: string, event: unknown, ctx: unknown) => Promise<unknown[]>
  emitted: { channel: string, data: unknown }[]
  commands: string[]
} {
  const handlers = new Map<string, Handler[]>()
  const bus = new Map<string, ((data: unknown) => void)[]>()
  const emitted: { channel: string, data: unknown }[] = []
  const commands: string[] = []
  const api = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
      return () => {}
    },
    events: {
      on: (channel: string, handler: (data: unknown) => void) => {
        bus.set(channel, [...(bus.get(channel) ?? []), handler])
        return () => {}
      },
      emit: (channel: string, data: unknown) => {
        emitted.push({ channel, data })
        for (const handler of bus.get(channel) ?? []) {
          handler(data)
        }
      }
    },
    registerCommand: (name: string) => { commands.push(name) },
    appendEntry: () => {}
  }
  return {
    pi: api as unknown as ExtensionAPI,
    fire: async (name, event, ctx) => {
      const results: unknown[] = []
      for (const handler of handlers.get(name) ?? []) {
        results.push(await handler(event, ctx))
      }
      return results
    },
    emitted,
    commands
  }
}

let root: string
let previousAgentDir: string | undefined
let harness: ReturnType<typeof fakePi>
const notes: string[] = []

function context (): unknown {
  return {
    cwd: join(root, 'project'),
    hasUI: false,
    mode: 'print',
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'session-1' },
    ui: { notify: (message: string) => notes.push(message) },
    abort: () => {}
  }
}

async function call (toolName: string, input: Record<string, unknown>):
Promise<string> {
  const results = await harness.fire('tool_call',
    { type: 'tool_call', toolName, input, toolCallId: 't1' }, context())
  const block = results.find((result): result is { reason: string } =>
    typeof result === 'object' && result !== null && 'block' in result)
  return block?.reason ?? 'allowed'
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'guardrails-extensions-'))
  mkdirSync(join(root, 'project', '.pi', 'extensions'), { recursive: true })
  writeFileSync(join(root, 'project', '.env'), 'SECRET=1\n')
  // An untrusted project trying to switch guardrails off.
  writeFileSync(join(root, 'project', '.pi', 'extensions', 'guardrails.json'),
    JSON.stringify({ version: '0.19.0', enabled: false }))
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')

  harness = fakePi()
  for (const entry of [
    '../src/index.ts',
    '../src/path-access/index.ts',
    '../src/permission-gate/index.ts',
    '../src/herdr/index.ts'
  ]) {
    const module = await import(entry) as {
      default: (pi: ExtensionAPI) => void
    }
    module.default(harness.pi)
  }
  await harness.fire('session_start', { type: 'session_start' }, context())
})

afterAll(() => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }
  rmSync(root, { recursive: true, force: true })
})

describe('the four extensions together', () => {
  test('register the guardrails commands', () => {
    expect(harness.commands).toEqual([
      'guardrails:settings', 'guardrails:examples', 'guardrails:onboarding'
    ])
  })

  test('ignore the untrusted project config and say so', () => {
    expect(notes.join('\n')).toMatch(/not trusted/)
  })

  test('block a dangerous command without a UI', async () => {
    expect(await call('bash', { command: 'ls | xargs rm -rf' }))
      .toMatch(/no UI to confirm/)
  })

  test('block reading a secret file, however it is spelled', async () => {
    expect(await call('read', { path: '.env' })).toMatch(/contains secrets/)
    expect(await call('bash', { command: 'cat .e""nv' }))
      .toMatch(/contains secrets/)
  })

  test('block writes to the guardrails config', async () => {
    expect(await call('write', {
      path: '.pi/extensions/guardrails.json', content: '{}'
    })).toMatch(/controls Pi and guardrails/)
  })

  test('allow ordinary commands', async () => {
    expect(await call('bash', { command: 'ls -la' })).toBe('allowed')
  })

  test('announce loaded features on session start', () => {
    const registered = harness.emitted
      .filter((item) => item.channel === 'guardrails:feature:register')
      .map((item) => JSON.stringify(item.data))
    expect(registered.join(' ')).toMatch(/permissionGate/)
    expect(registered.join(' ')).toMatch(/pathAccess/)
  })

  test('redact protected lines from grep results', async () => {
    const results = await harness.fire('tool_result', {
      type: 'tool_result',
      toolName: 'grep',
      input: { pattern: 'SECRET' },
      content: [{ type: 'text', text: '.env:1: SECRET=1' }],
      isError: false
    }, context())
    expect(JSON.stringify(results)).toMatch(/redacted by guardrails/)
  })
})
