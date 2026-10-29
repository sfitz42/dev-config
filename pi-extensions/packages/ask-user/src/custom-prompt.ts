import { isKeyRelease, isKeyRepeat } from '@earendil-works/pi-tui'

import { shortcutMatches } from './shortcuts.ts'

import type {
  ExtensionAPI,
  ExtensionUIContext,
  KeybindingsManager,
  Theme
} from '@earendil-works/pi-coding-agent'
import type { Component, OverlayHandle, TUI } from '@earendil-works/pi-tui'

import type { DisplayMode } from './ask-types.ts'
import type { Shortcut } from './shortcuts.ts'

interface CustomPromptRequest<T> {
  readonly signal?: AbortSignal
  readonly timeout?: number
  readonly displayMode: DisplayMode
  readonly overlayToggle: Shortcut
  readonly create: (
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    complete: (value: T | null) => void
  ) => Component
  /** Used when `ui.custom` is unavailable (RPC mode returns undefined). */
  readonly fallback: () => Promise<T | null>
}

/** Reads `aborted` fresh; it changes while prompts are awaited. */
function isAborted (signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

const OVERLAY_OPTIONS = {
  anchor: 'center',
  width: '92%',
  minWidth: 40,
  maxHeight: '85%',
  margin: 1
} as const

/**
 * Shows one custom prompt and owns its resources: abort listener, timeout
 * and the overlay-toggle key listener. Completes at most once and releases
 * everything however it ends.
 *
 * @param ui - The extension UI.
 * @param request - What to show and how.
 * @returns The value, or null when cancelled, aborted or timed out.
 */
async function runCustomPrompt<T> (
  ui: ExtensionUIContext,
  request: CustomPromptRequest<T>
): Promise<T | null> {
  const { signal, timeout, displayMode, overlayToggle } = request
  let handle: OverlayHandle | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let removeKeyListener: (() => void) | undefined
  let completed = false
  let announcedHide = false

  try {
    if (displayMode === 'overlay' && !overlayToggle.disabled) {
      // Hidden overlays get no input, so listen on the raw terminal.
      removeKeyListener = ui.onTerminalInput((data) => {
        if (handle === undefined || !shortcutMatches(overlayToggle, data)) {
          return undefined
        }
        // Kitty reports press, repeat and release; toggle on press only.
        if (isKeyRepeat(data) || isKeyRelease(data)) {
          return { consume: true }
        }
        const hide = !handle.isHidden()
        handle.setHidden(hide)
        if (hide && !announcedHide) {
          announcedHide = true
          ui.notify(`ask_user hidden — press ${overlayToggle.spec} to reopen`,
            'info')
        }
        return { consume: true }
      })
    }

    if (isAborted(signal)) {
      return null
    }
    // Typed as possibly undefined: RPC mode resolves custom() without a value.
    const result: T | null | undefined = await ui.custom<T | null>(
      (tui, theme, keys, done) => {
        const complete = (value: T | null): void => {
          if (!completed) {
            completed = true
            done(isAborted(signal) ? null : value)
          }
        }
        if (signal !== undefined) {
          onAbort = () => complete(null)
          signal.addEventListener('abort', onAbort, { once: true })
        }
        if (isAborted(signal)) {
          complete(null)
        } else if (timeout !== undefined && timeout > 0) {
          timer = setTimeout(() => complete(null), timeout)
        }
        return request.create(tui, theme, keys, complete)
      },
      displayMode === 'overlay'
        ? {
            overlay: true,
            overlayOptions: OVERLAY_OPTIONS,
            onHandle: (overlay) => { handle = overlay }
          }
        : undefined
    )
    if (isAborted(signal)) {
      return null
    }
    return result === undefined ? await request.fallback() : result
  } finally {
    completed = true
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    if (onAbort !== undefined) {
      signal?.removeEventListener('abort', onAbort)
    }
    removeKeyListener?.()
  }
}

/**
 * Reports the session as waiting on the user (`herdr:blocked`) while
 * `run` is in progress.
 *
 * @returns Whatever `run` returns.
 */
async function whileBlocked<T> (
  pi: Pick<ExtensionAPI, 'events'>,
  run: () => Promise<T>
): Promise<T> {
  pi.events.emit('herdr:blocked', {
    active: true, label: 'Waiting for user response'
  })
  try {
    return await run()
  } finally {
    pi.events.emit('herdr:blocked', { active: false })
  }
}

export { isAborted, runCustomPrompt, whileBlocked }
export type { CustomPromptRequest }
