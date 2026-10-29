import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createGitRunner } from '../src/git-runner.ts'

import type { GitRunner } from '../src/git-runner.ts'

interface TestRepo {
  readonly root: string
  readonly git: GitRunner
  write (path: string, content: string): void
  read (path: string): string
  sh (...args: string[]): string
  commitAll (message: string): void
  dispose (): void
}

/**
 * Creates a throwaway repository with one commit holding `README.md`.
 *
 * @param commit - False for a repository with no commits yet.
 */
function createTestRepo (commit = true): TestRepo {
  const root = mkdtempSync(join(tmpdir(), 'rewind-test-'))
  const sh = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const commitAll = (message: string): void => {
    sh('add', '--all')
    sh('commit', '--quiet', '--no-verify', '-m', message)
  }

  sh('init', '--quiet', '--initial-branch=main')
  sh('config', 'user.name', 'Test')
  sh('config', 'user.email', 'test@example.com')
  sh('config', 'commit.gpgsign', 'false')
  if (commit) {
    write('README.md', 'hello\n')
    commitAll('initial')
  }

  return {
    root,
    git: createGitRunner(root),
    write,
    read: (path) => readFileSync(join(root, path), 'utf8'),
    sh,
    commitAll,
    dispose: () => rmSync(root, { recursive: true, force: true })
  }
}

export { createTestRepo }
export type { TestRepo }
