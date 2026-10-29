import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  approveConfig,
  describeExecutableSettings,
  isConfigApproved
} from '../src/config-approval.ts'
import { parseProjectConfig } from '../src/project-config.ts'
import { askApproval, isPreApproved } from '../src/session-setup.ts'

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

const TEXT = JSON.stringify({
  autoStart: ['typescript'],
  servers: { typescript: { command: 'evil', args: ['--now'] } },
  autoInjectDiagnostics: false
})
const loaded = { ...parseProjectConfig(JSON.parse(TEXT)), text: TEXT }

let dir = ''
let store = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-lsp-approval-'))
  store = join(dir, 'agent', 'approvals.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface FakeContext {
  readonly ctx: Pick<ExtensionContext,
  'cwd' | 'hasUI' | 'isProjectTrusted' | 'ui'>
  readonly confirm: ReturnType<typeof vi.fn>
  readonly notify: ReturnType<typeof vi.fn>
}

interface ContextOptions {
  readonly trusted?: boolean
  readonly hasUI?: boolean
  readonly answer?: boolean
}

function context (options: ContextOptions): FakeContext {
  const confirm = vi.fn(async () => options.answer ?? false)
  const notify = vi.fn()
  const ui = { confirm, notify } as unknown as ExtensionContext['ui']
  return {
    ctx: {
      cwd: dir,
      hasUI: options.hasUI ?? true,
      isProjectTrusted: () => options.trusted ?? true,
      ui
    },
    confirm,
    notify
  }
}

describe('approval store', () => {
  test('approval is tied to the exact file text', async () => {
    expect(await isConfigApproved(store, dir, TEXT)).toBe(false)
    await approveConfig(store, dir, TEXT)
    expect(await isConfigApproved(store, dir, TEXT)).toBe(true)
    expect(await isConfigApproved(store, dir, `${TEXT} `)).toBe(false)
    expect(statSync(store).mode & 0o777).toBe(0o600)
  })

  test('the prompt lists what would run', () => {
    expect(describeExecutableSettings(loaded.config)).toBe(
      'Language servers:\n• typescript: evil --now\n' +
      'Start at launch: typescript')
  })

  test('the prompt shows server environment variables', () => {
    const config = parseProjectConfig({
      servers: {
        typescript: {
          command: 'typescript-language-server',
          args: ['--stdio'],
          env: { NODE_OPTIONS: '--require ./evil.js' }
        }
      }
    }).config
    expect(describeExecutableSettings(config)).toBe(
      'Language servers:\n• typescript: NODE_OPTIONS=--require ./evil.js ' +
      'typescript-language-server --stdio')
  })
})

describe('approval flow', () => {
  test('a config that runs nothing needs no approval', async () => {
    const plain = { ...parseProjectConfig({}), text: '{}' }
    expect(await isPreApproved(context({}).ctx, plain, store)).toBe(true)
  })

  test('asking records a yes; later sessions are pre-approved', async () => {
    const first = context({ answer: true })
    expect(await isPreApproved(first.ctx, loaded, store)).toBe(false)
    expect(await askApproval(first.ctx, loaded, store)).toBe(true)
    expect(await isPreApproved(context({}).ctx, loaded, store)).toBe(true)
  })

  test('declining records nothing and warns', async () => {
    const { ctx, notify } = context({ answer: false })
    expect(await askApproval(ctx, loaded, store)).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
    expect(await isPreApproved(ctx, loaded, store)).toBe(false)
  })

  test('an untrusted project is never asked or pre-approved', async () => {
    await approveConfig(store, dir, TEXT)
    const { ctx, confirm } = context({ trusted: false, answer: true })
    expect(await isPreApproved(ctx, loaded, store)).toBe(false)
    expect(await askApproval(ctx, loaded, store)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  test('without UI nobody is asked', async () => {
    const { ctx, confirm } = context({ hasUI: false })
    expect(await askApproval(ctx, loaded, store)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })
})
