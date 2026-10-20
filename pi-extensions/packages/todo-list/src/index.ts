import { createManageTodoListTool } from './manage-todo-list-tool.ts'
import { CLEAR_ENTRY_TYPE, TodoStore } from './todo-store.ts'
import { showTodoWidget } from './todo-widget.ts'

import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

/**
 * Pi entry point: the `manage_todo_list` tool, its widget and `/todos`.
 *
 * @param pi - The extension API for this runtime.
 */
export default function todoList (pi: ExtensionAPI): void {
  const store = new TodoStore()

  const restore = (ctx: ExtensionContext): void => {
    store.restore(ctx.sessionManager.getBranch())
    showTodoWidget(store.read(), ctx)
  }
  pi.on('session_start', (_event, ctx) => restore(ctx))
  pi.on('session_tree', (_event, ctx) => restore(ctx))

  pi.registerTool(createManageTodoListTool(store))

  pi.registerCommand('todos', {
    description: 'Show todo progress, or clear the list with /todos clear',
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === 'clear') {
        store.clear()
        pi.appendEntry(CLEAR_ENTRY_TYPE)
        showTodoWidget([], ctx)
        ctx.ui.notify('Todo list cleared.', 'info')
        return
      }

      const { completed, total } = store.stats()
      if (total === 0) {
        ctx.ui.notify(
          'No todos. The model creates them when working on multi-step tasks.',
          'info'
        )
        return
      }
      showTodoWidget(store.read(), ctx)
      ctx.ui.notify(`${completed}/${total} todos completed.`, 'info')
    }
  })
}
