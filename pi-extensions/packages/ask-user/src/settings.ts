import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { DisplayMode, SingleSelectLayout } from './ask-types.ts'

type Environment = Readonly<Record<string, string | undefined>>

/** Personal defaults from `ask-user.json`; every key is optional. */
interface AskUserSettings {
  readonly displayMode?: DisplayMode
  readonly singleSelectLayout?: SingleSelectLayout
  readonly allowComment?: boolean
  readonly contextExpanded?: boolean
  readonly overlayToggleKey?: string
  readonly commentToggleKey?: string
  readonly emitFullEvents?: boolean
}

const SETTINGS_FILE = 'ask-user.json'

/** The agent directory, as Pi resolves it. */
function agentDir (env: Environment): string {
  const override = env.PI_CODING_AGENT_DIR?.trim() ?? ''
  return override === '' ? join(homedir(), '.pi', 'agent') : override
}

function settingsPath (env: Environment): string {
  return join(agentDir(env), SETTINGS_FILE)
}

function isDisplayMode (value: unknown): value is DisplayMode {
  return value === 'overlay' || value === 'inline'
}

function isSingleSelectLayout (value: unknown): value is SingleSelectLayout {
  return value === 'auto' || value === 'list'
}

function keySpec (value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function flag (value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parses the settings file, keeping only well-typed known keys.
 *
 * @param raw - The file contents.
 * @param path - The file path, for the error message.
 * @returns The usable settings.
 * @throws When the contents are not valid JSON.
 */
function parseSettings (raw: string, path: string): AskUserSettings {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Failed to parse ask-user settings at ${path}: ${errorMessage(error)}`
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {}
  }
  const source: Readonly<Record<string, unknown>> = { ...parsed }
  const { displayMode, singleSelectLayout } = source
  const allowComment = flag(source.allowComment)
  const contextExpanded = flag(source.contextExpanded)
  const overlayToggleKey = keySpec(source.overlayToggleKey)
  const commentToggleKey = keySpec(source.commentToggleKey)
  const emitFullEvents = flag(source.emitFullEvents)
  return {
    ...(isDisplayMode(displayMode) ? { displayMode } : {}),
    ...(isSingleSelectLayout(singleSelectLayout) ? { singleSelectLayout } : {}),
    ...(allowComment === undefined ? {} : { allowComment }),
    ...(contextExpanded === undefined ? {} : { contextExpanded }),
    ...(overlayToggleKey === undefined ? {} : { overlayToggleKey }),
    ...(commentToggleKey === undefined ? {} : { commentToggleKey }),
    ...(emitFullEvents === undefined ? {} : { emitFullEvents })
  }
}

function isMissingFile (error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Reads `ask-user.json`; called on every ask so edits apply at once.
 *
 * @param path - The settings file.
 * @returns The settings, or `{}` when the file does not exist.
 * @throws When the file exists but cannot be read or parsed.
 */
function loadSettings (path: string): AskUserSettings {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) {
      return {}
    }
    throw new Error(
      `Failed to read ask-user settings at ${path}: ${errorMessage(error)}`
    )
  }
  return parseSettings(raw, path)
}

/** Parses an env boolean: 1/true/yes/on or 0/false/no/off. */
function parseBooleanPreference (
  value: string | undefined
): boolean | undefined {
  switch (value?.trim().toLowerCase()) {
    case '1': case 'true': case 'yes': case 'on':
      return true
    case '0': case 'false': case 'no': case 'off':
      return false
    default:
      return undefined
  }
}

export {
  agentDir,
  loadSettings,
  parseBooleanPreference,
  parseSettings,
  settingsPath
}
export type { AskUserSettings, Environment }
