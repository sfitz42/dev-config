import { describe, expect, test } from 'vitest'

import { CLEAR_ENTRY_TYPE, TodoStore, TOOL_NAME } from '../src/todo-store.ts'

import type { SessionEntry } from '@earendil-works/pi-coding-agent'

import type { TodoItem } from '../src/todo-types.ts'

const todo = (id: number, status: TodoItem['status']): TodoItem => ({
  id, title: `Task ${id}`, description: `Detail ${id}`, status
})

let nextEntryId = 0

function toolResult (details: unknown, toolName = TOOL_NAME): SessionEntry {
  nextEntryId += 1
  // Only the fields restore() reads; the rest of the entry is irrelevant.
  return {
    type: 'message',
    id: `e${nextEntryId}`,
    parentId: null,
    timestamp: '2026-10-20T00:00:00.000Z',
    message: {
      role: 'toolResult',
      toolCallId: `c${nextEntryId}`,
      toolName,
      content: [],
      details,
      isError: false,
      timestamp: 0
    }
  } as unknown as SessionEntry
}

function clearEntry (): SessionEntry {
  nextEntryId += 1
  return {
    type: 'custom',
    id: `e${nextEntryId}`,
    parentId: null,
    timestamp: '2026-10-20T00:00:00.000Z',
    customType: CLEAR_ENTRY_TYPE
  }
}

describe('TodoStore', () => {
  test('counts items by status', () => {
    const store = new TodoStore()
    store.replace([
      todo(1, 'completed'),
      todo(2, 'in-progress'),
      todo(3, 'not-started'),
      todo(4, 'completed')
    ])
    expect(store.stats()).toEqual({
      total: 4, completed: 2, inProgress: 1, notStarted: 1
    })
  })

  test('restores the latest todo list on the branch', () => {
    const store = new TodoStore()
    store.restore([
      toolResult({ operation: 'write', todos: [todo(1, 'not-started')] }),
      toolResult({ operation: 'write', todos: [todo(1, 'completed')] })
    ])
    expect(store.read()).toEqual([todo(1, 'completed')])
  })

  test('a clear entry empties the restored list', () => {
    const store = new TodoStore()
    store.restore([
      toolResult({ operation: 'write', todos: [todo(1, 'completed')] }),
      clearEntry()
    ])
    expect(store.read()).toEqual([])
  })

  test('a write after a clear is restored', () => {
    const store = new TodoStore()
    store.restore([
      clearEntry(),
      toolResult({ operation: 'write', todos: [todo(2, 'not-started')] })
    ])
    expect(store.read()).toEqual([todo(2, 'not-started')])
  })

  test('ignores malformed details and other tools', () => {
    const store = new TodoStore()
    store.restore([
      toolResult({ operation: 'write', todos: [todo(1, 'completed')] }),
      toolResult({ todos: [{ id: 'x' }] }),
      toolResult('not an object'),
      toolResult({ todos: [] }, 'other_tool')
    ])
    expect(store.read()).toEqual([todo(1, 'completed')])
  })

  test('restore starts from an empty list', () => {
    const store = new TodoStore()
    store.replace([todo(1, 'completed')])
    store.restore([])
    expect(store.read()).toEqual([])
  })
})
