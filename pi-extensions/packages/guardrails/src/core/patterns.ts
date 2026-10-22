import { matchesGlob } from 'node:path'

/** A configured pattern: glob or substring by default, regex on request. */
interface PatternConfig {
  readonly pattern: string
  readonly description?: string
  readonly regex?: boolean
}

interface CompiledPattern {
  readonly source: PatternConfig
  /** False when a regex pattern failed to compile; it then matches nothing. */
  readonly valid: boolean
  test: (input: string) => boolean
}

/** Forward slashes, no leading `./`, no repeated separators. */
function normalizeFilePath (input: string): string {
  return input
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
}

function compileRegex (
  config: PatternConfig,
  flags: string,
  prepare: (input: string) => string
): CompiledPattern {
  try {
    const regex = new RegExp(config.pattern, flags)
    return {
      source: config,
      valid: true,
      test: (input) => regex.test(prepare(input))
    }
  } catch {
    return { source: config, valid: false, test: () => false }
  }
}

/**
 * Compiles a file pattern. Globs containing `/` match the whole path;
 * other globs match the file name. Regexes match the whole path,
 * case-insensitively.
 *
 * @param config - The configured pattern.
 * @returns A matcher over path spellings.
 */
function compileFilePattern (config: PatternConfig): CompiledPattern {
  if (config.regex === true) {
    return compileRegex(config, 'i', normalizeFilePath)
  }
  const matchWholePath = config.pattern.includes('/')
  return {
    source: config,
    valid: true,
    test: (input) => {
      const normalized = normalizeFilePath(input)
      const candidate = matchWholePath
        ? normalized
        : normalized.split('/').pop() ?? normalized
      try {
        return matchesGlob(candidate, config.pattern)
      } catch {
        return false
      }
    }
  }
}

/**
 * Compiles a command pattern: a substring of the command text, or a
 * case-sensitive regex.
 */
function compileCommandPattern (config: PatternConfig): CompiledPattern {
  if (config.regex === true) {
    return compileRegex(config, '', (input) => input)
  }
  return {
    source: config,
    valid: true,
    test: (input) => input.includes(config.pattern)
  }
}

/** Escapes text so it matches literally, anchored to the whole input. */
function exactRegex (text: string): string {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `^(?:${escaped})$`
}

export {
  compileCommandPattern,
  compileFilePattern,
  exactRegex,
  normalizeFilePath
}
export type { CompiledPattern, PatternConfig }
