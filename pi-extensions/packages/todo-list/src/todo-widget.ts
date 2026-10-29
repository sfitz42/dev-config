import { truncateToWidth } from '@earendil-works/pi-tui'

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'

import type { TodoItem, TodoStatus } from './todo-types.ts'

const WIDGET_KEY = 'todo-list'

const STATUS_ICONS: Readonly<Record<TodoStatus, string>> = {
  completed: '✓',
  'in-progress': '◉',
  'not-started': '○'
}

function formatTitle (todo: TodoItem, theme: Theme): string {
  switch (todo.status) {
    case 'completed':
      return theme.fg('dim', theme.strikethrough(todo.title))
    case 'in-progress':
      return theme.fg('warning', todo.title)
    case 'not-started':
      return todo.title
  }
}

/**
 * Builds the widget lines for a todo list.
 *
 * @param todos - The current list; must not be empty.
 * @param theme - The active theme.
 * @returns One header line, then one line per item.
 */
function widgetLines (todos: readonly TodoItem[], theme: Theme): string[] {
  const completed = todos.filter((todo) => todo.status === 'completed').length
  const header = theme.fg('accent', ' Todo List ') +
    theme.fg('muted', `— ${completed}/${todos.length} completed`)
  const items = todos.map((todo) => {
    const id = theme.fg('accent', `${todo.id}.`)
    return `  ${STATUS_ICONS[todo.status]} ${id} ${formatTitle(todo, theme)}`
  })
  return [header, ...items]
}

/**
 * Shows the list above the editor, or hides the widget when it is empty.
 *
 * @param todos - The current list.
 * @param ctx - The context of the event, command or tool call.
 */
function showTodoWidget (
  todos: readonly TodoItem[],
  ctx: ExtensionContext
): void {
  if (todos.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined)
    return
  }
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
    const lines = widgetLines(todos, theme)
    return {
      render: (width: number): string[] =>
        lines.map((line) => truncateToWidth(line, width)),
      invalidate: (): void => {}
    }
  })
}

export { showTodoWidget, STATUS_ICONS, widgetLines }
