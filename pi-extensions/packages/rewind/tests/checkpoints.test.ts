import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  CrossBranchError,
  isSafeId,
  loadCheckpoints,
  parseCheckpointMessage,
  restoreCheckpoint,
  saveCheckpoint,
  selectPrunable,
  takeSnapshot
} from '../src/checkpoints.ts'
import { createTestRepo } from './git-repo.ts'

import type { Checkpoint, Snapshot } from '../src/checkpoint-types.ts'
import type { TestRepo } from './git-repo.ts'

const WEIRD_NAMES = [
  'with space.txt',
  'quote".txt',
  'single\'quote.txt',
  'line\nbreak.txt',
  '*',
  ':(top)magic.txt',
  '-dash.txt'
]

function checkpointFrom (
  snapshot: Snapshot,
  overrides: Partial<Checkpoint> = {}
): Checkpoint {
  return {
    ...snapshot,
    id: 'turn-s1-1-1',
    sessionId: 's1',
    trigger: 'turn',
    turnIndex: 1,
    description: 'test',
    timestamp: 1_000,
    ...overrides
  }
}

function treeNames (repo: TestRepo, tree: string): string[] {
  return repo.sh('ls-tree', '-r', '-z', '--name-only', tree)
    .split('\0')
    .filter((name) => name !== '')
    .sort()
}

let repo: TestRepo

beforeEach(() => {
  repo = createTestRepo()
})

afterEach(() => {
  repo.dispose()
})

describe('takeSnapshot', () => {
  test('captures tracked edits and untracked files with awkward names', async () => {
    repo.write('README.md', 'changed\n')
    for (const name of WEIRD_NAMES) {
      repo.write(name, name)
    }
    repo.write('not-added.txt', 'x')

    const snapshot = await takeSnapshot(repo.git)

    expect(treeNames(repo, snapshot.worktreeTree))
      .toEqual(['README.md', 'not-added.txt', ...WEIRD_NAMES].sort())
    expect(repo.sh('cat-file', '-p', `${snapshot.worktreeTree}:README.md`))
      .toBe('changed\n')
    // The real index is untouched.
    expect(repo.sh('diff', '--cached', '--name-only')).toBe('')
  })

  test('a file named * matches only itself', async () => {
    repo.write('*', 'star')
    repo.write('a.txt', 'a')
    repo.write('node_modules/x.js', 'x')

    const snapshot = await takeSnapshot(repo.git)

    expect(treeNames(repo, snapshot.worktreeTree))
      .toEqual(['*', 'README.md', 'a.txt'])
  })

  test('records deletions and staged-only changes', async () => {
    repo.write('staged.txt', 'staged')
    repo.sh('add', 'staged.txt')
    repo.sh('rm', '--quiet', 'README.md')

    const snapshot = await takeSnapshot(repo.git)

    expect(treeNames(repo, snapshot.worktreeTree)).toEqual(['staged.txt'])
    expect(treeNames(repo, snapshot.indexTree)).toEqual(['staged.txt'])
  })

  test('skips ignored, gitignored, large and crowded untracked files', async () => {
    repo.write('.gitignore', 'secret.key\n')
    repo.commitAll('ignore')
    repo.write('secret.key', 'k')
    repo.write('.venv/lib.py', 'x')
    repo.write('big.bin', 'x'.repeat(10 * 1024 * 1024 + 1))
    for (let index = 0; index < 200; index += 1) {
      repo.write(`crowd/${index}.txt`, 'x')
    }

    const snapshot = await takeSnapshot(repo.git)

    expect(treeNames(repo, snapshot.worktreeTree))
      .toEqual(['.gitignore', 'README.md'])
    expect(snapshot.skippedFiles).toEqual(['big.bin'])
    expect(snapshot.skippedDirs).toEqual(['crowd'])
    expect(snapshot.untracked).toEqual([])
  })

  test('works before the first commit', async () => {
    const empty = createTestRepo(false)
    try {
      empty.write('first.txt', '1')
      const snapshot = await takeSnapshot(empty.git)
      expect(snapshot.headSha).toBeNull()
      expect(snapshot.branch).toBe('main')
      expect(treeNames(empty, snapshot.worktreeTree)).toEqual(['first.txt'])
    } finally {
      empty.dispose()
    }
  })
})

