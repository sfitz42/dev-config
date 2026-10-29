import { describe, expect, test } from 'vitest'

import {
  batchNonInteractiveMessage,
  buildCommentPrompt,
  createFreeformResponse,
  createSelectionResponse,
  formatBatchAnswers,
  formatResponseSummary,
  nonInteractiveMessage,
  parseDialogSelections,
  withContext
} from '../src/answer-format.ts'

describe('responses', () => {
  test('freeform text is trimmed; blank is a cancel', () => {
    expect(createFreeformResponse(' hi ')).toEqual({ kind: 'freeform', text: 'hi' })
    expect(createFreeformResponse('  ')).toBeNull()
    expect(createFreeformResponse(undefined)).toBeNull()
  })

  test('selections drop blanks; a blank comment is omitted', () => {
    expect(createSelectionResponse([' A ', ''], '  '))
      .toEqual({ kind: 'selection', selections: ['A'] })
    expect(createSelectionResponse(['A'], ' why '))
      .toEqual({ kind: 'selection', selections: ['A'], comment: 'why' })
    expect(createSelectionResponse([' '])).toBeNull()
  })

  test('summaries', () => {
    expect(formatResponseSummary({ kind: 'freeform', text: 'mine' })).toBe('mine')
    expect(formatResponseSummary({
      kind: 'selection', selections: ['A', 'B'], comment: 'both'
    })).toBe('A, B — both')
  })
})

describe('dialog text', () => {
  test('context block and comment prompt', () => {
    expect(withContext('Q?', 'ctx')).toBe('Q?\n\nContext:\nctx')
    expect(withContext('Q?', undefined)).toBe('Q?')
    expect(buildCommentPrompt('Q?', ['A'])).toBe('Q?\n\nSelected option:\n- A')
    expect(buildCommentPrompt('Q?', ['A', 'B']))
      .toBe('Q?\n\nSelected options:\n- A\n- B')
  })

  test('comma-separated selections', () => {
    expect(parseDialogSelections(' A, ,B ')).toEqual(['A', 'B'])
  })
})

describe('non-interactive messages', () => {
  test('single question lists everything the model needs', () => {
    expect(nonInteractiveMessage('Q?', 'ctx',
      [{ title: 'A', description: 'first' }, { title: 'B' }], true, true))
      .toBe('Ask requires interactive mode. Please answer:\n\nQ?\n\n' +
        'Context:\nctx\n\nOptions:\n1. A — first\n2. B\n\n' +
        'You can also answer freely.\n\n' +
        'After choosing an option, you may add an optional comment.')
  })

  test('batch lists each question with indented detail', () => {
    expect(batchNonInteractiveMessage([
      {
        question: 'One?',
        context: 'line1\nline2',
        options: [{ title: 'A' }],
        allowMultiple: true,
        allowFreeform: true
      },
      { question: 'Two?', options: [], allowMultiple: false, allowFreeform: true }
    ], false, 'Heading')).toBe(
      'Ask requires interactive mode. Please answer these questions:\n\n' +
      'Heading\n\n' +
      '1. One?\n   Context: line1\n   line2\n' +
      '   Options (choose one or more):\n   1. A\n' +
      '   You can also answer freely.\n\n2. Two?')
  })
})

describe('formatBatchAnswers', () => {
  test('counts answers and marks skips', () => {
    expect(formatBatchAnswers({
      kind: 'batch',
      heading: 'Setup',
      questions: [
        { question: 'One?', options: [] },
        { question: 'Two?', options: [] }
      ],
      answers: [
        { status: 'answered', response: { kind: 'freeform', text: 'x' } },
        { status: 'skipped' }
      ],
      cancelled: false
    })).toBe('Setup\nUser answered 1 of 2 questions:\n' +
      '1. One? → x\n2. Two? → (skipped)')
  })
})
