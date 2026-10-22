import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  findLombokJar,
  javaInitializationOptions,
  jdtlsDataDir,
  recoverCorruptJavaWorkspace
} from '../src/lsp/java-support.ts'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-lsp-java-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function touch (path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('jdtlsDataDir', () => {
  test('follows the launcher layout per platform', () => {
    expect(jdtlsDataDir('/w/project', 'linux', { HOME: '/home/u' }))
      .toMatch(/^\/home\/u\/\.cache\/jdtls\/jdtls-[0-9a-f]{40}$/)
    expect(jdtlsDataDir('/w/project', 'darwin', { HOME: '/Users/u' }))
      .toMatch(/^\/Users\/u\/Library\/Caches\/jdtls\//)
  })
})

describe('findLombokJar', () => {
  test('an explicit path wins, then LOMBOK_JAR', () => {
    const explicit = join(dir, 'explicit.jar')
    const fromEnv = join(dir, 'env.jar')
    touch(explicit)
    touch(fromEnv)
    const search = { rootDir: dir, explicitPath: explicit, envPath: 'env.jar' }
    expect(findLombokJar(search)).toBe(explicit)
    expect(findLombokJar({ rootDir: dir, envPath: 'env.jar' })).toBe(fromEnv)
  })

  test('finds Brazil env/ layouts', () => {
    const jar = join(dir, 'env', 'Lombok-1.18', 'runtime', 'lib',
      'lombok-1.18.30.jar')
    touch(jar)
    expect(findLombokJar({ rootDir: dir })).toBe(jar)
  })

  test('finds the gradle cache layout', () => {
    const jar = join(dir, 'env', 'gradle-cache-2', 'org', 'projectlombok',
      'lombok', '1.18.2', 'lombok-1.18.2.jar')
    touch(jar)
    expect(findLombokJar({ rootDir: dir })).toBe(jar)
  })

  test('nothing found is undefined', () => {
    expect(findLombokJar({ rootDir: dir })).toBeUndefined()
  })
})

describe('javaInitializationOptions', () => {
  test('always excludes generated dirs; adds the agent with lombok', () => {
    const exclusions = expect.arrayContaining(['**/.gradle/**'])
    expect(javaInitializationOptions(undefined)).toEqual({
      settings: { 'java.import.exclusions': exclusions }
    })
    expect(javaInitializationOptions('/l.jar')).toMatchObject({
      settings: { 'java.jdt.ls.vmargs': '-javaagent:/l.jar' }
    })
  })
})

describe('recoverCorruptJavaWorkspace', () => {
  const resources = (): string =>
    join(dir, '.metadata', '.plugins', 'org.eclipse.core.resources')

  function corrupt (): void {
    touch(join(dir, '.metadata', '.log'),
      'boom\norg.eclipse.core.internal.dtree.ObjectNotFoundException\n')
    touch(join(resources(), '1.snap'))
    touch(join(resources(), '.root', '2.tree'))
    touch(join(resources(), '.projects', 'p', '3.snap'))
    touch(join(resources(), 'keep.index'))
  }

  test('deletes only snapshots and rotates the log', () => {
    corrupt()
    const notices: string[] = []
    expect(recoverCorruptJavaWorkspace(dir, (m) => notices.push(m))).toBe(3)
    expect(existsSync(join(resources(), 'keep.index'))).toBe(true)
    expect(existsSync(join(resources(), '1.snap'))).toBe(false)
    expect(existsSync(join(dir, '.metadata', '.log'))).toBe(false)
    expect(readdirSync(join(dir, '.metadata'))
      .some((f) => f.startsWith('.log.pi-lsp-recovered-'))).toBe(true)
    expect(notices).toHaveLength(1)
    // The crash is not repaired twice.
    expect(recoverCorruptJavaWorkspace(dir, () => {})).toBe(0)
  })

  test('does nothing without the crash signature', () => {
    corrupt()
    writeFileSync(join(dir, '.metadata', '.log'), 'all fine\n')
    expect(recoverCorruptJavaWorkspace(dir, () => {})).toBe(0)
    expect(existsSync(join(resources(), '1.snap'))).toBe(true)
  })

  test('refuses metadata that resolves outside the data dir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pi-lsp-outside-'))
    try {
      touch(join(outside, '.log'), 'ObjectNotFoundException')
      touch(join(outside, '.plugins', 'org.eclipse.core.resources', 'x.snap'))
      symlinkSync(outside, join(dir, '.metadata'))
      expect(recoverCorruptJavaWorkspace(dir, () => {})).toBe(0)
      expect(existsSync(join(outside, '.plugins',
        'org.eclipse.core.resources', 'x.snap'))).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
