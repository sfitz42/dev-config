import { describe, expect, test } from 'vitest'

import {
  checkpointLabel,
  describeToolCall,
  describeTurn,
  truncate
} from '../src/labels.ts'
import { entryAtOrBefore } from '../src/rewind-flows.ts'

import type { SessionEntry } from '@earendil-works/pi-coding-agent'

import type { Checkpoint } from '../src/checkpoint-types.ts'

describe('labels', () => {
  test('truncate collapses whitespace and adds an ellipsis', () => {
    expect(truncate('a  b\nc', 10)).toBe('a b c')
    expect(truncate('abcdefgh', 5)).toBe('abcd…')
  })

  test.each([
    ['write', { path: 'src/a.ts' }, 'write → src/a.ts'],
    ['edit', {}, 'edit → ?'],
    ['bash', { command: 'npm test' }, 'bash: npm test'],
    ['bash', null, 'bash: ?'],
    ['grep', { pattern: 'x' }, 'grep']
  ])('describeToolCall(%s)', (tool, input, expected) => {
    expect(describeToolCall(tool, input)).toBe(expected)
  })

  test('describeTurn combines the prompt and tools', () => {
    expect(describeTurn('fix it', ['edit → a.ts', 'bash: ls'], 3))
      .toBe('"fix it" → edit → a.ts, bash: ls')
    expect(describeTurn('', [], 3)).toBe('Turn 3')
  })

  test('checkpointLabel flags another branch', () => {
    const checkpoint = {
      branch: 'feature',
      timestamp: new Date(2026, 0, 1, 9, 5, 7).getTime(),
      description: 'Session start'
    } as unknown as Checkpoint
    expect(checkpointLabel(checkpoint, 2, 'feature'))
      .toBe('#2 [09:05:07] [feature] Session start')
    expect(checkpointLabel(checkpoint, 2, 'main'))
      .toBe('#2 [09:05:07] ⚠️ feature Session start')
  })
})

describe('entryAtOrBefore', () => {
  const entry = (id: string, iso: string): SessionEntry =>
    ({
      type: 'label',
      id,
      parentId: null,
      timestamp: iso,
      targetId: id,
      label: undefined
    })

  test('returns the newest entry not after the time', () => {
    const entries = [
      entry('a', '2026-01-01T00:00:00.000Z'),
      entry('b', '2026-01-01T00:01:00.000Z'),
      entry('c', '2026-01-01T00:02:00.000Z')
    ]
    expect(entryAtOrBefore(entries, Date.parse('2026-01-01T00:01:30Z')))
      .toBe('b')
    expect(entryAtOrBefore(entries, 0)).toBeUndefined()
  })
})
