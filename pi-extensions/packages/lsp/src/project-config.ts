import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const CONFIG_FILE = '.pi-lsp.json'

/** How to launch one language server. */
interface ServerConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** Sent with `initialize`. */
  readonly initializationOptions?: Readonly<Record<string, unknown>>
  /** Answers to `workspace/configuration`, keyed by section. */
  readonly settings?: Readonly<Record<string, unknown>>
}

interface ProjectConfig {
  readonly autoStart: readonly string[]
  readonly lombokJar?: string
  readonly autoInjectDiagnostics: boolean | readonly string[]
  readonly servers: Readonly<Record<string, ServerConfig>>
}

interface ParsedConfig {
  readonly config: ProjectConfig
  readonly warnings: readonly string[]
}

interface LoadedConfig extends ParsedConfig {
  /** The file's text, which approvals are tied to. */
  readonly text: string
}

const EMPTY_CONFIG: ProjectConfig = {
  autoStart: [],
  autoInjectDiagnostics: true,
  servers: {}
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray (value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isStringRecord (value: unknown): value is Record<string, string> {
  return isRecord(value) &&
    Object.values(value).every((v) => typeof v === 'string')
}

function parseServer (
  language: string,
  value: unknown,
  warnings: string[]
): ServerConfig | undefined {
  const label = `servers.${language}`
  if (!isRecord(value) || typeof value.command !== 'string' ||
    value.command.trim() === '') {
    warnings.push(`${label}: needs a non-empty "command"; ignored`)
    return undefined
  }
  const { args, env, initializationOptions, settings } = value
  if (args !== undefined && !isStringArray(args)) {
    warnings.push(`${label}.args: must be an array of strings; ignored`)
    return undefined
  }
  if (env !== undefined && !isStringRecord(env)) {
    warnings.push(`${label}.env: must map names to strings; ignored`)
    return undefined
  }
  if (initializationOptions !== undefined && !isRecord(initializationOptions)) {
    warnings.push(`${label}.initializationOptions: must be an object; ignored`)
    return undefined
  }
  if (settings !== undefined && !isRecord(settings)) {
    warnings.push(`${label}.settings: must be an object; ignored`)
    return undefined
  }
  return {
    command: value.command,
    args: args ?? [],
    ...(env === undefined ? {} : { env }),
    ...(initializationOptions === undefined ? {} : { initializationOptions }),
    ...(settings === undefined ? {} : { settings })
  }
}

/**
 * Validates the contents of `.pi-lsp.json`. Invalid fields are dropped with
 * a warning rather than failing the whole file.
 *
 * @param raw - The parsed JSON.
 * @returns The usable config and any warnings.
 */
function parseProjectConfig (raw: unknown): ParsedConfig {
  const warnings: string[] = []
  if (!isRecord(raw)) {
    return { config: EMPTY_CONFIG, warnings: ['must be a JSON object'] }
  }

  let autoStart: readonly string[] = []
  if (raw.autoStart !== undefined) {
    if (isStringArray(raw.autoStart)) {
      autoStart = raw.autoStart
    } else {
      warnings.push('autoStart: must be an array of language ids; ignored')
    }
  }

  let lombokJar: string | undefined
  if (raw.lombokJar !== undefined) {
    if (typeof raw.lombokJar === 'string' && raw.lombokJar !== '') {
      lombokJar = raw.lombokJar
    } else {
      warnings.push('lombokJar: must be a path or "auto"; ignored')
    }
  }

  let autoInjectDiagnostics: boolean | readonly string[] = true
  const inject = raw.autoInjectDiagnostics
  if (typeof inject === 'boolean' || isStringArray(inject)) {
    autoInjectDiagnostics = inject
  } else if (inject !== undefined) {
    warnings.push('autoInjectDiagnostics: must be a boolean or an array; ignored')
  }

  const servers: Record<string, ServerConfig> = {}
  if (isRecord(raw.servers)) {
    for (const [language, value] of Object.entries(raw.servers)) {
      const server = parseServer(language, value, warnings)
      if (server !== undefined) {
        servers[language] = server
      }
    }
  } else if (raw.servers !== undefined) {
    warnings.push('servers: must be an object; ignored')
  }

  return {
    config: {
      autoStart,
      ...(lombokJar === undefined ? {} : { lombokJar }),
      autoInjectDiagnostics,
      servers
    },
    warnings
  }
}

/**
 * Reads `.pi-lsp.json` from a directory.
 *
 * @param dir - The project root.
 * @returns The parsed config, or undefined when the file does not exist.
 */
async function loadProjectConfig (
  dir: string
): Promise<LoadedConfig | undefined> {
  let text: string
  try {
    text = await readFile(join(dir, CONFIG_FILE), 'utf8')
  } catch {
    return undefined
  }
  try {
    return { ...parseProjectConfig(JSON.parse(text)), text }
  } catch {
    return {
      config: EMPTY_CONFIG,
      warnings: ['is not valid JSON; ignored'],
      text
    }
  }
}

/**
 * Whether write/edit results for a language get its errors appended.
 *
 * @param config - The project config.
 * @param languageId - The edited file's language.
 * @returns True when injection is enabled for the language.
 */
function shouldInjectDiagnostics (
  config: ProjectConfig,
  languageId: string
): boolean {
  const inject = config.autoInjectDiagnostics
  return typeof inject === 'boolean' ? inject : inject.includes(languageId)
}

/**
 * Removes the parts of a config that make Pi run programs or load code
 * (servers, auto-start and the Lombok agent jar). Used until the user
 * approves the config.
 *
 * @param config - The full config.
 * @returns The config with only diagnostics injection settings kept.
 */
function withoutExecutableSettings (config: ProjectConfig): ProjectConfig {
  return {
    ...EMPTY_CONFIG,
    autoInjectDiagnostics: config.autoInjectDiagnostics
  }
}

/**
 * Whether a config contains settings that make Pi run something.
 *
 * @param config - The config to check.
 * @returns True when servers, autoStart or lombokJar are set.
 */
function hasExecutableSettings (config: ProjectConfig): boolean {
  return Object.keys(config.servers).length > 0 ||
    config.autoStart.length > 0 || config.lombokJar !== undefined
}

export {
  CONFIG_FILE,
  EMPTY_CONFIG,
  hasExecutableSettings,
  loadProjectConfig,
  parseProjectConfig,
  shouldInjectDiagnostics,
  withoutExecutableSettings
}
export type { LoadedConfig, ParsedConfig, ProjectConfig, ServerConfig }
