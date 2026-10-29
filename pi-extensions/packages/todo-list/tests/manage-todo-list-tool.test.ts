import { describe, expect, test } from 'vitest'

import { readTodos, writeTodos } from '../src/manage-todo-list-tool.ts'
import { TodoStore } from '../src/todo-store.ts'

import type { TodoItem } from '../src/todo-types.ts'

const todo = (id: number, status: TodoItem['status']): TodoItem => ({
  id, title: `Task ${id}`, description: `Detail ${id}`, status
})

const text = (result: { content: readonly unknown[] }): string => {
  const [first] = result.content
  return typeof first === 'object' && first !== null && 'text' in first
    ? String(first.text)
    : ''
}

describe('read', () => {
  test('hints at write when the list is empty', () => {
    const result = readTodos(new TodoStore())
    expect(text(result)).toMatch(/No todos/)
    expect(result.details).toEqual({ operation: 'read', todos: [] })
  })

  test('returns the list as JSON', () => {
    const store = new TodoStore()
    store.replace([todo(1, 'completed')])
    const result = readTodos(store)
    expect(JSON.parse(text(result))).toEqual([todo(1, 'completed')])
  })
})

describe('write', () => {
  test('replaces the whole list and reports progress', () => {
    const store = new TodoStore()
    store.replace([todo(9, 'not-started')])
    const list = [todo(1, 'completed'), todo(2, 'in-progress'),
      todo(3, 'not-started')]

    const result = writeTodos(store, list)

    expect(result.isError).toBe(false)
    expect(store.read()).toEqual(list)
    expect(text(result)).toMatch(/1\/3 completed/)
    expect(text(result)).not.toMatch(/fewer than 3/)
    expect(result.details).toEqual({ operation: 'write', todos: list })
  })

  test('notes a small list', () => {
    const result = writeTodos(new TodoStore(), [todo(1, 'not-started')])
    expect(text(result)).toMatch(/fewer than 3 items/)
  })

  test('requires todoList', () => {
    const store = new TodoStore()
    store.replace([todo(1, 'completed')])
    const result = writeTodos(store, undefined)
    expect(result.isError).toBe(true)
    expect(result.details.error).toBe('todoList is required')
    expect(store.read()).toEqual([todo(1, 'completed')])
  })

  test('leaves the list unchanged when validation fails', () => {
    const store = new TodoStore()
    store.replace([todo(1, 'completed')])
    const duplicate = [todo(1, 'completed'), todo(1, 'completed')]
    const result = writeTodos(store, duplicate)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/Validation failed:\n {2}- Item 2: duplicate/)
    expect(store.read()).toEqual([todo(1, 'completed')])
  })
})
