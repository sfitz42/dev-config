import { describe, expect, test } from 'vitest'

import { batchTitle } from '../src/batch-component.ts'
import {
  contextOverflowsOverlay,
  helpBudget,
  overlayBudgets,
  overlayMaxLines,
  reviewMaxLines,
  splitPaneWidths
} from '../src/layout.ts'
import { renderOptionRows, wrapPlain } from '../src/option-rows.ts'
import { limitEditorLines, limitLines, markOverflow } from '../src/pane-lines.ts'

const dim = (text: string): string => `<${text}>`

describe('wrapPlain', () => {
  test('wraps words and breaks long ones', () => {
    expect(wrapPlain('one two  three', 7)).toEqual(['one two', 'three'])
    expect(wrapPlain('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapPlain('  ', 5)).toEqual([''])
  })
})

describe('renderOptionRows', () => {
  const options = [
    { title: 'Alpha', description: 'first choice' },
    { title: 'Beta' },
    { title: 'Gamma' }
  ]

  test('numbers options, indents descriptions, adds extra rows', () => {
    const rows = renderOptionRows({
      options,
      selectedIndex: 3,
      width: 60,
      allowFreeform: true,
      allowComment: true,
      commentEnabled: true
    })
    expect(rows.map((row) => row.line)).toEqual([
      '  1. Alpha',
      '      first choice',
      '  2. Beta',
      '  3. Gamma',
      '→   [✓] Add extra context after selection',
      '    Type something. — Enter a custom response'
    ])
    expect(rows.filter((row) => row.selected).map((row) => row.line))
      .toEqual(['→   [✓] Add extra context after selection'])
  })

  test('hides descriptions on request', () => {
    const rows = renderOptionRows({
      options,
      selectedIndex: 0,
      width: 40,
      allowFreeform: false,
      allowComment: false,
      commentEnabled: false,
      hideDescriptions: true
    })
    expect(rows.map((row) => row.line))
      .toEqual(['→ 1. Alpha', '  2. Beta', '  3. Gamma'])
  })

  test('windows around the selection with an indicator', () => {
    const rows = renderOptionRows({
      options,
      selectedIndex: 2,
      width: 40,
      allowFreeform: false,
      allowComment: false,
      commentEnabled: false,
      maxRows: 3
    })
    expect(rows.map((row) => row.line))
      .toEqual(['  2. Beta', '→ 3. Gamma', '  (3/3)'])
  })
})

describe('overlay sizing', () => {
  test('max lines follow the terminal height', () => {
    expect(overlayMaxLines(40)).toBe(34)
    expect(overlayMaxLines(10)).toBe(8)
    expect(overlayMaxLines(5)).toBe(3)
    expect(overlayMaxLines(Number.NaN)).toBe(20)
  })

  test('review cap is tighter inline', () => {
    expect(reviewMaxLines(40, 'overlay')).toBe(34)
    expect(reviewMaxLines(40, 'inline')).toBe(34)
    expect(reviewMaxLines(20, 'inline')).toBe(15)
    expect(reviewMaxLines(6, 'inline')).toBe(4)
  })

  test('help budget', () => {
    expect(helpBudget(20, 3)).toBe(2)
    expect(helpBudget(8, 3)).toBe(1)
    expect(helpBudget(8, 0)).toBe(0)
  })

  test('split panes only on wide terminals in auto layout', () => {
    expect(splitPaneWidths(100, 'auto')).toEqual({ left: 40, right: 57 })
    expect(splitPaneWidths(100, 'list')).toBeNull()
    expect(splitPaneWidths(83, 'auto')).toBeNull()
  })

  test('select mode keeps a few prompt rows', () => {
    expect(overlayBudgets({
      mode: 'select', contentRows: 20, promptLines: 10, contextCollapsed: false
    })).toEqual({ promptRows: 11, modeRows: 8, separatorRows: 1 })
    expect(overlayBudgets({
      mode: 'select', contentRows: 6, promptLines: 10, contextCollapsed: true
    })).toEqual({ promptRows: 1, modeRows: 4, separatorRows: 1 })
  })

  test('editor modes prefer the editor', () => {
    expect(overlayBudgets({
      mode: 'freeform', contentRows: 20, promptLines: 4, contextCollapsed: false
    })).toEqual({ promptRows: 9, modeRows: 10, separatorRows: 1 })
    expect(overlayBudgets({
      mode: 'comment', contentRows: 4, promptLines: 4, contextCollapsed: false
    })).toEqual({ promptRows: 0, modeRows: 4, separatorRows: 0 })
  })

  test('context collapses when it crowds out the list', () => {
    expect(contextOverflowsOverlay(1, 20, 20, 1)).toBe(true)
    expect(contextOverflowsOverlay(1, 3, 20, 1)).toBe(false)
    expect(contextOverflowsOverlay(1, 0, 4, 1)).toBe(false)
  })
})

describe('pane lines', () => {
  test('limitLines cuts with or without an ellipsis', () => {
    expect(limitLines(['a', 'b', 'c'], 2, 5, dim, true))
      .toEqual(['a    ', '<…>'])
    expect(limitLines(['a', 'b', 'c'], 2, 5, dim, false))
      .toEqual(['a    ', 'b    '])
    expect(limitLines(['a'], 0, 5, dim, true)).toEqual([])
  })

  test('markOverflow marks hidden lines', () => {
    expect(markOverflow(['a', 'b'], 6, dim, true, true))
      .toEqual(['<↑> a ', '<↓> b '])
    expect(markOverflow(['a'], 6, dim, true, true)).toEqual(['<↕> a '])
  })

  test('limitEditorLines keeps borders and the cursor line', () => {
    const lines = ['top', 'l1', 'l2', 'l3\x1b[7m \x1b[0m', 'l4', 'bottom']
    const shown = limitEditorLines(lines, 4, 20, dim)
    expect(shown[0]?.trim()).toBe('top')
    expect(shown[3]?.trim()).toBe('bottom')
    expect(shown[1]).toContain('l2')
    expect(shown[2]).toContain('l3')
    expect(limitEditorLines(lines, 2, 20, dim).map((line) => line.trim()))
      .toEqual(['top', 'bottom'])
  })
})

describe('batchTitle', () => {
  test('marks answered and current pages', () => {
    expect(batchTitle([true, false], 1, undefined))
      .toBe('ask_user 1✓ [2] · review')
    expect(batchTitle([true, true], 2, 'Set\nup'))
      .toBe('ask_user · Set up 1✓ 2✓ · [review]')
  })
})
