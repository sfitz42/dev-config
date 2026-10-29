const TODO_STATUSES = ['not-started', 'in-progress', 'completed'] as const

type TodoStatus = typeof TODO_STATUSES[number]

type TodoOperation = 'read' | 'write'

interface TodoItem {
  readonly id: number
  readonly title: string
  readonly description: string
  readonly status: TodoStatus
}

/** Stored in each tool result; the session history is the persisted state. */
interface TodoDetails {
  readonly operation: TodoOperation
  readonly todos: readonly TodoItem[]
  readonly error?: string
}

interface TodoStats {
  readonly total: number
  readonly completed: number
  readonly inProgress: number
  readonly notStarted: number
}

export { TODO_STATUSES }
export type { TodoDetails, TodoItem, TodoOperation, TodoStats, TodoStatus }
