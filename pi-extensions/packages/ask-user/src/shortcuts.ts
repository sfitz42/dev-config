import { matchesKey } from '@earendil-works/pi-tui'

import type { KeyId } from '@earendil-works/pi-tui'

interface EnabledShortcut {
  readonly disabled: false
  readonly spec: string
}

interface DisabledShortcut {
  readonly disabled: true
}

type Shortcut = EnabledShortcut | DisabledShortcut

interface AskShortcuts {
  readonly overlayToggle: Shortcut
  readonly commentToggle: Shortcut
}

const DEFAULT_OVERLAY_TOGGLE_KEY = 'alt+o'
const DEFAULT_COMMENT_TOGGLE_KEY = 'ctrl+g'

const DISABLED: DisabledShortcut = { disabled: true }
const DISABLE_WORDS = new Set(['off', 'none', 'disabled', ''])
const KEY_SPEC_PATTERN = /^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/

/**
 * Normalises one candidate key spec.
 *
 * @param value - A key id, a disable word, null (disable) or undefined.
 * @returns The lowercase spec, null to disable, or undefined if not set.
 */
function normalizeShortcutSpec (
  value: string | null | undefined
): string | null | undefined {
  if (value === undefined || value === null) {
    return value
  }
  const trimmed = value.trim().toLowerCase()
  return DISABLE_WORDS.has(trimmed) ? null : trimmed
}

/** A light syntax check; `matchesKey` does the real matching. */
function isValidShortcutSpec (spec: string): boolean {
  return KEY_SPEC_PATTERN.test(spec) && !spec.startsWith('+') &&
    !spec.endsWith('+') && !spec.includes('++')
}

/**
 * Picks the first usable shortcut from candidates in precedence order.
 * Undefined candidates and invalid specs fall through; a disable word or
 * null stops the search and disables the shortcut.
 *
 * @param candidates - Parameter, env var, file value, default.
 * @returns The resolved shortcut.
 */
function resolveShortcut (
  candidates: ReadonlyArray<string | null | undefined>
): Shortcut {
  for (const candidate of candidates) {
    const spec = normalizeShortcutSpec(candidate)
    if (spec === null) {
      return DISABLED
    }
    if (spec !== undefined && isValidShortcutSpec(spec)) {
      return { disabled: false, spec }
    }
  }
  return DISABLED
}

function shortcutMatches (shortcut: Shortcut, data: string): boolean {
  // The spec passed the syntax check; matchesKey rejects unknown ids.
  return !shortcut.disabled && matchesKey(data, shortcut.spec as KeyId)
}

export {
  DEFAULT_COMMENT_TOGGLE_KEY,
  DEFAULT_OVERLAY_TOGGLE_KEY,
  isValidShortcutSpec,
  normalizeShortcutSpec,
  resolveShortcut,
  shortcutMatches
}
export type { AskShortcuts, Shortcut }
