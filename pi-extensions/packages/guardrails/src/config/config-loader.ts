import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { Value } from 'typebox/value'

import { CONFIG_VERSION, DEFAULT_CONFIG } from './config-defaults.ts'
import { isRecord, migrateConfig } from './config-migrations.ts'
import { guardrailsConfigSchema } from './config-schema.ts'

import type { AllowedPath } from '../core/paths.ts'
import type { PatternConfig } from '../core/patterns.ts'
import type { ResolvedConfig } from './config-defaults.ts'
import type { RawConfig } from './config-migrations.ts'
import type {
  ConfigScope,
  DangerousPattern,
  FeatureId,
  GuardrailsConfig,
  PolicyRule
} from './config-schema.ts'

/** File operations, injectable so tests never touch real config. */
interface ConfigFiles {
  read: (path: string) => Promise<string | undefined>
  write: (path: string, text: string) => Promise<void>
  backup: (source: string, destination: string) => Promise<void>
  isDirectory: (path: string) => boolean
}

/** Where session-only settings live; shared by the guardrails extensions. */
interface MemoryStore {
  get: () => RawConfig | undefined
  set: (config: RawConfig) => void
}

interface LoaderOptions {
  /** Pi's agent directory (`~/.pi/agent`). */
  readonly agentDir: string
  readonly home?: string
  readonly files?: ConfigFiles
  readonly memory?: MemoryStore
}

interface LoadContext {
  readonly cwd: string
  /** Pi project trust; untrusted projects cannot change guardrails. */
  readonly trusted: boolean
}

const FILE_NAME = 'guardrails.json'
const SCHEMA_URL = new URL('../../schema.json', import.meta.url).href
const FEATURES: readonly FeatureId[] = [
  'policies', 'permissionGate', 'pathAccess'
]

const nodeFiles: ConfigFiles = {
  read: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  },
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  },
  backup: async (source, destination) => {
    try {
      await stat(destination)
    } catch {
      await copyFile(source, destination).catch(() => undefined)
    }
  },
  isDirectory: (path) => {
    try {
      return existsSync(path) && statSync(path).isDirectory()
    } catch {
      return false
    }
  }
}

function array<T> (
  value: unknown,
  guard: (item: unknown) => item is T
): T[] | undefined {
  return Array.isArray(value) ? value.filter(guard) : undefined
}

function isPattern (value: unknown): value is PatternConfig {
  return isRecord(value) && typeof value.pattern === 'string' &&
    value.pattern !== '' &&
    (value.regex === undefined || typeof value.regex === 'boolean') &&
    (value.description === undefined || typeof value.description === 'string')
}

function isDangerousPattern (value: unknown): value is DangerousPattern {
  return isPattern(value) && typeof value.description === 'string'
}

function isRule (value: unknown): value is PolicyRule {
  return isRecord(value) && typeof value.id === 'string' &&
    value.id.trim() !== '' && Array.isArray(value.patterns) &&
    ['none', 'readOnly', 'noAccess'].includes(String(value.protection))
}

function isAllowedPath (value: unknown): value is AllowedPath {
  return isRecord(value) && typeof value.path === 'string' &&
    value.path.trim() !== '' &&
    (value.kind === 'file' || value.kind === 'directory')
}

function section (config: RawConfig | undefined, key: string): RawConfig {
  const value = config?.[key]
  return isRecord(value) ? value : {}
}

/** The value from the highest scope that sets a valid one. */
function pick<T> (
  scopes: readonly (RawConfig | undefined)[],
  read: (config: RawConfig | undefined) => unknown,
  guard: (value: unknown) => value is T,
  fallback: T
): T {
  for (const scope of [...scopes].reverse()) {
    const value = read(scope)
    if (guard(value)) {
      return value
    }
  }
  return fallback
}

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean'

function oneOf<T extends string> (
  ...values: T[]
): (value: unknown) => value is T {
  return (value): value is T =>
    typeof value === 'string' && (values as string[]).includes(value)
}

function unionBy<T extends { pattern: string }> (
  ...lists: (readonly T[] | undefined)[]
): T[] {
  const merged = new Map<string, T>()
  for (const item of lists.flatMap((list) => list ?? [])) {
    merged.set(item.pattern, item)
  }
  return [...merged.values()]
}

/**
 * Merges scopes over the defaults. Lowest to highest priority: defaults,
 * global, local, memory.
 *
 * @param global - The user-wide file.
 * @param local - The project file (only when the project is trusted).
 * @param memory - Session-only settings.
 * @returns The effective config.
 */
