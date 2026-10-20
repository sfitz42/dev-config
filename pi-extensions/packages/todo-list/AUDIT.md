# todo-list: audit and spec

Inspired by [tintinweb/pi-manage-todo-list](https://github.com/tintinweb/pi-manage-todo-list)
0.4.0, commit `2eb22d3b0c9dd981398d928c8edcc4afce202fa1`, audited 2026-10-20.
This package is a new implementation written from the spec below; no upstream code or tests
were copied.

## Audit findings

| Severity | Finding | Handling here |
|---|---|---|
| None | No network, processes, filesystem, env, `eval` or dynamic imports. No runtime deps, no lifecycle scripts. | n/a |
| Low | Validation accepts duplicate and non-integer ids, while the docs promise sequential ids. | Ids must be unique positive integers. |
| Low | Docs say "at most one in-progress", the tool schema says several are allowed, and validation enforces neither. | Several allowed (matches the schema); docs agree. |
| Low | `/todos clear` only clears memory, so the list comes back after `/reload` or on resume. | Clearing appends a session entry that restore honours. |
| Low | The widget is redrawn through a context captured in an earlier event, which may be stale. | Uses the context passed to each call. |
| Low | Restored state is cast from session data without checking its shape. | Restored items are validated; malformed entries are ignored. |
| Info | Tool description pushes the model hard ("VERY frequently", "CRITICAL"). | Neutral wording, same guidance. |

## Spec

**Tool `manage_todo_list`** (label "Todo List"). Parameters:

- `operation`: `"read"` or `"write"`.
- `todoList` (write only): the complete list; each item has `id` (number), `title` (short
  label), `description` (detail), `status` (`not-started`, `in-progress`, `completed`).

Behaviour:

- `read` returns the list as pretty JSON, or a hint to write one when empty.
- `write` replaces the whole list (no partial updates). Missing `todoList` or invalid items
  return an error result naming every problem, and leave the list unchanged. On success it
  reports `completed/total`, reminds the model to keep the list current, and warns when the
  list has fewer than 3 items.
- Every result stores `{ operation, todos, error? }` in `details`; that is the persisted state.

**State.** On `session_start` and `session_tree`, the list is rebuilt from the current branch:
the latest `manage_todo_list` result, unless a later clear entry follows it.

**Widget** (`todo-list`, above the editor): hidden when empty; otherwise a header
` Todo List — n/m completed` and one line per item with an icon (`✓` completed, `◉` in
progress, `○` not started) and id. Completed titles are dim and struck through, in-progress
titles use the warning colour. Lines are truncated to the terminal width.

**Command `/todos`**: with no argument, shows `n/m todos completed` (or that there are none)
and refreshes the widget; `/todos clear` clears the list and the widget.

**Rendering**: the call shows `manage_todo_list <operation>` plus the item count on writes;
the result shows the error, `No todos`, or `✓ n/m completed`, and when expanded each item with
its icon, id and title.
