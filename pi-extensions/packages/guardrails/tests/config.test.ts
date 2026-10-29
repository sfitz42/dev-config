import { describe, expect, test } from 'vitest'

import { ConfigLoader, resolveConfig } from '../src/config/config-loader.ts'
import { migrateConfig } from '../src/config/config-migrations.ts'

import type { ConfigFiles } from '../src/config/config-loader.ts'
import type { RawConfig } from '../src/config/config-migrations.ts'

/** In-memory files: path → contents. */
function memoryFiles (initial: Record<string, unknown> = {}): ConfigFiles & {
  files: Map<string, string>
  dirs: Set<string>
} {
  const files = new Map(Object.entries(initial).map(([path, value]) =>
    [path, JSON.stringify(value)]))
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    read: async (path) => files.get(path),
    write: async (path, text) => { files.set(path, text) },
    backup: async (source, destination) => {
      const text = files.get(source)
      if (text !== undefined && !files.has(destination)) {
        files.set(destination, text)
      }
    },
    isDirectory: (path) => dirs.has(path)
  }
}

const GLOBAL = '/home/u/.pi/agent/extensions/guardrails.json'
const LOCAL = '/work/repo/.pi/extensions/guardrails.json'

function loader (files: ConfigFiles): ConfigLoader {
  return new ConfigLoader({ agentDir: '/home/u/.pi/agent', home: '/home/u', files })
}

describe('scopes', () => {
  test('ignores an untrusted project config and says so', async () => {
    const files = memoryFiles({
      [LOCAL]: { version: '0.19.0', enabled: false }
    })
    files.dirs.add('/work/repo/.pi')
    const config = loader(files)
    await config.load({ cwd: '/work/repo/src', trusted: false })
    expect(config.config.enabled).toBe(true)
    expect(config.drainMessages().join('\n')).toMatch(/not trusted/)
  })

  test('applies a trusted project config over the global one', async () => {
    const files = memoryFiles({
      [GLOBAL]: { version: '0.19.0', pathAccess: { mode: 'block' } },
      [LOCAL]: { version: '0.19.0', pathAccess: { mode: 'ask' } }
    })
    files.dirs.add('/work/repo/.pi')
    const config = loader(files)
    await config.load({ cwd: '/work/repo/src', trusted: true })
    expect(config.config.pathAccess.mode).toBe('ask')
  })

  test('memory settings win and survive a reload', async () => {
    const files = memoryFiles()
    const config = loader(files)
    await config.load({ cwd: '/work', trusted: true })
    await config.save('memory', { permissionGate: { requireConfirmation: false } })
    await config.load({ cwd: '/work', trusted: true })
    expect(config.config.permissionGate.requireConfirmation).toBe(false)
    expect(files.files.size).toBe(0)
  })

  test('saves stamp the version and schema', async () => {
    const files = memoryFiles()
    const config = loader(files)
    await config.load({ cwd: '/work', trusted: true })
    await config.save('global', { enabled: true })
    const saved = JSON.parse(files.files.get(GLOBAL) ?? '{}') as RawConfig
    expect(saved.version).toBe('0.19.0')
    expect(String(saved.$schema)).toMatch(/schema\.json$/)
  })

  test('reports invalid JSON instead of failing', async () => {
    const files = memoryFiles()
    files.files.set(GLOBAL, '{ nope')
    const config = loader(files)
    await config.load({ cwd: '/work', trusted: true })
    expect(config.config.enabled).toBe(true)
    expect(config.drainMessages().join('\n')).toMatch(/invalid JSON/)
  })
})

