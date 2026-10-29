/**
 * Upgrades older guardrails config files in place.
 *
 * Migrations work on raw JSON so they can read shapes the current schema no
 * longer describes. Each step is guarded by a structural check, never by
 * comparing version strings as text.
 */

type RawConfig = Record<string, unknown>

interface MigrationIo {
  /** Copies the file to `destination` unless that file already exists. */
  readonly backup: (source: string, destination: string) => Promise<void>
}

interface Migration {
  readonly name: string
  /** Format version this brings the file to; stamped after it runs. */
  readonly version: string
  shouldRun: (config: RawConfig) => boolean
  run: (config: RawConfig, filePath: string, io: MigrationIo) =>
    RawConfig | Promise<RawConfig>
  /** Message for the user, judged on the config before the run. */
  message?: (before: RawConfig) => string | undefined
}

interface MigrationResult {
  readonly config: RawConfig
  readonly changed: boolean
  readonly messages: readonly string[]
}

const DEFAULT_SECRET_PATTERNS = [
  '.env', '.env.local', '.env.production', '.env.prod', '.dev.vars'
]

function isRecord (value: unknown): value is RawConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record (config: RawConfig, key: string): RawConfig | undefined {
  const value = config[key]
  return isRecord(value) ? value : undefined
}

function compareVersions (a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

function isBelow (config: RawConfig, version: string): boolean {
  const current = config.version
  return typeof current !== 'string' || compareVersions(current, version) < 0
}

// 0.12.0: the v0 format stored patterns as strings meaning regexes.

function toRegexPatterns (items: unknown): unknown {
  if (!Array.isArray(items)) {
    return items
  }
  // Only v0 strings are regexes. Objects are already in the current format;
  // turning them into regexes would widen hand-written patterns.
  return items.map((item: unknown) =>
    typeof item === 'string' ? { pattern: item, regex: true } : item)
}

const v0Format: Migration = {
  name: 'v0-format',
  version: '0.12.0',
  shouldRun: (config) => config.version === undefined,
  run: async (config, filePath, io) => {
    await io.backup(filePath, filePath.replace(/\.json$/, '.v0.json'))
    const next = structuredClone(config)
    const envFiles = record(next, 'envFiles')
    if (envFiles !== undefined) {
      for (const key of [
        'protectedPatterns', 'allowedPatterns', 'protectedDirectories'
      ]) {
        if (envFiles[key] !== undefined) {
          envFiles[key] = toRegexPatterns(envFiles[key])
        }
      }
    }
    const gate = record(next, 'permissionGate')
    if (gate !== undefined) {
      for (const key of [
        'patterns', 'customPatterns', 'allowedPatterns', 'autoDenyPatterns'
      ]) {
        if (gate[key] !== undefined) {
          gate[key] = toRegexPatterns(gate[key])
        }
      }
    }
    return next
  }
}

const REMOVED_FEATURES = ['preventBrew', 'preventPython', 'enforcePackageManager']

const stripToolchain: Migration = {
  name: 'strip-toolchain-fields',
  version: '0.12.0',
  shouldRun: (config) => 'packageManager' in config ||
    REMOVED_FEATURES.some((key) => key in (record(config, 'features') ?? {})),
  run: (config) => {
    const next = structuredClone(config)
    const features = record(next, 'features')
    for (const key of REMOVED_FEATURES) {
      if (features !== undefined) {
        Reflect.deleteProperty(features, key)
      }
    }
    Reflect.deleteProperty(next, 'packageManager')
    return next
  },
  message: () => 'preventBrew, preventPython, enforcePackageManager and ' +
    'packageManager are no longer part of guardrails and were removed ' +
    'from your config.'
}

const REMOVED_GATE_FIELDS = ['explainCommands', 'explainModel', 'explainTimeout']

const stripExplainer: Migration = {
  name: 'strip-command-explainer-fields',
  version: '0.12.0',
  shouldRun: (config) => REMOVED_GATE_FIELDS.some((key) =>
    key in (record(config, 'permissionGate') ?? {})),
  run: (config) => {
    const next = structuredClone(config)
    const gate = record(next, 'permissionGate')
    for (const key of REMOVED_GATE_FIELDS) {
      if (gate !== undefined) {
        Reflect.deleteProperty(gate, key)
      }
    }
    return next
  },
  message: () => 'permissionGate.explainCommands, explainModel and ' +
    'explainTimeout are no longer supported and were removed.'
}

const envFilesToPolicies: Migration = {
  name: 'env-files-to-policies',
  version: '0.12.0',
  shouldRun: (config) => config.envFiles !== undefined ||
    record(config, 'features')?.protectEnvFiles !== undefined,
  run: (config) => {
    const next = structuredClone(config)
    const features = record(next, 'features')
    if (features?.protectEnvFiles !== undefined) {
      features.policies = features.protectEnvFiles
      Reflect.deleteProperty(features, 'protectEnvFiles')
    }
    const envFiles = record(next, 'envFiles')
    if (envFiles === undefined) {
      return next
    }
    const rule: RawConfig = {
      id: 'secret-files',
      description: 'Files containing secrets (migrated from envFiles)',
      protection: 'noAccess'
    }
    const patterns: unknown[] = Array.isArray(envFiles.protectedPatterns)
      ? [...envFiles.protectedPatterns]
      : []
    if (Array.isArray(envFiles.protectedDirectories)) {
      for (const dir of envFiles.protectedDirectories) {
        const value = isRecord(dir) ? dir.pattern : undefined
        if (typeof value === 'string' && value.trim() !== '' &&
          isRecord(dir)) {
          const glob = value.endsWith('/**') ? value : `${value}/**`
          patterns.push({ pattern: glob, regex: dir.regex })
        }
      }
    }
    rule.patterns = patterns.length > 0
      ? patterns
      : DEFAULT_SECRET_PATTERNS.map((pattern) => ({ pattern }))
    if (envFiles.allowedPatterns !== undefined) {
      rule.allowedPatterns = envFiles.allowedPatterns
    }
    if (typeof envFiles.onlyBlockIfExists === 'boolean') {
      rule.onlyIfExists = envFiles.onlyBlockIfExists
    }
    if (typeof envFiles.blockMessage === 'string') {
      rule.blockMessage = envFiles.blockMessage
    }
    next.policies = { rules: [rule] }
    Reflect.deleteProperty(next, 'envFiles')
    return next
  },
  message: (before) =>
    Array.isArray(record(before, 'envFiles')?.protectedTools)
      ? 'envFiles.protectedTools has no policies equivalent; the migrated ' +
        'secret-files rule blocks all access (noAccess).'
      : undefined
}

/** Legacy `{ pattern }` objects in allowedPaths become plain strings. */
const allowedPathPatterns: Migration = {
  name: 'normalize-allowed-paths',
  version: '0.12.0',
  shouldRun: (config) => {
    const paths = record(config, 'pathAccess')?.allowedPaths
    return Array.isArray(paths) && paths.some((item: unknown) =>
      isRecord(item) && typeof item.pattern === 'string')
  },
  run: (config) => {
    const next = structuredClone(config)
    const pathAccess = record(next, 'pathAccess')
    if (pathAccess === undefined || !Array.isArray(pathAccess.allowedPaths)) {
      return next
    }
    const paths = new Set<string>()
    for (const item of pathAccess.allowedPaths) {
      const value: unknown = typeof item === 'string'
        ? item
        : isRecord(item) ? item.pattern ?? item.path : undefined
      if (typeof value === 'string' && value.trim() !== '') {
        paths.add(value.trim())
      }
    }
    pathAccess.allowedPaths = [...paths]
    return next
  },
  message: () =>
    'pathAccess.allowedPaths was migrated from pattern objects to paths.'
}

const stringBooleans: Migration = {
  name: 'normalize-string-booleans',
  version: '0.13.2',
  shouldRun: (config) => {
    const features = Object.values(record(config, 'features') ?? {})
    const confirm = record(config, 'permissionGate')?.requireConfirmation
    return features.some((v) => v === 'enabled' || v === 'disabled') ||
      confirm === 'on' || confirm === 'off'
  },
  run: (config) => {
    const next = structuredClone(config)
    const features = record(next, 'features')
    for (const [key, value] of Object.entries(features ?? {})) {
      if ((value === 'enabled' || value === 'disabled') &&
        features !== undefined) {
        features[key] = value === 'enabled'
      }
    }
    const gate = record(next, 'permissionGate')
    if (gate?.requireConfirmation === 'on' ||
      gate?.requireConfirmation === 'off') {
      gate.requireConfirmation = gate.requireConfirmation === 'on'
    }
    return next
  },
  message: () => 'Boolean settings stored as strings were converted to ' +
    'true/false.'
}

function mentionsDevNull (paths: unknown): boolean {
  return Array.isArray(paths) && paths.some((item: unknown) =>
    item === '/dev/null' || (isRecord(item) && item.path === '/dev/null'))
}

const allowDevNull: Migration = {
  name: 'allow-dev-null',
  version: '0.14.0',
  shouldRun: (config) => {
    const pathAccess = record(config, 'pathAccess')
    return record(config, 'onboarding')?.completed === true &&
      record(config, 'features')?.pathAccess === true &&
      pathAccess?.mode === 'ask' && !mentionsDevNull(pathAccess.allowedPaths)
  },
  run: (config) => {
    const next = structuredClone(config)
    const pathAccess = record(next, 'pathAccess') ?? {}
    const paths: unknown[] = Array.isArray(pathAccess.allowedPaths)
      ? pathAccess.allowedPaths
      : []
    next.pathAccess = {
      ...pathAccess,
      allowedPaths: [...paths, { kind: 'file', path: '/dev/null' }]
    }
    return next
  },
  message: () => 'pathAccess.allowedPaths now allows /dev/null.'
}

function toAllowedPath (item: unknown): RawConfig | undefined {
  if (typeof item === 'string') {
    const trimmed = item.trim()
    if (trimmed === '') {
      return undefined
    }
    return trimmed.endsWith('/') && trimmed.length > 1
      ? { kind: 'directory', path: trimmed.slice(0, -1) }
      : { kind: 'file', path: trimmed }
  }
  if (!isRecord(item) || typeof item.path !== 'string' ||
    (item.kind !== 'file' && item.kind !== 'directory')) {
    return undefined
  }
  const path = item.path.trim()
  if (path === '') {
    return undefined
  }
  return {
    kind: item.kind,
    path: item.kind === 'directory' && path.endsWith('/') && path.length > 1
      ? path.slice(0, -1)
      : path
  }
}

const allowedPathObjects: Migration = {
  name: 'allowed-paths-objects',
  version: '0.14.0',
  shouldRun: (config) => {
    const paths = record(config, 'pathAccess')?.allowedPaths
    return Array.isArray(paths) &&
      paths.some((item: unknown) => typeof item === 'string')
  },
  run: (config) => {
    const next = structuredClone(config)
    const pathAccess = record(next, 'pathAccess')
    if (pathAccess !== undefined && Array.isArray(pathAccess.allowedPaths)) {
      pathAccess.allowedPaths = pathAccess.allowedPaths
        .map(toAllowedPath)
        .filter((item): item is RawConfig => item !== undefined)
    }
    return next
  },
  message: () => 'pathAccess.allowedPaths entries are now { kind, path } ' +
    'objects.'
}

/** Only stamps the version; earlier releases wrote inconsistent stamps. */
const versionStamp: Migration = {
  name: 'normalize-version-stamp',
  version: '0.16.2',
  shouldRun: (config) => isBelow(config, '0.16.2'),
  run: (config) => config
}

const gatePatternMerge: Migration = {
  name: 'note-permission-gate-pattern-merge',
  version: '0.19.0',
  shouldRun: (config) => {
    const gate = record(config, 'permissionGate')
    const nonEmpty = (key: string): boolean =>
      Array.isArray(gate?.[key]) && (gate?.[key] as unknown[]).length > 0
    return isBelow(config, '0.19.0') &&
      (nonEmpty('patterns') || nonEmpty('allowedPatterns') ||
        nonEmpty('autoDenyPatterns'))
  },
  run: (config) => config,
  message: () => 'Permission gate patterns, allowedPatterns and ' +
    'autoDenyPatterns are now merged across global and project configs ' +
    'instead of the project config replacing them.'
}

const MIGRATIONS: readonly Migration[] = [
  v0Format,
  stripToolchain,
  stripExplainer,
  envFilesToPolicies,
  allowedPathPatterns,
  stringBooleans,
  allowDevNull,
  allowedPathObjects,
  versionStamp,
  gatePatternMerge
]

/**
 * Applies every pending migration to one config file's contents.
 *
 * @param config - The parsed file.
 * @param filePath - Where it was read from, for backups.
 * @param io - File operations for backups.
 * @returns The migrated config, whether it changed, and user messages.
 */
async function migrateConfig (
  config: RawConfig,
  filePath: string,
  io: MigrationIo
): Promise<MigrationResult> {
  let current = config
  let changed = false
  const messages: string[] = []
  for (const migration of MIGRATIONS) {
    if (!migration.shouldRun(current)) {
      continue
    }
    const message = migration.message?.(current)
    current = await migration.run(current, filePath, io)
    if (isBelow(current, migration.version)) {
      current = { ...current, version: migration.version }
    }
    changed = true
    if (message !== undefined) {
      messages.push(message)
    }
  }
  return { config: current, changed, messages }
}

export { compareVersions, isRecord, MIGRATIONS, migrateConfig }
export type { Migration, MigrationIo, RawConfig }
