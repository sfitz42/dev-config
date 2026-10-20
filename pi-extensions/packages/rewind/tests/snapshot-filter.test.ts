import { describe, expect, test } from 'vitest'

import {
  findCrowdedDirs,
  isIgnoredPath,
  isWithinAny,
  parsePorcelainV2
} from '../src/snapshot-filter.ts'

describe('parsePorcelainV2', () => {
  test('reads ordinary, renamed, unmerged and untracked records', () => {
    const records = [
      '1 .M N... 100644 100644 100644 abc abc src/a b.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? notes "draft".md',
      '! ignored.log'
    ]
    expect(parsePorcelainV2(records)).toEqual({
      changedTracked: [
        'src/a b.ts',
        'new name.ts',
        'old name.ts',
        'conflict.ts'
      ],
      untracked: ['notes "draft".md']
    })
  })

  test('keeps a newline inside a path', () => {
    expect(parsePorcelainV2(['? line\nbreak.txt']).untracked)
      .toEqual(['line\nbreak.txt'])
  })
})

describe('findCrowdedDirs', () => {
  test('returns directories holding at least the threshold', () => {
    const files = ['a/1', 'a/2', 'a/3', 'b/1', 'top']
    expect(findCrowdedDirs(files, 3)).toEqual(['a'])
  })

  test('never returns the root', () => {
    expect(findCrowdedDirs(['1', '2', '3'], 2)).toEqual([])
  })
})

describe('path helpers', () => {
  test.each([
    ['node_modules/x/index.js', true],
    ['packages/app/dist/out.js', true],
    ['.env', true],
    ['src/environment.ts', false],
    ['distribution/readme.md', false]
  ])('isIgnoredPath(%j) is %s', (path, expected) => {
    expect(isIgnoredPath(path)).toBe(expected)
  })

  test('isWithinAny matches whole components only', () => {
    expect(isWithinAny('logs/a.txt', ['logs'])).toBe(true)
    expect(isWithinAny('logs', ['logs'])).toBe(true)
    expect(isWithinAny('logs2/a.txt', ['logs'])).toBe(false)
  })
})
