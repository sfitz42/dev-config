import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  EMPTY_CONFIG,
  hasExecutableSettings,
  loadProjectConfig,
  parseProjectConfig,
  shouldInjectDiagnostics,
  withoutExecutableSettings
} from '../src/project-config.ts'

describe('parseProjectConfig', () => {
  test('accepts every documented field', () => {
    const { config, warnings } = parseProjectConfig({
      autoStart: ['java'],
      lombokJar: 'auto',
      autoInjectDiagnostics: ['typescript'],
      servers: {
        python: {
          command: 'pylsp',
          args: ['-v'],
          env: { A: 'b' },
          initializationOptions: { x: 1 },
          settings: { pylsp: {} }
        }
      }
    })
    expect(warnings).toEqual([])
    expect(config).toEqual({
      autoStart: ['java'],
      lombokJar: 'auto',
      autoInjectDiagnostics: ['typescript'],
      servers: {
        python: {
          command: 'pylsp',
          args: ['-v'],
          env: { A: 'b' },
          initializationOptions: { x: 1 },
          settings: { pylsp: {} }
        }
      }
    })
  })

  test('drops invalid fields with a warning', () => {
    const { config, warnings } = parseProjectConfig({
      autoStart: 'java',
      autoInjectDiagnostics: 'yes',
      servers: {
        bad: { args: [] },
        badArgs: { command: 'x', args: 'nope' },
        good: { command: 'ok' }
      }
    })
    expect(config.autoStart).toEqual([])
    expect(config.autoInjectDiagnostics).toBe(true)
    expect(Object.keys(config.servers)).toEqual(['good'])
    expect(config.servers.good).toEqual({ command: 'ok', args: [] })
    expect(warnings).toHaveLength(4)
  })

  test('a non-object is the empty config', () => {
    expect(parseProjectConfig([]).config).toEqual(EMPTY_CONFIG)
  })
})

describe('trust filtering', () => {
  const config = parseProjectConfig({
    autoStart: ['go'],
    autoInjectDiagnostics: false,
    servers: { go: { command: 'evil' } }
  }).config

  test('executable settings are detected and removed', () => {
    expect(hasExecutableSettings(config)).toBe(true)
    const safe = withoutExecutableSettings(config)
    expect(hasExecutableSettings(safe)).toBe(false)
    expect(safe.autoInjectDiagnostics).toBe(false)
  })

  test('a lombok jar alone counts as executable', () => {
    expect(hasExecutableSettings({ ...EMPTY_CONFIG, lombokJar: 'x.jar' }))
      .toBe(true)
  })
})

describe('shouldInjectDiagnostics', () => {
  test('boolean or per-language', () => {
    expect(shouldInjectDiagnostics(EMPTY_CONFIG, 'go')).toBe(true)
    const only = { ...EMPTY_CONFIG, autoInjectDiagnostics: ['typescript'] }
    expect(shouldInjectDiagnostics(only, 'typescript')).toBe(true)
    expect(shouldInjectDiagnostics(only, 'java')).toBe(false)
  })
})

describe('loadProjectConfig', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-lsp-config-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('a missing file is undefined', async () => {
    expect(await loadProjectConfig(dir)).toBeUndefined()
  })

  test('invalid JSON is reported, not thrown', async () => {
    await writeFile(join(dir, '.pi-lsp.json'), '{')
    const loaded = await loadProjectConfig(dir)
    expect(loaded?.warnings).toEqual(['is not valid JSON; ignored'])
  })
})
