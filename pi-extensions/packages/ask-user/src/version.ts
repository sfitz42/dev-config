import { readFileSync } from 'node:fs'

function readVersion (): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed &&
      typeof parsed.version === 'string') {
      return parsed.version
    }
  } catch {
    // Fall through: the version is only shown in the frame.
  }
  return '0.0.0'
}

/** This package's version, shown in the prompt's bottom border. */
const VERSION = readVersion()

export { VERSION }
