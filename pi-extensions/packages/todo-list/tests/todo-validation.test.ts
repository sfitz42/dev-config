import { describe, expect, test } from 'vitest'

import { validateTodos } from '../src/todo-validation.ts'

const item = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 1,
  title: 'Write the parser',
  description: 'Tokenise input in src/parser.ts',
  status: 'not-started',
  ...overrides
})

describe('validateTodos', () => {
  test('accepts a valid list and copies it', () => {
    const input = [item(), item({ id: 2, status: 'completed' })]
    const { todos, errors } = validateTodos(input)
    expect(errors).toEqual([])
    expect(todos).toHaveLength(2)
    expect(todos[0]).not.toBe(input[0])
  })

  test('accepts an empty list', () => {
    expect(validateTodos([])).toEqual({ todos: [], errors: [] })
  })

  test('allows several items in progress', () => {
    const input = [
      item({ status: 'in-progress' }),
      item({ id: 2, status: 'in-progress' })
    ]
    expect(validateTodos(input).errors).toEqual([])
  })

  test('rejects a non-array', () => {
    expect(validateTodos({}).errors).toEqual(['todoList must be an array'])
  })

  test.each([
    ['a missing id', { id: undefined }, "'id' must be a positive integer"],
    ['a string id', { id: '1' }, "'id' must be a positive integer"],
    ['a fractional id', { id: 1.5 }, "'id' must be a positive integer"],
    ['a zero id', { id: 0 }, "'id' must be a positive integer"],
    ['an empty title', { title: ' ' }, "'title' must be a non-empty string"],
    ['a missing description', { description: undefined },
      "'description' must be a non-empty string"],
    ['an unknown status', { status: 'blocked' },
      "'status' must be one of: not-started, in-progress, completed"]
  ])('rejects %s', (_name, overrides, message) => {
    const { todos, errors } = validateTodos([item(overrides)])
    expect(todos).toEqual([])
    expect(errors).toEqual([`Item 1: ${message}`])
  })

  test('rejects duplicate ids', () => {
    const { errors } = validateTodos([item(), item()])
    expect(errors).toEqual(["Item 2: duplicate 'id' 1"])
  })

  test('reports every problem across items', () => {
    const { errors } = validateTodos([item({ title: '' }), 'nope'])
    expect(errors).toEqual([
      "Item 1: 'title' must be a non-empty string",
      'Item 2: must be an object'
    ])
  })
})
