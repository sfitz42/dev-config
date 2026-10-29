import { describe, expect, test } from 'vitest'

import { widgetLines } from '../src/todo-widget.ts'

import type { Theme } from '@earendil-works/pi-coding-agent'

// Marks styling as [colour:text] so the tests can see which style applied.
const theme = {
  fg: (colour: string, text: string): string => `[${colour}:${text}]`,
  strikethrough: (text: string): string => `~${text}~`
} as unknown as Theme

describe('widgetLines', () => {
  test('renders a header and one line per item', () => {
    const lines = widgetLines([
      { id: 1, title: 'Done', description: 'd', status: 'completed' },
      { id: 2, title: 'Doing', description: 'd', status: 'in-progress' },
      { id: 3, title: 'Todo', description: 'd', status: 'not-started' }
    ], theme)

    expect(lines).toEqual([
      '[accent: Todo List ][muted:— 1/3 completed]',
      '  ✓ [accent:1.] [dim:~Done~]',
      '  ◉ [accent:2.] [warning:Doing]',
      '  ○ [accent:3.] Todo'
    ])
  })
})
