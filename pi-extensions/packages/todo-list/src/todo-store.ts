import { isRecord, validateTodos } from './todo-validation.ts'

import type { SessionEntry } from '@earendil-works/pi-coding-agent'

import type { TodoItem, TodoStats } from './todo-types.ts'

const TOOL_NAME = 'manage_todo_list'
const CLEAR_ENTRY_TYPE = 'todo-list-clear'

/** In-memory todo list, rebuilt from session history when it changes. */
class TodoStore {
  private todos: readonly TodoItem[] = []

  read (): readonly TodoItem[] {
    return this.todos
  }

  replace (todos: readonly TodoItem[]): void {
    this.todos = [...todos]
  }

  clear (): void {
    this.todos = []
  }

  stats (): TodoStats {
    const count = (status: TodoItem['status']): number =>
      this.todos.filter((todo) => todo.status === status).length
    return {
      total: this.todos.length,
      completed: count('completed'),
      inProgress: count('in-progress'),
      notStarted: count('not-started')
    }
  }

  /**
   * Rebuilds the list from a session branch: the latest valid tool result,
   * unless a clear entry comes after it.
   *
   * @param entries - The current branch, oldest first.
   */
  restore (entries: readonly SessionEntry[]): void {
    this.todos = []
    for (const entry of entries) {
      if (entry.type === 'custom' && entry.customType === CLEAR_ENTRY_TYPE) {
        this.todos = []
        continue
      }
      if (entry.type !== 'message') {
        continue
      }
      const { message } = entry
      if (message.role !== 'toolResult' || message.toolName !== TOOL_NAME) {
        continue
      }
      const details: unknown = message.details
      if (isRecord(details)) {
        const { todos, errors } = validateTodos(details.todos)
        if (errors.length === 0) {
          this.todos = todos
        }
      }
    }
  }
}

export { CLEAR_ENTRY_TYPE, TodoStore, TOOL_NAME }