function resolveConfig (
  global: RawConfig | undefined,
  local: RawConfig | undefined,
  memory: RawConfig | undefined
): ResolvedConfig {
  const scopes = [global, local, memory]
  const defaults = DEFAULT_CONFIG
  const applyBuiltinDefaults = pick(scopes,
    (c) => c?.applyBuiltinDefaults, isBoolean, defaults.applyBuiltinDefaults)

  const features = Object.fromEntries(FEATURES.map((id) => [
    id,
    pick(scopes, (c) => section(c, 'features')[id], isBoolean,
      defaults.features[id])
  ])) as Record<FeatureId, boolean>

  const rules = new Map<string, PolicyRule>()
  if (applyBuiltinDefaults) {
    for (const rule of defaults.policies.rules) {
      rules.set(rule.id, rule)
    }
  }
  for (const scope of scopes) {
    for (const rule of array(section(scope, 'policies').rules, isRule) ?? []) {
      rules.set(rule.id, {
        ...rule,
        patterns: rule.patterns.filter(isPattern),
        allowedPatterns: array(rule.allowedPatterns, isPattern)
      })
    }
  }

  const gates = scopes.map((scope) => section(scope, 'permissionGate'))
  const custom = [...gates].reverse()
    .map((gate) => array(gate.customPatterns, isDangerousPattern))
    .find((list) => list !== undefined)

  const pathAccess = scopes.map((scope) => section(scope, 'pathAccess'))
  const allowedPaths = new Map<string, AllowedPath>()
  for (const entry of [
    ...defaults.pathAccess.allowedPaths,
    ...pathAccess.flatMap((p) => array(p.allowedPaths, isAllowedPath) ?? [])
  ]) {
    const path = entry.path.trim()
    allowedPaths.set(`${entry.kind}:${path}`, { kind: entry.kind, path })
  }

  return {
    enabled: pick(scopes, (c) => c?.enabled, isBoolean, defaults.enabled),
    applyBuiltinDefaults,
    features,
    policies: { rules: [...rules.values()] },
    pathAccess: {
      mode: pick(scopes, (c) => section(c, 'pathAccess').mode,
        oneOf('allow', 'ask', 'block'), defaults.pathAccess.mode),
      applyTo: pick(scopes, (c) => section(c, 'pathAccess').applyTo,
        oneOf('all', 'write'), defaults.pathAccess.applyTo),
      allowedPaths: [...allowedPaths.values()],
      alwaysScope: pick(scopes, (c) => section(c, 'pathAccess').alwaysScope,
        oneOf('local', 'global'), defaults.pathAccess.alwaysScope)
    },
    permissionGate: {
      patterns: custom ?? unionBy(defaults.permissionGate.patterns,
        ...gates.map((gate) => array(gate.patterns, isDangerousPattern))),
      useBuiltinMatchers: custom === undefined,
      requireConfirmation: pick(scopes,
        (c) => section(c, 'permissionGate').requireConfirmation, isBoolean,
        defaults.permissionGate.requireConfirmation),
      allowedPatterns: unionBy(
        ...gates.map((gate) => array(gate.allowedPatterns, isPattern))),
      autoDenyPatterns: unionBy(
        ...gates.map((gate) => array(gate.autoDenyPatterns, isPattern)))
    }
  }
}

/** Describes schema problems in a config file, one line each. */
function schemaWarnings (config: RawConfig, path: string): string[] {
  return [...Value.Errors(guardrailsConfigSchema, config)]
    .slice(0, 5)
    .map((error) => `${path}: ${error.instancePath || '/'} ${error.message}`)
}

/** Loads, migrates, merges and saves guardrails settings. */
class ConfigLoader {
  private global: RawConfig | undefined
  private local: RawConfig | undefined
  private resolved: ResolvedConfig = DEFAULT_CONFIG
  private messages: string[] = []
  private context: LoadContext | undefined
  private readonly files: ConfigFiles
  private readonly home: string
  private readonly memoryStore: MemoryStore

  constructor (private readonly options: LoaderOptions) {
    this.files = options.files ?? nodeFiles
    this.home = options.home ?? homedir()
    let memory: RawConfig | undefined
    this.memoryStore = options.memory ?? {
      get: () => memory,
      set: (config) => { memory = config }
    }
  }

  private get memory (): RawConfig | undefined {
    return this.memoryStore.get()
  }

