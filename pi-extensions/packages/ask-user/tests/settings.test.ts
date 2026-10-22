import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { resolveEmitFullEvents, resolvePromptSettings } from '../src/prompt-settings.ts'
import {
  agentDir,
  loadSettings,
  parseBooleanPreference,
  parseSettings,
  settingsPath
} from '../src/settings.ts'
import {
  isValidShortcutSpec,
  normalizeShortcutSpec,
  resolveShortcut
} from '../src/shortcuts.ts'

describe('settings file', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const tempFile = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-user-test-'))
    dirs.push(dir)
    const path = join(dir, 'ask-user.json')
    writeFileSync(path, contents)
    return path
  }

  test('lives in the agent directory, honouring PI_CODING_AGENT_DIR', () => {
    expect(settingsPath({ PI_CODING_AGENT_DIR: '/x/agent' }))
      .toBe('/x/agent/ask-user.json')
    expect(agentDir({ PI_CODING_AGENT_DIR: '  ' })).toMatch(/\.pi[/\\]agent$/)
  })

  test('a missing file gives defaults', () => {
    expect(loadSettings(join(tmpdir(), 'no-such-dir-xyz', 'ask-user.json')))
      .toEqual({})
  })

  test('keeps well-typed known keys only', () => {
    const path = tempFile(JSON.stringify({
      displayMode: 'inline',
      singleSelectLayout: 'sideways',
      allowComment: 'yes',
      contextExpanded: true,
      overlayToggleKey: ' ',
      commentToggleKey: 'ctrl+t',
      emitFullEvents: false,
      unknown: 1
    }))
    expect(loadSettings(path)).toEqual({
      displayMode: 'inline',
      contextExpanded: true,
      commentToggleKey: 'ctrl+t',
      emitFullEvents: false
    })
  })

  test('invalid JSON names the file', () => {
    const path = tempFile('{nope')
    expect(() => loadSettings(path))
      .toThrow(`Failed to parse ask-user settings at ${path}`)
  })

  test('a non-object is ignored', () => {
    expect(parseSettings('[1]', 'x')).toEqual({})
  })
})

describe('parseBooleanPreference', () => {
  test.each([
    ['1', true], ['YES', true], [' on ', true], ['true', true],
    ['0', false], ['no', false], ['off', false], ['false', false],
    ['maybe', undefined], [undefined, undefined]
  ])('%s → %s', (value, expected) => {
    expect(parseBooleanPreference(value)).toBe(expected)
  })
})

describe('shortcuts', () => {
  test('normalise and validate specs', () => {
    expect(normalizeShortcutSpec(' Alt+O ')).toBe('alt+o')
    expect(normalizeShortcutSpec('none')).toBeNull()
    expect(normalizeShortcutSpec(undefined)).toBeUndefined()
    expect(isValidShortcutSpec('ctrl+shift+h')).toBe(true)
    expect(isValidShortcutSpec('ctrl++h')).toBe(false)
    expect(isValidShortcutSpec('+h')).toBe(false)
    expect(isValidShortcutSpec('ctrl h')).toBe(false)
  })

  test('first usable candidate wins; disable words stop the search', () => {
    expect(resolveShortcut([undefined, 'bad key', 'alt+p']))
      .toEqual({ disabled: false, spec: 'alt+p' })
    expect(resolveShortcut(['off', 'alt+p'])).toEqual({ disabled: true })
    expect(resolveShortcut([null, 'alt+p'])).toEqual({ disabled: true })
    expect(resolveShortcut([undefined])).toEqual({ disabled: true })
  })
})

describe('resolvePromptSettings', () => {
  test('defaults', () => {
    expect(resolvePromptSettings({}, {}, {})).toEqual({
      displayMode: 'overlay',
      singleSelectLayout: 'auto',
      allowComment: false,
      contextExpanded: false,
      shortcuts: {
        overlayToggle: { disabled: false, spec: 'alt+o' },
        commentToggle: { disabled: false, spec: 'ctrl+g' }
      }
    })
  })

  test('parameter, then env, then file', () => {
    const file = {
      displayMode: 'inline' as const,
      allowComment: true,
      overlayToggleKey: 'alt+f'
    }
    const env = {
      PI_ASK_USER_DISPLAY_MODE: 'overlay',
      PI_ASK_USER_ALLOW_COMMENT: 'off',
      PI_ASK_USER_SINGLE_SELECT_LAYOUT: 'LIST'
    }
    const settings = resolvePromptSettings(
      { contextExpanded: true, commentToggleKey: 'off' }, env, file)
    expect(settings.displayMode).toBe('overlay')
    expect(settings.allowComment).toBe(false)
    expect(settings.singleSelectLayout).toBe('list')
    expect(settings.contextExpanded).toBe(true)
    expect(settings.shortcuts.overlayToggle)
      .toEqual({ disabled: false, spec: 'alt+f' })
    expect(settings.shortcuts.commentToggle).toEqual({ disabled: true })
  })

  test('an unrecognised env value falls through to the file', () => {
    expect(resolvePromptSettings({},
      { PI_ASK_USER_DISPLAY_MODE: 'modal' }, { displayMode: 'inline' })
      .displayMode).toBe('inline')
  })

  test('full events are off unless asked for', () => {
    expect(resolveEmitFullEvents({}, {})).toBe(false)
    expect(resolveEmitFullEvents({}, { emitFullEvents: true })).toBe(true)
    expect(resolveEmitFullEvents({ PI_ASK_USER_EMIT_FULL_EVENTS: '0' },
      { emitFullEvents: true })).toBe(false)
  })
})