describe('restoreCheckpoint', () => {
  test('restores files and removes only new untracked files', async () => {
    repo.write('keep me.txt', 'pre-existing')
    repo.write('node_modules/dep.js', 'dep')
    const snapshot = await takeSnapshot(repo.git)

    repo.write('README.md', 'agent edit\n')
    repo.write('keep me.txt', 'agent edit')
    for (const name of WEIRD_NAMES) {
      repo.write(name, name)
    }
    repo.write('node_modules/new.js', 'installed')

    await restoreCheckpoint(repo.git, snapshot)

    expect(repo.read('README.md')).toBe('hello\n')
    expect(repo.read('keep me.txt')).toBe('pre-existing')
    for (const name of WEIRD_NAMES) {
      expect(existsSync(join(repo.root, name))).toBe(false)
    }
    expect(repo.read('node_modules/new.js')).toBe('installed')
    // Untracked at snapshot time stays untracked.
    expect(repo.sh('ls-files', 'keep me.txt')).toBe('')
  })

  test('restores the staged index', async () => {
    repo.write('README.md', 'staged\n')
    repo.sh('add', 'README.md')
    repo.write('README.md', 'unstaged\n')
    const snapshot = await takeSnapshot(repo.git)

    repo.sh('reset', '--quiet', '--hard')
    await restoreCheckpoint(repo.git, snapshot)

    expect(repo.read('README.md')).toBe('unstaged\n')
    expect(repo.sh('show', ':README.md')).toBe('staged\n')
  })

  test('never moves HEAD or the branch', async () => {
    const snapshot = await takeSnapshot(repo.git)
    repo.write('later.txt', 'committed later')
    repo.commitAll('later')
    const head = repo.sh('rev-parse', 'HEAD')

    await restoreCheckpoint(repo.git, snapshot)

    expect(repo.sh('rev-parse', 'HEAD')).toBe(head)
    expect(repo.sh('rev-parse', 'main')).toBe(head)
    expect(existsSync(join(repo.root, 'later.txt'))).toBe(false)
  })

  test('refuses a checkpoint from another branch', async () => {
    const snapshot = await takeSnapshot(repo.git)
    repo.sh('switch', '--quiet', '-c', 'other')
    repo.write('README.md', 'other\n')

    await expect(restoreCheckpoint(repo.git, snapshot))
      .rejects.toBeInstanceOf(CrossBranchError)
    expect(repo.read('README.md')).toBe('other\n')
  })

  test('keeps large and crowded files that were never snapshotted', async () => {
    const snapshot = await takeSnapshot(repo.git)
    const restorable = { ...snapshot, skippedFiles: ['big.bin'], skippedDirs: ['crowd'] }
    repo.write('big.bin', 'large')
    repo.write('crowd/a.txt', 'a')

    await restoreCheckpoint(repo.git, restorable)

    expect(repo.read('big.bin')).toBe('large')
    expect(repo.read('crowd/a.txt')).toBe('a')
  })
})

describe('saving and loading', () => {
  test('round-trips checkpoints through refs', async () => {
    repo.write('a b.txt', 'x')
    const checkpoint = checkpointFrom(await takeSnapshot(repo.git), {
      description: '"quoted" → edit\nnext line'
    })

    await saveCheckpoint(repo.git, checkpoint)

    expect(repo.sh('for-each-ref', '--format=%(refname)'))
      .toContain('refs/pi-checkpoints/turn-s1-1-1')
    expect(await loadCheckpoints(repo.git)).toEqual([checkpoint])
  })

  test('rejects an unsafe id', async () => {
    const checkpoint = checkpointFrom(await takeSnapshot(repo.git), {
      id: '../../heads/main'
    })
    await expect(saveCheckpoint(repo.git, checkpoint)).rejects.toThrow(/Unsafe/)
  })

  test('ignores refs that are not valid checkpoints', async () => {
    const commit = repo.sh('commit-tree', '-m', 'junk',
      repo.sh('write-tree').trim()).trim()
    repo.sh('update-ref', 'refs/pi-checkpoints/junk', commit)
    expect(await loadCheckpoints(repo.git)).toEqual([])
  })
})

describe('parseCheckpointMessage', () => {
  test('rejects a message naming another id', () => {
    expect(parseCheckpointMessage('a', 'pi-rewind checkpoint b\n\n{}'))
      .toBeUndefined()
  })
})

describe('isSafeId', () => {
  test.each([
    ['turn-abc_1-123-1', true],
    ['../x', false],
    ['a..b', false],
    ['x.lock', false],
    ['-x', false],
    ['a/b', false]
  ])('%j is %s', (id, expected) => {
    expect(isSafeId(id)).toBe(expected)
  })
})

describe('selectPrunable', () => {
  const base = checkpointFrom({
    branch: 'main',
    headSha: null,
    indexTree: 't',
    worktreeTree: 't',
    untracked: [],
    skippedFiles: [],
    skippedDirs: []
  })
  const at = (
    id: string,
    sessionId: string,
    timestamp: number,
    trigger: Checkpoint['trigger'] = 'turn'
  ): Checkpoint => ({ ...base, id, sessionId, timestamp, trigger })

  test('keeps the newest per session and never prunes before-restore', () => {
    const list = [
      at('a', 's1', 1),
      at('b', 's1', 2),
      at('c', 's1', 3),
      at('safe', 's1', 0, 'before-restore')
    ]
    expect(selectPrunable(list, 's1', 2, 10, 1_000)).toEqual(['a'])
  })

  test('prunes other sessions only once stale', () => {
    const list = [at('old', 's2', 0), at('recent', 's2', 9_500)]
    expect(selectPrunable(list, 's1', 50, 10_000, 1_000)).toEqual(['old'])
  })
})
