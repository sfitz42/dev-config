import { describe, expect, test } from 'vitest'

import {
  batchHeading,
  coerceOption,
  normalizeBatchQuestions,
  normalizeContext,
  normalizeOptions
} from '../src/ask-params.ts'

describe('coerceOption', () => {
  test.each([
    ['a string', ' Yes ', { title: 'Yes' }],
    ['a number', 3, { title: '3' }],
    ['a boolean', true, { title: 'true' }],
    ['an object with title', { title: 'A', description: 'why' },
      { title: 'A', description: 'why' }],
    ['a label key', { label: 'B' }, { title: 'B' }],
    ['a value key', { value: 'C' }, { title: 'C' }],
    ['a blank description', { title: 'D', description: '  ' }, { title: 'D' }]
  ])('accepts %s', (_name, input, expected) => {
    expect(coerceOption(input)).toEqual(expected)
  })

  test.each([
    ['a blank string', '  '],
    ['null', null],
    ['an object without a title', { description: 'x' }],
    ['a blank title', { title: ' ' }]
  ])('rejects %s', (_name, input) => {
    expect(coerceOption(input)).toBeNull()
  })
})

describe('normalizeOptions', () => {
  test('returns no options when none are sent', () => {
    expect(normalizeOptions(undefined, 'options')).toEqual([])
  })

  test('drops unusable options and repeated titles', () => {
    expect(normalizeOptions(['A', '', { title: 'A' }, 'B'], 'options'))
      .toEqual([{ title: 'A' }, { title: 'B' }])
  })

  test('fails when every option is unusable', () => {
    expect(() => normalizeOptions([{}, ' '], 'options'))
      .toThrow(/All 2 option\(s\) in options were malformed/)
  })

  test('fails when options is not an array', () => {
    expect(() => normalizeOptions('A', 'questions[0].options'))
      .toThrow('questions[0].options must be an array.')
  })
})

describe('normalizeContext and batchHeading', () => {
  test('trim and drop blanks', () => {
    expect(normalizeContext('  note ')).toBe('note')
    expect(normalizeContext('  ')).toBeUndefined()
    expect(batchHeading({ question: ' Setup ' })).toBe('Setup')
    expect(batchHeading({})).toBeUndefined()
  })
})

describe('normalizeBatchQuestions', () => {
  const two = [{ question: 'One?' }, { question: 'Two?' }]

  test('fills defaults per entry', () => {
    expect(normalizeBatchQuestions({
      questions: [
        { question: ' One? ', context: ' c ', options: ['A'] },
        { question: 'Two?', allowMultiple: true, allowFreeform: false }
      ]
    })).toEqual([
      {
        question: 'One?',
        context: 'c',
        options: [{ title: 'A' }],
        allowMultiple: false,
        allowFreeform: true
      },
      { question: 'Two?', options: [], allowMultiple: true, allowFreeform: false }
    ])
  })

  test('rejects per-entry fields at the top level', () => {
    expect(() => normalizeBatchQuestions({ questions: two, options: ['A'] }))
      .toThrow(/options cannot be set at the top level/)
  })

  test.each([
    [1, /needs 2-4 entries but got 1/],
    [5, /at most 4 entries but got 5/]
  ])('rejects %i entries', (count, message) => {
    const questions = Array.from({ length: count },
      (_, index) => ({ question: `Q${index}?` }))
    expect(() => normalizeBatchQuestions({ questions })).toThrow(message)
  })

  test('rejects blank and repeated questions', () => {
    expect(() => normalizeBatchQuestions({
      questions: [{ question: 'One?' }, { question: ' ' }]
    })).toThrow('questions[1].question must be a non-empty string.')
    expect(() => normalizeBatchQuestions({
      questions: [{ question: 'One?' }, { question: 'one?' }]
    })).toThrow(/questions\[1\] repeats the question/)
  })
})