describe('merging', () => {
  test('rules override by id across scopes', () => {
    const resolved = resolveConfig(
      { policies: { rules: [{ id: 'logs', patterns: [{ pattern: '*.log' }], protection: 'readOnly' }] } },
      { policies: { rules: [{ id: 'logs', patterns: [{ pattern: '*.log' }], protection: 'noAccess' }] } },
      undefined)
    const logs = resolved.policies.rules.find((rule) => rule.id === 'logs')
    expect(logs?.protection).toBe('noAccess')
    expect(resolved.policies.rules.some((rule) => rule.id === 'secret-files'))
      .toBe(true)
  })

  test('applyBuiltinDefaults false drops the built-in rules', () => {
    const resolved = resolveConfig({ applyBuiltinDefaults: false }, undefined,
      undefined)
    expect(resolved.policies.rules).toEqual([])
  })

  test('gate patterns are unioned; customPatterns replace them', () => {
    const extra = { pattern: 'terraform apply', description: 'tf' }
    const union = resolveConfig({ permissionGate: { patterns: [extra] } },
      { permissionGate: { allowedPatterns: [{ pattern: 'npm test' }] } },
      undefined)
    expect(union.permissionGate.patterns).toContainEqual(extra)
    expect(union.permissionGate.patterns.length).toBeGreaterThan(1)
    expect(union.permissionGate.allowedPatterns).toEqual([{ pattern: 'npm test' }])

    const custom = resolveConfig(undefined,
      { permissionGate: { customPatterns: [extra] } }, undefined)
    expect(custom.permissionGate.patterns).toEqual([extra])
    expect(custom.permissionGate.useBuiltinMatchers).toBe(false)
  })

  test('ignores values of the wrong type', () => {
    const resolved = resolveConfig(
      { enabled: 'no', pathAccess: { mode: 'sometimes', allowedPaths: [{ path: 3 }] } },
      undefined, undefined)
    expect(resolved.enabled).toBe(true)
    expect(resolved.pathAccess.mode).toBe('ask')
    expect(resolved.pathAccess.allowedPaths)
      .toEqual([{ kind: 'file', path: '/dev/null' }])
  })
})

describe('migrations', () => {
  const io = { backup: async (): Promise<void> => undefined }

  test('upgrades a v0 file and backs it up', async () => {
    const backups: string[] = []
    const result = await migrateConfig({
      permissionGate: {
        patterns: ['rm -rf'],
        allowedPatterns: ['^npm test$', { pattern: 'ls .' }]
      }
    }, '/x/guardrails.json', {
      backup: async (_from, to) => { backups.push(to) }
    })
    expect(backups).toEqual(['/x/guardrails.v0.json'])
    expect(result.config.permissionGate).toEqual({
      patterns: [{ pattern: 'rm -rf', regex: true }],
      allowedPatterns: [
        { pattern: '^npm test$', regex: true },
        // Objects are already current; they must not become regexes.
        { pattern: 'ls .' }
      ]
    })
    expect(result.config.version).toBe('0.19.0')
  })

  test('turns envFiles into a secret-files policy', async () => {
    const result = await migrateConfig({
      version: '0.11.0',
      features: { protectEnvFiles: true },
      envFiles: {
        protectedPatterns: [{ pattern: '.env' }],
        protectedDirectories: [{ pattern: 'secrets' }],
        protectedTools: ['read']
      }
    }, '/x.json', io)
    expect(result.config.envFiles).toBeUndefined()
    expect(result.config.features).toEqual({ policies: true })
    expect(result.config.policies).toMatchObject({
      rules: [{
        id: 'secret-files',
        protection: 'noAccess',
        patterns: [{ pattern: '.env' }, { pattern: 'secrets/**' }]
      }]
    })
    expect(result.messages.join('\n')).toMatch(/protectedTools/)
  })

  test('normalises string booleans and legacy allowed paths', async () => {
    const result = await migrateConfig({
      version: '0.12.0',
      features: { pathAccess: 'enabled', policies: 'disabled' },
      permissionGate: { requireConfirmation: 'off' },
      pathAccess: { allowedPaths: ['/tmp/logs/', '/etc/hosts', '  '] }
    }, '/x.json', io)
    expect(result.config.features)
      .toEqual({ pathAccess: true, policies: false })
    expect(result.config.permissionGate).toEqual({ requireConfirmation: false })
    expect(result.config.pathAccess).toEqual({
      allowedPaths: [
        { kind: 'directory', path: '/tmp/logs' },
        { kind: 'file', path: '/etc/hosts' }
      ]
    })
  })

  test('adds /dev/null for onboarded ask-mode configs', async () => {
    const result = await migrateConfig({
      version: '0.13.2',
      onboarding: { completed: true },
      features: { pathAccess: true },
      pathAccess: { mode: 'ask', allowedPaths: [] }
    }, '/x.json', io)
    expect(result.config.pathAccess).toEqual({
      mode: 'ask', allowedPaths: [{ kind: 'file', path: '/dev/null' }]
    })
  })

  test('compares versions numerically', async () => {
    const result = await migrateConfig({ version: '0.20.0' }, '/x.json', io)
    expect(result.changed).toBe(false)
    const older = await migrateConfig({ version: '0.9.0' }, '/x.json', io)
    expect(older.config.version).toBe('0.16.2')
  })

  test('notes the pattern merge when any gate list is set', async () => {
    const result = await migrateConfig({
      version: '0.18.0',
      permissionGate: { patterns: [], autoDenyPatterns: [{ pattern: 'x' }] }
    }, '/x.json', io)
    expect(result.messages.join('\n')).toMatch(/merged across/)
  })
})