  get globalPath (): string {
    return join(this.options.agentDir, 'extensions', FILE_NAME)
  }

  /**
   * The project config path: `.pi/extensions/guardrails.json` in the
   * nearest directory with a `.pi` folder, stopping below home.
   */
  localPath (cwd = this.context?.cwd): string | undefined {
    if (cwd === undefined) {
      return undefined
    }
    let dir = resolve(cwd)
    for (;;) {
      if (dir === this.home) {
        break
      }
      if (this.files.isDirectory(join(dir, '.pi'))) {
        return join(dir, '.pi', 'extensions', FILE_NAME)
      }
      const parent = dirname(dir)
      if (parent === dir) {
        break
      }
      dir = parent
    }
    return join(resolve(cwd), '.pi', 'extensions', FILE_NAME)
  }

  /**
   * Reads config files, applying migrations. The project file is only read
   * when the project is trusted. Session (memory) settings are kept.
   */
  async load (context: LoadContext): Promise<void> {
    this.context = context
    this.global = await this.readScope(this.globalPath)
    const localPath = this.localPath(context.cwd)
    if (context.trusted) {
      this.local = localPath === undefined
        ? undefined
        : await this.readScope(localPath)
    } else {
      this.local = undefined
      if (localPath !== undefined &&
        await this.files.read(localPath) !== undefined) {
        this.messages.push(
          `Ignored ${localPath}: this project is not trusted, so its ` +
          'settings cannot change guardrails. Use /trust to allow it.')
      }
    }
    this.resolved = resolveConfig(this.global, this.local, this.memory)
  }

  /** Effective config; re-merged so other extensions' session grants show. */
  get config (): ResolvedConfig {
    this.resolved = resolveConfig(this.global, this.local, this.memory)
    return this.resolved
  }

  get isLoaded (): boolean {
    return this.context !== undefined
  }

  get trusted (): boolean {
    return this.context?.trusted ?? false
  }

  raw (scope: ConfigScope): GuardrailsConfig | undefined {
    const value = scope === 'global'
      ? this.global
      : scope === 'local' ? this.local : this.memory
    return value === undefined ? undefined : structuredClone(value)
  }

  /** Messages from migrations and validation since the last call. */
  drainMessages (): string[] {
    return this.messages.splice(0)
  }

  /**
   * Replaces a scope's settings. Files get the format version and a
   * `$schema` pointing at this package's schema.
   */
  async save (scope: ConfigScope, config: GuardrailsConfig): Promise<void> {
    const next: RawConfig = { ...config }
    Reflect.deleteProperty(next, '$schema')
    if (scope === 'memory') {
      this.memoryStore.set(next)
    } else {
      const path = scope === 'global' ? this.globalPath : this.localPath()
      if (path === undefined) {
        throw new Error('No project directory for local settings')
      }
      const stamped = {
        $schema: SCHEMA_URL,
        ...next,
        version: typeof next.version === 'string'
          ? next.version
          : CONFIG_VERSION
      }
      await this.files.write(path, `${JSON.stringify(stamped, null, 2)}\n`)
      if (scope === 'global') {
        this.global = next
      } else if (this.trusted) {
        this.local = next
      }
    }
    this.resolved = resolveConfig(this.global, this.local, this.memory)
  }

  private async readScope (path: string): Promise<RawConfig | undefined> {
    const text = await this.files.read(path)
    if (text === undefined) {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.messages.push(`${path}: invalid JSON (${String(error)}); ignored.`)
      return undefined
    }
    if (!isRecord(parsed)) {
      this.messages.push(`${path}: expected an object; ignored.`)
      return undefined
    }
    const { config, changed, messages } = await migrateConfig(
      parsed, path, { backup: this.files.backup })
    this.messages.push(...messages)
    if (changed) {
      await this.files.write(path, `${JSON.stringify(config, null, 2)}\n`)
        .catch((error: unknown) => {
          this.messages.push(`${path}: could not save migration: ${String(error)}`)
        })
    }
    this.messages.push(...schemaWarnings(config, path))
    const result = { ...config }
    Reflect.deleteProperty(result, '$schema')
    return result
  }
}

/** URL written as `$schema` in saved files. */
function schemaUrl (): string {
  return SCHEMA_URL
}

export { ConfigLoader, nodeFiles, resolveConfig, schemaUrl }
export type { ConfigFiles, LoadContext, LoaderOptions, MemoryStore }
