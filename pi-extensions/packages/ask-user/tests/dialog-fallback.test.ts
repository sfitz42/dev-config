import { describe, expect, test } from 'vitest'

import {
  askBatchViaDialogs,
  askViaDialogs,
  FREEFORM_CHOICE,
  stageOptions
} from '../src/dialog-fallback.ts'

import type { DialogQuestion, DialogUI } from '../src/dialog-fallback.ts'

interface Call {
  readonly kind: 'select' | 'input'
  readonly title: string
  readonly choices?: readonly string[]
}

/** A dialog UI that answers from a script and records what it was asked. */
function scriptedUI (answers: ReadonlyArray<string | undefined>): {
  ui: DialogUI
  calls: Call[]
} {
  const queue = [...answers]
  const calls: Call[] = []
  const ui: DialogUI = {
    select: async (title, choices) => {
      calls.push({ kind: 'select', title, choices })
      return queue.shift()
    },
    input: async (title) => {
      calls.push({ kind: 'input', title })
      return queue.shift()
    }
  }
  return { ui, calls }
}

const base: DialogQuestion = {
  question: 'Pick?',
  options: [{ title: 'A' }, { title: 'B' }],
  allowMultiple: false,
  allowFreeform: true,
  allowComment: false
}

describe('stageOptions', () => {
  test('passes options through without a deadline', () => {
    expect(stageOptions({ timeout: 5 }, undefined)).toEqual({ timeout: 5 })
  })

  test('gives each stage the time left, or null when out of time', () => {
    expect(stageOptions(undefined, 1500, 1000)).toEqual({ timeout: 500 })
    expect(stageOptions(undefined, 1000, 1000)).toBeNull()
  })
})

describe('askViaDialogs', () => {
  test('single select offers the freeform choice', async () => {
    const { ui, calls } = scriptedUI(['B'])
    expect(await askViaDialogs(ui, base))
      .toEqual({ kind: 'selection', selections: ['B'] })
    expect(calls[0]?.choices).toEqual(['A', 'B', FREEFORM_CHOICE])
  })

  test('the freeform choice opens an input', async () => {
    const { ui } = scriptedUI([FREEFORM_CHOICE, ' my own '])
    expect(await askViaDialogs(ui, base))
      .toEqual({ kind: 'freeform', text: 'my own' })
  })

  test('a comment follows when allowed; empty skips it', async () => {
    const { ui, calls } = scriptedUI(['A', ''])
    expect(await askViaDialogs(ui, { ...base, allowComment: true }))
      .toEqual({ kind: 'selection', selections: ['A'] })
    expect(calls[1]?.title).toBe('Pick?\n\nSelected option:\n- A')
  })

  test('cancelling the comment cancels the answer', async () => {
    const { ui } = scriptedUI(['A', undefined])
    expect(await askViaDialogs(ui, { ...base, allowComment: true })).toBeNull()
  })

  test('multi-select parses a comma list', async () => {
    const { ui, calls } = scriptedUI(['A, B'])
    expect(await askViaDialogs(ui, { ...base, allowMultiple: true }))
      .toEqual({ kind: 'selection', selections: ['A', 'B'] })
    expect(calls[0]?.title)
      .toBe('Pick?\n\nOptions (select one or more):\n1. A\n2. B')
  })

  test('an aborted signal asks nothing', async () => {
    const { ui, calls } = scriptedUI(['A'])
    const controller = new AbortController()
    controller.abort()
    expect(await askViaDialogs(ui, base, { signal: controller.signal }))
      .toBeNull()
    expect(calls).toEqual([])
  })
})

describe('askBatchViaDialogs', () => {
  const questions = [
    { question: 'One?', options: [{ title: 'A' }], allowMultiple: false, allowFreeform: false },
    { question: 'Two?', context: 'ctx', options: [], allowMultiple: false, allowFreeform: true }
  ]

  test('asks each question in turn with its position', async () => {
    const { ui, calls } = scriptedUI(['A', 'free text'])
    expect(await askBatchViaDialogs(ui, questions, false, undefined,
      undefined, 'Head')).toEqual([
      { status: 'answered', response: { kind: 'selection', selections: ['A'] } },
      { status: 'answered', response: { kind: 'freeform', text: 'free text' } }
    ])
    expect(calls.map((call) => call.title)).toEqual([
      'Head\n(1/2) One?',
      'Head\n(2/2) Two?\n\nContext:\nctx'
    ])
  })

  test('cancelling one question cancels the batch', async () => {
    const { ui } = scriptedUI(['A', undefined])
    expect(await askBatchViaDialogs(ui, questions, false, undefined,
      undefined, undefined)).toBeNull()
  })
})
