import { decodeKittyPrintable, Key, matchesKey } from '@earendil-works/pi-tui'

import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import type { Keybinding, KeyId } from '@earendil-works/pi-tui'

import type { AskShortcuts } from './shortcuts.ts'

// Collapsed-context toggles, in order of preference.
const CONTEXT_TOGGLE_KEYS: readonly KeyId[] =
  [Key.ctrl('e'), Key.ctrl('x'), Key.ctrl('y')]

function matchesSelectUp (data: string, keys: KeybindingsManager): boolean {
  return keys.matches(data, 'tui.select.up') ||
    matchesKey(data, Key.shift('tab')) || matchesKey(data, Key.ctrl('k'))
}

function matchesSelectDown (data: string, keys: KeybindingsManager): boolean {
  return keys.matches(data, 'tui.select.down') ||
    matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl('j'))
}

/** The digit 1-9 typed, as a zero-based index, or undefined. */
function digitIndex (data: string): number | undefined {
  const key = decodeKittyPrintable(data) ?? data
  return /^[1-9]$/.test(key) ? Number(key) - 1 : undefined
}

/** One printable character typed, or undefined for control input. */
function printableInput (data: string): string | undefined {
  const kitty = decodeKittyPrintable(data)
  if (kitty !== undefined) {
    return kitty
  }
  const characters = [...data]
  const [character] = characters
  if (characters.length !== 1 || character === undefined) {
    return undefined
  }
  const code = character.charCodeAt(0)
  const control = code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
  return control ? undefined : character
}

/** The first context toggle key no other shortcut uses. */
function contextToggleKey (shortcuts: AskShortcuts): KeyId {
  const taken = new Set<string>()
  for (const shortcut of [shortcuts.overlayToggle, shortcuts.commentToggle]) {
    if (!shortcut.disabled) {
      taken.add(shortcut.spec)
    }
  }
  return CONTEXT_TOGGLE_KEYS.find((key) => !taken.has(key)) ?? Key.ctrl('e')
}

function literalHint (theme: Theme, key: string, label: string): string {
  return theme.fg('dim', key) + theme.fg('muted', ` ${label}`)
}

function bindingHint (
  theme: Theme,
  keys: KeybindingsManager,
  binding: Keybinding,
  label: string
): string {
  return literalHint(theme, keys.getKeys(binding).join('/'), label)
}

/** Cancel keys other than escape, shown separately from esc's meaning. */
function otherCancelKeys (keys: KeybindingsManager): string[] {
  return keys.getKeys('tui.select.cancel')
    .filter((key) => key !== 'escape' && key !== 'esc')
}

function joinHints (hints: ReadonlyArray<string | undefined>): string {
  return hints.filter((hint): hint is string => hint !== undefined)
    .join(' • ')
}

export {
  bindingHint,
  contextToggleKey,
  digitIndex,
  joinHints,
  literalHint,
  matchesSelectDown,
  matchesSelectUp,
  otherCancelKeys,
  printableInput
}
