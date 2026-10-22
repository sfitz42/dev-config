import { describe, expect, test } from 'vitest'

import { createAskEvents } from '../src/ask-events.ts'
import { renderCallText, renderResultText } from '../src/result-render.ts'
import { askToolCard, choiceSheet } from '../src/tern.ts'
import { fakeTheme } from './fake-theme.ts'

import type { AskDetails } from '../src/ask-types.ts'

const view = (details: AskDetails | undefined, expanded = false): {
  details: AskDetails | undefined
  text: string
  isError: boolean
  isPartial: boolean
  expanded: boolean
} => ({ details, text: '', isError: false, isPartial: false, expanded })

describe('renderCallText', () => {
  test('single question with options and flags', () => {
    expect(renderCallText({
      question: 'Q?',
      options: ['A', {}],
      allowMultiple: true
    }, fakeTheme)).toBe('[toolTitle:*ask_user *][muted:Q?]\n' +
      '[dim:  2 option(s): A, <invalid>][dim: [multi-select]]')
  })

  test('batch lists entries', () => {
    expect(renderCallText({
      question: 'Head',
      questions: [{ question: 'One?', options: ['A'] }, { question: 'Two?' }]
    }, fakeTheme)).toBe('[toolTitle:*ask_user *][muted:2 questions]' +
      '[text: · Head]\n[dim:  1. One? (1 option(s))]\n[dim:  2. Two?]')
  })
})

describe('renderResultText', () => {
  const single: AskDetails = {
    question: 'Q?',
    context: 'ctx',
    options: [{ title: 'A', description: 'first' }, { title: 'B' }],
    response: { kind: 'selection', selections: ['A'], comment: 'note' },
    cancelled: false
  }

  test('errors and partial results', () => {
    expect(renderResultText({ ...view(undefined), isError: true, text: 'bad' },
      fakeTheme)).toBe('[error:✗ bad]')
    expect(renderResultText({ ...view(undefined), isPartial: true },
      fakeTheme)).toBe('[muted:Waiting for user input...]')
  })

  test('cancelled', () => {
    const cancelled = { ...single, cancelled: true, response: null }
    expect(renderResultText(view(cancelled), fakeTheme))
      .toBe('[warning:Cancelled]')
  })

  test('collapsed and expanded answers', () => {
    expect(renderResultText(view(single), fakeTheme))
      .toBe('[success:✓ ][accent:A — note]')
    expect(renderResultText(view(single, true), fakeTheme)).toBe(
      '[success:✓ ][accent:A — note]\n[dim:Q: Q?]\n[dim:ctx]\n' +
      '[dim:Options:]\n  [success:●] [dim:A][dim: — first]\n' +
      '  [dim:○] [dim:B][dim:]\n[dim:Comment:] [dim:note]')
  })

  test('batch with a skip', () => {
    expect(renderResultText(view({
      kind: 'batch',
      questions: [{ question: 'One?', options: [] }, { question: 'Two?', options: [] }],
      answers: [
        { status: 'answered', response: { kind: 'freeform', text: 'x' } },
        { status: 'skipped' }
      ],
      cancelled: false
    }), fakeTheme)).toBe('[success:✓ ][accent:1 of 2 answered]\n' +
      '[dim:1.] [muted:One?][dim: → ][muted:(wrote) ][accent:x]\n' +
      '[dim:2.] [muted:Two?][dim: → ][warning:(skipped)]')
  })
})

describe('createAskEvents', () => {
  const subject = { question: 'Q?', context: 'secret', options: [{ title: 'A' }] }
  const response = { kind: 'freeform' as const, text: 'private' }

  test('full events include context and the response', () => {
    const emitted: unknown[] = []
    const events = createAskEvents({
      events: {
        emit: (_channel, data) => emitted.push(data),
        on: () => () => {}
      }
    }, true)
    events.answered(subject, response)
    events.cancelled(subject, { index: 0, total: 2 })
    expect(emitted).toEqual([
      { question: 'Q?', context: 'secret', response },
      {
        question: 'Q?',
        context: 'secret',
        options: [{ title: 'A' }],
        batch: { index: 0, total: 2 }
      }
    ])
  })
})

describe('Tern', () => {
  test('the card checks the chosen option', () => {
    const card = askToolCard({
      name: 'ask_user',
      args: { question: 'Q?' },
      status: 'done',
      result: {
        details: {
          question: 'Q?',
          options: [{ title: 'A' }, { title: 'B' }],
          response: { kind: 'selection', selections: ['B'] },
          cancelled: false
        }
      }
    })
    expect(card?.p).toMatchObject({ title: 'Ask', target: 'Q?' })
    expect(card?.c.map((child) => child.p.role))
      .toEqual(['omp.tool.answer.off', 'omp.tool.answer'])
  })

  test('the card waits while running and skips errors', () => {
    const running = askToolCard({
      name: 'ask_user',
      args: { question: 'Q?', options: ['A'] },
      status: 'running',
      result: undefined
    })
    expect(running?.c.map((child) => child.key)).toEqual(['o0', 'waiting'])
    expect(askToolCard({
      name: 'ask_user', args: {}, status: 'error', result: undefined
    })).toBeUndefined()
  })

  test('the choice sheet marks the selected row and action bar', () => {
    const sheet = choiceSheet({
      question: 'Q?',
      rows: [
        { id: 'o0', kind: 'option', label: 'A' },
        { id: 'freeform', kind: 'freeform', label: 'Other' }
      ],
      selected: 1,
      multiple: false
    })
    const col = sheet.c[0]
    const list = col?.c.find((child) => child.key === 'options')
    expect(list?.p.selected).toBe('freeform')
    expect(list?.c.map((child) => child.p.role))
      .toEqual(['omp.ask.option', 'omp.ask.other'])
  })
})
