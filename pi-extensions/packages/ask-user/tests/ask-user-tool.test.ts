import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, test } from 'vitest'

import { createAskUserTool } from '../src/ask-user-tool.ts'
import { FREEFORM_CHOICE } from '../src/dialog-fallback.ts'

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'

interface Emitted {
  readonly channel: string
  readonly data: unknown
}

// Point preferences at a directory with no ask-user.json.
const env = { PI_CODING_AGENT_DIR: join(tmpdir(), 'ask-user-no-settings') }

function setup (answers: ReadonlyArray<string | undefined> = []): {
  tool: ReturnType<typeof createAskUserTool>
  emitted: Emitted[]
  ctx: (hasUI: boolean) => ExtensionToolContext
} {
  const emitted: Emitted[] = []
  const events = {
    emit: (channel: string, data: unknown): void => {
      emitted.push({ channel, data })
    },
    on: () => () => {}
  }
  const queue = [...answers]
  const ui = {
    // RPC mode: custom components are not available.
    custom: async () => undefined,
    select: async () => queue.shift(),
    input: async () => queue.shift(),
    notify: () => {},
    onTerminalInput: () => () => {}
  }
  // Only the fields the tool reads; the rest of the context is irrelevant.
  const ctx = (hasUI: boolean): ExtensionToolContext =>
    ({ hasUI, ui }) as unknown as ExtensionToolContext
  return { tool: createAskUserTool({ events }, env), emitted, ctx }
}

const text = (result: { content: readonly unknown[] }): string => {
  const [first] = result.content
  return typeof first === 'object' && first !== null && 'text' in first
    ? String(first.text)
    : ''
}

describe('ask_user', () => {
  test('is model-only and sequential', () => {
    const { tool } = setup()
    expect(tool.exposure).toBe('model-only')
    expect(tool.executionMode).toBe('sequential')
  })

  test('needs a question', async () => {
    const { tool, ctx } = setup()
    await expect(tool.execute('1', {}, undefined, undefined, ctx(true)))
      .rejects.toThrow(/needs question .* or questions/)
  })

  test('without UI, tells the model to ask in plain text', async () => {
    const { tool, ctx } = setup()
    await expect(tool.execute('1', {
      question: 'Proceed?', options: [{ title: 'Yes' }]
    }, undefined, undefined, ctx(false)))
      .rejects.toThrow(/Ask requires interactive mode[\s\S]*1\. Yes/)
  })

  test('falls back to dialogs and reports the answer', async () => {
    const { tool, ctx, emitted } = setup(['Yes'])
    const result = await tool.execute('1', {
      question: 'Proceed?', options: [{ title: 'Yes' }, { title: 'No' }]
    }, undefined, undefined, ctx(true))
    expect(text(result)).toBe('User answered: Yes')
    expect(result.details).toEqual({
      question: 'Proceed?',
      options: [{ title: 'Yes' }, { title: 'No' }],
      response: { kind: 'selection', selections: ['Yes'] },
      cancelled: false
    })
    expect(emitted).toEqual([
      {
        channel: 'herdr:blocked',
        data: { active: true, label: 'Waiting for user response' }
      },
      { channel: 'herdr:blocked', data: { active: false } },
      // Redacted by default: the question and the kind only.
      {
        channel: 'ask:answered',
        data: { question: 'Proceed?', response: { kind: 'selection' } }
      }
    ])
  })

  test('a question without options uses a text input', async () => {
    const { tool, ctx } = setup([' later '])
    const result = await tool.execute('1', { question: 'When?' },
      undefined, undefined, ctx(true))
    expect(text(result)).toBe('User answered: later')
  })

  test('a cancel is reported, not thrown', async () => {
    const { tool, ctx, emitted } = setup([undefined])
    const result = await tool.execute('1', {
      question: 'Proceed?', options: [{ title: 'Yes' }]
    }, undefined, undefined, ctx(true))
    expect(text(result)).toBe('User cancelled the question')
    expect(result.details).toMatchObject({ cancelled: true, response: null })
    expect(emitted.at(-1))
      .toEqual({ channel: 'ask:cancelled', data: { question: 'Proceed?' } })
  })

  test('an already-aborted call returns Cancelled', async () => {
    const { tool, ctx } = setup()
    const controller = new AbortController()
    controller.abort()
    const result = await tool.execute('1', { question: 'Q?' },
      controller.signal, undefined, ctx(true))
    expect(text(result)).toBe('Cancelled')
  })

  test('a batch asks each question and summarises', async () => {
    const { tool, ctx, emitted } = setup(['A', FREEFORM_CHOICE, 'mine'])
    const result = await tool.execute('1', {
      question: 'Setup',
      questions: [
        { question: 'One?', options: [{ title: 'A' }], allowFreeform: false },
        { question: 'Two?', options: [{ title: 'B' }] }
      ]
    }, undefined, undefined, ctx(true))
    expect(text(result)).toBe('Setup\nUser answered 2 of 2 questions:\n' +
      '1. One? → A\n2. Two? → mine')
    expect(result.details).toMatchObject({ kind: 'batch', heading: 'Setup' })
    expect(emitted.filter((event) => event.channel === 'ask:answered')
      .map((event) => event.data)).toEqual([
      {
        question: 'One?',
        response: { kind: 'selection' },
        batch: { index: 0, total: 2 }
      },
      {
        question: 'Two?',
        response: { kind: 'freeform' },
        batch: { index: 1, total: 2 }
      }
    ])
  })

  test('a malformed batch fails before any UI', async () => {
    const { tool, ctx, emitted } = setup()
    await expect(tool.execute('1', {
      questions: [{ question: 'Only?' }]
    }, undefined, undefined, ctx(true))).rejects.toThrow(/needs 2-4 entries/)
    expect(emitted).toEqual([])
  })
})
