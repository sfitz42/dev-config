import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { BUILTIN_RULES } from '../src/config/config-defaults.ts'
import {
  checkToolCall,
  redactGrepOutput
} from '../src/policies/policy-check.ts'
import {
  compilePolicies,
  selfProtectionPolicy
} from '../src/policies/policy-rules.ts'

import type { CheckEnvironment } from '../src/policies/policy-check.ts'

let root: string
let env: CheckEnvironment
let agentDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guardrails-policies-'))
  const cwd = join(root, 'project')
  const home = join(root, 'home')
  agentDir = join(home, '.pi', 'agent')
  mkdirSync(join(cwd, 'sub'), { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(cwd, '.env'), 'TOKEN=abc123secret\n')
  writeFileSync(join(cwd, '.env.example'), 'TOKEN=\n')
  writeFileSync(join(cwd, 'notes.txt'), 'hello\n')
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'key\n')
  symlinkSync(join(cwd, '.env'), join(cwd, 'config-link'))
  symlinkSync(join(home, '.ssh', 'id_rsa'), join(cwd, 'key-link'))
  env = { cwd, home, environment: {} }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const policies = (): ReturnType<typeof compilePolicies> => [
  ...compilePolicies(BUILTIN_RULES.map((rule) => ({ ...rule, enabled: true }))),
  selfProtectionPolicy(agentDir)
]

function blocked (toolName: string, input: Record<string, unknown>): string {
  return checkToolCall(toolName, input, policies(), env)?.ruleId ?? 'allowed'
}

const bash = (command: string): string => blocked('bash', { command })

describe('file tools', () => {
  test.each([
    ['read', { path: '.env' }, 'secret-files'],
    ['read', { path: './.env' }, 'secret-files'],
    ['edit', { path: 'sub/../.env' }, 'secret-files'],
    ['read', { path: '.env.example' }, 'allowed'],
    ['read', { path: 'notes.txt' }, 'allowed'],
    ['read', { path: 'config-link' }, 'secret-files'],
    ['read', { path: 'key-link' }, 'home-ssh'],
    ['grep', { pattern: 'TOKEN', glob: '.env' }, 'secret-files'],
    ['write', { path: '.env.new' }, 'allowed']
  ])('%s %j', (tool, input, expected) => {
    expect(blocked(tool, input)).toBe(expected)
  })
})

describe('bash', () => {
  test.each([
    ['cat .env', 'secret-files'],
    ['cat notes.txt', 'allowed'],
    ['echo .env', 'allowed'],
    ["printf '%s\\n' .env", 'allowed'],
    ['cat .env.example', 'allowed'],
    ['cat > .env', 'secret-files'],
    ['cat ~/.ssh/id_rsa', 'home-ssh']
  ])('%j', (command, expected) => {
    expect(bash(command)).toBe(expected)
  })

  // Each of these got past the upstream policy check.
  test.each([
    ['cat .e""nv', 'quote splicing'],
    ['F=.env; cat $F', 'variable'],
    ['cat $(echo .env)', 'echo inside a substitution'],
    ["sh -c 'cat .env'", 'nested shell'],
    ['python3 -c "print(open(\'.env\').read())"', 'interpreter code'],
    ['git show HEAD:.env', 'revision:path argument'],
    ['tool --file=.env', 'option=value argument'],
    ['cat .en*', 'glob'],
    ['cat config-link', 'symlink'],
    ['cd sub && cat ../.env', 'cd then relative path'],
    ['cat {a,.env}', 'brace expansion'],
    ['cat "$(pwd)/.env"', '$(pwd)']
  ])('%j (%s)', (command) => {
    expect(bash(command)).toBe('secret-files')
  })
})

describe('self-protection', () => {
  test('blocks writes to Pi and guardrails settings', () => {
    expect(blocked('write', { path: join(agentDir, 'settings.json') }))
      .toBe('guardrails-self-protection')
    expect(bash(`echo '{}' > ${join(agentDir, 'extensions', 'guardrails.json')}`))
      .toBe('guardrails-self-protection')
    expect(bash('echo x > .pi/extensions/guardrails.json'))
      .toBe('guardrails-self-protection')
  })

  test('still allows reading them', () => {
    expect(blocked('read', { path: join(agentDir, 'settings.json') }))
      .toBe('allowed')
  })
})

describe('grep output redaction', () => {
  test('replaces lines from protected files', () => {
    const output = '.env:1: TOKEN=abc123secret\nnotes.txt:1: hello'
    const result = redactGrepOutput(output, undefined, policies(), env)
    expect(result.redacted).toBe(true)
    expect(result.text).toBe(
      '.env:1: [redacted by guardrails: secret-files]\nnotes.txt:1: hello')
  })

  test('handles context lines and a file search path', () => {
    const result = redactGrepOutput('.env-2- OTHER=1', '.env', policies(), env)
    expect(result.text).toBe('.env-2- [redacted by guardrails: secret-files]')
  })
})
