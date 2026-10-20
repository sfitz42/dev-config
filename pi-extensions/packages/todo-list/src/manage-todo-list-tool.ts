import { StringEnum } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

import { TOOL_NAME } from './todo-store.ts'
import { TODO_STATUSES } from './todo-types.ts'
import { validateTodos } from './todo-validation.ts'
import { showTodoWidget, STATUS_ICONS } from './todo-widget.ts'

import type {
  AgentToolResult,
  Theme,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { Static } from 'typebox'

import type { TodoStore } from './todo-store.ts'
import type { TodoDetails, TodoItem } from './todo-types.ts'

const SMALL_LIST_SIZE = 3

const DESCRIPTION = `Keep a structured todo list for multi-step work, so the user can follow your plan and progress.

Use it when:
- a task needs several steps, or the user gives you several tasks at once
- new instructions add steps to the current work
- you start a todo (mark it in-progress) or finish one (mark it completed straight away, one at a time)

Skip it for single trivial steps, conversation, or simple lookups.

Workflow: write the list with specific, actionable items; mark an item in-progress before working on it; mark it completed as soon as it is done; move to the next.

Statuses: not-started, in-progress (several allowed for parallel work), completed.

Writes replace the whole list: always send every item, existing and new.`

const todoItemSchema = Type.Object({
  id: Type.Number({
    description: 'Unique id; number items sequentially from 1.'
  }),
  title: Type.String({
    description: 'Short, action-oriented label (3-7 words) shown in the UI.'
  }),
  description: Type.String({
    description: 'Detail: context, file paths, methods or acceptance criteria.'
  }),
  status: StringEnum(TODO_STATUSES, {
    description: 'not-started | in-progress | completed'
  })
})

const parametersSchema = Type.Object({
  operation: StringEnum(['write', 'read'] as const, {
    description: 'write: replace the whole list. read: return the current list.'
  }),
  todoList: Type.Optional(Type.Array(todoItemSchema, {
    description: 'The complete list, every item included. Required for write; ignored for read.'
  }))
})

type ManageTodoListParams = Static<typeof parametersSchema>

type TodoResult = AgentToolResult<TodoDetails>

function textResult (
  text: string,
  details: TodoDetails,
  isError = false
): TodoResult {
  return { content: [{ type: 'text', text }], details, isError }
}

function readTodos (store: TodoStore): TodoResult {
  const todos = store.read()
  const text = todos.length > 0
    ? JSON.stringify(todos, null, 2)
    : 'No todos. Use the write operation to create a todo list.'
  return textResult(text, { operation: 'read', todos })
}

function writeTodos (store: TodoStore, input: unknown): TodoResult {
  if (input === undefined) {
    return textResult('Error: todoList is required for the write operation.', {
      operation: 'write',
      todos: store.read(),
      error: 'todoList is required'
    }, true)
  }

  const { todos, errors } = validateTodos(input)
  if (errors.length > 0) {
    const list = errors.map((error) => `  - ${error}`).join('\n')
    return textResult(`Validation failed:\n${list}`, {
      operation: 'write',
      todos: store.read(),
      error: errors.join('; ')
    }, true)
  }

  store.replace(todos)
  const { completed, total } = store.stats()
  let text = `Todo list updated: ${completed}/${total} completed. ` +
    'Keep it current as you work, and carry on with the next task.'
  if (todos.length < SMALL_LIST_SIZE) {
    text += `\n\nNote: fewer than ${SMALL_LIST_SIZE} items; this task may not need a todo list.`
  }
  return textResult(text, { operation: 'write', todos })
}

function statusIcon (todo: TodoItem, theme: Theme): string {
  const icon = STATUS_ICONS[todo.status]
  switch (todo.status) {
    case 'completed':
      return theme.fg('success', icon)
    case 'in-progress':
      return theme.fg('warning', icon)
    case 'not-started':
      return theme.fg('dim', icon)
  }
}

function itemTitle (todo: TodoItem, theme: Theme): string {
  switch (todo.status) {
    case 'completed':
      return theme.fg('dim', todo.title)
    case 'in-progress':
      return theme.fg('warning', todo.title)
    case 'not-started':
      return theme.fg('muted', todo.title)
  }
}

function renderCall (args: ManageTodoListParams, theme: Theme): Text {
  let text = theme.fg('toolTitle', theme.bold(`${TOOL_NAME} `)) +
    theme.fg('muted', args.operation)
  if (args.operation === 'write' && args.todoList !== undefined) {
    const count = args.todoList.length
    text += theme.fg('dim', ` (${count} item${count === 1 ? '' : 's'})`)
  }
  return new Text(text, 0, 0)
}

function renderResult (
  result: TodoResult,
  expanded: boolean,
  theme: Theme
): Text {
  const { error, todos } = result.details
  if (error !== undefined) {
    return new Text(theme.fg('error', `✗ ${error}`), 0, 0)
  }
  if (todos.length === 0) {
    return new Text(theme.fg('dim', 'No todos'), 0, 0)
  }

  const completed = todos.filter((todo) => todo.status === 'completed').length
  let text = theme.fg('success', '✓ ') +
    theme.fg('muted', `${completed}/${todos.length} completed`)
  if (expanded) {
    for (const todo of todos) {
      const id = theme.fg('accent', `${todo.id}.`)
      text += `\n  ${statusIcon(todo, theme)} ${id} ${itemTitle(todo, theme)}`
    }
  }
  return new Text(text, 0, 0)
}

/**
 * Creates the `manage_todo_list` tool.
 *
 * @param store - The list the tool reads and replaces.
 * @returns The tool definition to register with Pi.
 */
function createManageTodoListTool (
  store: TodoStore
): ToolDefinition<typeof parametersSchema, TodoDetails> {
  return defineTool({
    name: TOOL_NAME,
    label: 'Todo List',
    description: DESCRIPTION,
    parameters: parametersSchema,
    // Calls share the in-memory list, so they must not interleave.
    executionMode: 'sequential',
    async execute (_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.operation === 'read') {
        return readTodos(store)
      }
      const result = writeTodos(store, params.todoList)
      showTodoWidget(store.read(), ctx)
      return result
    },
    renderCall: (args, theme) => renderCall(args, theme),
    renderResult: (result, { expanded }, theme) =>
      renderResult(result, expanded, theme)
  })
}

export { createManageTodoListTool, readTodos, writeTodos }
