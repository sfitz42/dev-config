import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  decidePathAccess,
  targetsForTool
} from '../src/path-access/path-check.ts'
import { promptOptions } from '../src/path-access/path-prompt.ts'

import type { PathTarget } from '../src/core/path-candidates.ts'

let root: string
let cwd: string
let home: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guardrails-paths-'))
  cwd = join(root, 'project')
  home = join(root, 'home')
  outside = join(root, 'other')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'data.txt'), 'x')
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'x')
  symlinkSync(outside, join(cwd, 'linked'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

type Input = Record<string, unknown>

function targets (toolName: string, input: Input): PathTarget[] {
  return targetsForTool(toolName, input, { cwd, home, environment: {} })
}

function decisions (toolName: string, input: Input): string[] {
  return targets(toolName, input).map((target) => {
    const decision = decidePathAccess(target, {
      cwd, mode: 'ask', allowedPaths: [], hasUI: true
    }, home)
    return decision.kind === 'ask' ? `ask ${decision.displayPath}` : decision.kind
  }).filter((kind) => kind !== 'allow')
}

const bash = (command: string): string[] => decisions('bash', { command })

describe('file tools', () => {
  test('allows paths inside the working directory', () => {
    expect(decisions('read', { path: 'src/a.ts' })).toEqual([])
  })

  test('asks for paths outside it', () => {
    expect(decisions('read', { path: join(outside, 'data.txt') }))
      .toEqual([`ask ${join(outside, 'data.txt')}`])
  })

  test('asks for a symlink that leads outside', () => {
    expect(decisions('read', { path: 'linked/data.txt' }))
      .toEqual([`ask ${join(outside, 'data.txt')}`])
  })
})

describe('bash', () => {
  test.each([
    ['ls src', []],
    ['cat /etc/hostname', ['ask /etc/hostname']],
    ['ssh host cat /etc/passwd', []],
    ['echo /etc/passwd', []],
    ['curl https://example.com/a/b', []]
  ])('%j', (command, expected) => {
    expect(bash(command)).toEqual(expected)
  })

  // Each of these got past the upstream path check.
  test('cd to the parent directory', () => {
    expect(bash('cd .. && cat other/data.txt')).toContain(`ask ${root}`)
  })

  test('$HOME resolves to home', () => {
    expect(bash('cat $HOME/.ssh/id_rsa'))
      .toEqual(['ask ~/.ssh/id_rsa'])
  })

  test('~user is unknown, so it asks', () => {
    expect(bash('cat ~root/.bashrc')).toEqual(['ask ~root/.bashrc'])
  })

  test('an unknown variable at the start of a path asks', () => {
    expect(bash('cat "$SECRET_DIR/key"')).toEqual(['ask $SECRET_DIR/key'])
  })

  test('a symlink inside the workspace that leads outside asks', () => {
    expect(bash('cat linked/data.txt'))
      .toEqual([`ask ${join(outside, 'data.txt')}`])
  })
})

describe('modes', () => {
  const target: PathTarget = { kind: 'path', absolutePath: '/etc/passwd' }

  test('block denies, allow allows, no UI denies', () => {
    const state = { cwd, allowedPaths: [], hasUI: true }
    expect(decidePathAccess(target, { ...state, mode: 'block' }).kind)
      .toBe('deny')
    expect(decidePathAccess(target, { ...state, mode: 'allow' }).kind)
      .toBe('allow')
    expect(decidePathAccess(target, { ...state, mode: 'ask', hasUI: false })
      .kind).toBe('deny')
  })

  test('grants allow files and directory trees', () => {
    const state = { cwd, mode: 'ask' as const, hasUI: true }
    expect(decidePathAccess(target, {
      ...state, allowedPaths: [{ kind: 'directory', path: '/etc' }]
    }).kind).toBe('allow')
    expect(decidePathAccess(target, {
      ...state, allowedPaths: [{ kind: 'file', path: '/etc/hosts' }]
    }).kind).toBe('ask')
  })
})

describe('prompt options', () => {
  test('offers only once/deny for an unknown location', () => {
    expect(promptOptions({
      fileOptions: true, directoryGrantable: true, grantable: false
    }).map((option) => option.result)).toEqual(['allow-file-once', 'deny'])
  })

  test('drops directory grants that are too broad', () => {
    expect(promptOptions({
      fileOptions: true, directoryGrantable: false, grantable: true
    }).map((option) => option.result)).toEqual([
      'allow-file-once', 'allow-file-session', 'allow-file-always', 'deny'
    ])
  })
})
