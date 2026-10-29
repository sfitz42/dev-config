import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { RewindSession, STALE_SESSION_MS } from '../src/rewind-session.ts'
import { createTestRepo } from './git-repo.ts'

import type { TestRepo } from './git-repo.ts'

let repo: TestRepo
let clock: number

const session = (id = 'session-1'): RewindSession =>
  new RewindSession(repo.git, id, () => {
    clock += 1
    return clock
  })

beforeEach(() => {
  repo = createTestRepo()
  clock = 1_000
})

afterEach(() => {
  repo.dispose()
})

describe('RewindSession', () => {
  test('skips a checkpoint when nothing changed', async () => {
    const rewind = session()
    expect(await rewind.checkpoint('resume', 0, 'start')).toBeDefined()
    expect(await rewind.checkpoint('turn', 1, 'no-op')).toBeUndefined()

    repo.write('README.md', 'edit\n')
    expect(await rewind.checkpoint('turn', 2, 'edit')).toBeDefined()
    expect(rewind.checkpoints().map((cp) => cp.description))
      .toEqual(['edit', 'start'])
  })

  test('restores, then undoes the restore', async () => {
    const rewind = session()
    const start = await rewind.checkpoint('resume', 0, 'start')
    repo.write('README.md', 'agent\n')
    repo.write('new.txt', 'new')
    if (start === undefined) {
      throw new Error('expected a checkpoint')
    }

    await rewind.restore(start)
    expect(repo.read('README.md')).toBe('hello\n')
    expect(rewind.undoStack()).toHaveLength(1)
    expect(rewind.checkpoints()).toHaveLength(1)

    expect(await rewind.undo()).toBe(true)
    expect(repo.read('README.md')).toBe('agent\n')
    expect(repo.read('new.txt')).toBe('new')
    expect(rewind.undoStack()).toHaveLength(0)
    expect(await rewind.undo()).toBe(false)
  })

  test('takes no safety checkpoint for a cross-branch restore', async () => {
    const rewind = session()
    const start = await rewind.checkpoint('resume', 0, 'start')
    repo.sh('switch', '--quiet', '-c', 'other')
    if (start === undefined) {
      throw new Error('expected a checkpoint')
    }

    await expect(rewind.restore(start)).rejects.toThrow(/another|Switch/)
    expect(rewind.undoStack()).toHaveLength(0)
  })

  test('previews what a restore would change', async () => {
    const rewind = session()
    const start = await rewind.checkpoint('resume', 0, 'start')
    repo.write('README.md', 'changed\n')
    repo.commitAll('move head')
    if (start === undefined) {
      throw new Error('expected a checkpoint')
    }

    const preview = await rewind.preview(start)
    expect(preview.diff).toContain('README.md')
    expect(preview.headMoved).toBe(true)
    expect(preview.branch).toBe('main')
  })

  test('loads only its own session and prunes stale other sessions', async () => {
    const other = session('session-2')
    await other.checkpoint('resume', 0, 'other start')

    clock += STALE_SESSION_MS + 1
    const rewind = session()
    await rewind.load()
    expect(rewind.checkpoints()).toEqual([])

    expect(await rewind.prune()).toBe(1)
    expect(repo.sh('for-each-ref', 'refs/pi-checkpoints/')).toBe('')
  })

  test('closestBefore picks the newest at or before a time', async () => {
    const rewind = session()
    await rewind.checkpoint('resume', 0, 'first')
    repo.write('README.md', 'two\n')
    await rewind.checkpoint('turn', 1, 'second')

    const [second, first] = rewind.checkpoints()
    expect(rewind.closestBefore(second?.timestamp ?? 0)).toBe(second)
    expect(rewind.closestBefore((second?.timestamp ?? 0) - 1)).toBe(first)
    expect(rewind.closestBefore(0)).toBe(first)
  })
})
