import { parseBooleanPreference } from './settings.ts'
import {
  DEFAULT_COMMENT_TOGGLE_KEY,
  DEFAULT_OVERLAY_TOGGLE_KEY,
  resolveShortcut
} from './shortcuts.ts'

import type { AskParams } from './ask-params.ts'
import type { DisplayMode, SingleSelectLayout } from './ask-types.ts'
import type { AskUserSettings, Environment } from './settings.ts'
import type { AskShortcuts } from './shortcuts.ts'

interface PromptSettings {
  readonly displayMode: DisplayMode
  readonly singleSelectLayout: SingleSelectLayout
  readonly allowComment: boolean
  readonly contextExpanded: boolean
  readonly shortcuts: AskShortcuts
}

function envDisplayMode (env: Environment): DisplayMode | undefined {
  const value = env.PI_ASK_USER_DISPLAY_MODE?.trim().toLowerCase()
  return value === 'overlay' || value === 'inline' ? value : undefined
}

function envLayout (env: Environment): SingleSelectLayout | undefined {
  const value = env.PI_ASK_USER_SINGLE_SELECT_LAYOUT?.trim().toLowerCase()
  return value === 'auto' || value === 'list' ? value : undefined
}

/**
 * Resolves presentation preferences: parameter, then environment variable,
 * then `ask-user.json`, then the built-in default.
 *
 * @param params - The tool call parameters.
 * @param env - The process environment.
 * @param file - The parsed settings file.
 * @returns The settings for this prompt.
 */
function resolvePromptSettings (
  params: AskParams,
  env: Environment,
  file: AskUserSettings
): PromptSettings {
  return {
    displayMode: params.displayMode ?? envDisplayMode(env) ??
      file.displayMode ?? 'overlay',
    singleSelectLayout: params.singleSelectLayout ?? envLayout(env) ??
      file.singleSelectLayout ?? 'auto',
    allowComment: params.allowComment ??
      parseBooleanPreference(env.PI_ASK_USER_ALLOW_COMMENT) ??
      file.allowComment ?? false,
    contextExpanded: params.contextExpanded ??
      parseBooleanPreference(env.PI_ASK_USER_CONTEXT_EXPANDED) ??
      file.contextExpanded ?? false,
    shortcuts: {
      overlayToggle: resolveShortcut([
        params.overlayToggleKey,
        env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
        file.overlayToggleKey,
        DEFAULT_OVERLAY_TOGGLE_KEY
      ]),
      commentToggle: resolveShortcut([
        params.commentToggleKey,
        env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
        file.commentToggleKey,
        DEFAULT_COMMENT_TOGGLE_KEY
      ])
    }
  }
}

/** Whether `ask:*` events carry full answers (off by default). */
function resolveEmitFullEvents (
  env: Environment,
  file: AskUserSettings
): boolean {
  return parseBooleanPreference(env.PI_ASK_USER_EMIT_FULL_EVENTS) ??
    file.emitFullEvents ?? false
}

export { resolveEmitFullEvents, resolvePromptSettings }
export type { PromptSettings }
