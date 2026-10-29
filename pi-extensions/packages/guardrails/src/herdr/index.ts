import { PROMPT_CLOSED, PROMPT_OPENED } from '../events.ts'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const HERDR_BLOCKED = 'herdr:blocked'

function promptId (data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('prompt' in data)) {
    return undefined
  }
  const prompt: unknown = data.prompt
  if (typeof prompt !== 'object' || prompt === null || !('id' in prompt)) {
    return undefined
  }
  return typeof prompt.id === 'string' && prompt.id !== ''
    ? prompt.id
    : undefined
}

/**
 * Pi entry point: reports open guardrails prompts as Herdr's blocked
 * state. Only emits on Pi's in-process event bus; it has no effect unless
 * Herdr's Pi integration listens.
 *
 * @param pi - The extension API.
 */
export default function herdr (pi: ExtensionAPI): void {
  const open = new Set<string>()

  const stopOpened = pi.events.on(PROMPT_OPENED, (data) => {
    const id = promptId(data)
    if (id === undefined || open.has(id)) {
      return
    }
    open.add(id)
    pi.events.emit(HERDR_BLOCKED, {
      active: true, label: 'Guardrails approval required'
    })
  })
  const stopClosed = pi.events.on(PROMPT_CLOSED, (data) => {
    const id = promptId(data)
    if (id === undefined || !open.delete(id)) {
      return
    }
    pi.events.emit(HERDR_BLOCKED, { active: false })
  })

  pi.on('session_shutdown', () => {
    for (let i = 0; i < open.size; i++) {
      pi.events.emit(HERDR_BLOCKED, { active: false })
    }
    open.clear()
    stopOpened()
    stopClosed()
  })
}
