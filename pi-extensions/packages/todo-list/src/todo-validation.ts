import { TODO_STATUSES } from './todo-types.ts'

import type { TodoItem, TodoStatus } from './todo-types.ts'

interface ValidationResult {
  readonly todos: readonly TodoItem[]
  readonly errors: readonly string[]
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus (value: unknown): value is TodoStatus {
  return TODO_STATUSES.some((status) => status === value)
}

function isNonEmptyString (value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function parseItem (
  item: unknown,
  label: string,
  seenIds: Set<number>
): TodoItem | string[] {
  if (!isRecord(item)) {
    return [`${label}: must be an object`]
  }

  const { id, title, description, status } = item
  const errors: string[] = []
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
    errors.push(`${label}: 'id' must be a positive integer`)
  } else if (seenIds.has(id)) {
    errors.push(`${label}: duplicate 'id' ${id}`)
  }
  if (!isNonEmptyString(title)) {
    errors.push(`${label}: 'title' must be a non-empty string`)
  }
  if (!isNonEmptyString(description)) {
    errors.push(`${label}: 'description' must be a non-empty string`)
  }
  if (!isStatus(status)) {
    errors.push(
      `${label}: 'status' must be one of: ${TODO_STATUSES.join(', ')}`
    )
  }

  if (errors.length > 0 || typeof id !== 'number' ||
    !isNonEmptyString(title) || !isNonEmptyString(description) ||
    !isStatus(status)) {
    return errors
  }
  seenIds.add(id)
  return { id, title, description, status }
}

/**
 * Checks a candidate todo list and returns a copy of it when valid.
 *
 * @param value - The list as received (from the model or session history).
 * @returns The validated items, or every problem found. `todos` is empty
 *   whenever `errors` is not.
 */
function validateTodos (value: unknown): ValidationResult {
  if (!Array.isArray(value)) {
    return { todos: [], errors: ['todoList must be an array'] }
  }

  const errors: string[] = []
  const todos: TodoItem[] = []
  const seenIds = new Set<number>()
  value.forEach((item: unknown, index) => {
    const parsed = parseItem(item, `Item ${index + 1}`, seenIds)
    if (Array.isArray(parsed)) {
      errors.push(...parsed)
    } else {
      todos.push(parsed)
    }
  })

  return errors.length > 0 ? { todos: [], errors } : { todos, errors }
}

export { isRecord, validateTodos }
export type { ValidationResult }
