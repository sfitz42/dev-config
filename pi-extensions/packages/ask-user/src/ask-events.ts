import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import type { AskResponse, QuestionSubject } from './ask-types.ts'

interface BatchPosition {
  readonly index: number
  readonly total: number
}

interface AskEvents {
  answered: (
    subject: QuestionSubject,
    response: AskResponse,
    batch?: BatchPosition
  ) => void
  cancelled: (subject: QuestionSubject, batch?: BatchPosition) => void
}

/**
 * Publishes `ask:answered` / `ask:cancelled` to every extension. Unless
 * `full` is set, only the question and the response kind are shared; the
 * context and the user's words stay in the tool result.
 *
 * @param pi - The extension API.
 * @param full - Include context, options and the full response.
 * @returns The two emitters.
 */
function createAskEvents (
  pi: Pick<ExtensionAPI, 'events'>,
  full: boolean
): AskEvents {
  const position = (batch?: BatchPosition): { batch?: BatchPosition } =>
    batch === undefined ? {} : { batch }
  return {
    answered (subject, response, batch) {
      pi.events.emit('ask:answered', full
        ? {
            question: subject.question,
            context: subject.context,
            response,
            ...position(batch)
          }
        : {
            question: subject.question,
            response: { kind: response.kind },
            ...position(batch)
          })
    },
    cancelled (subject, batch) {
      pi.events.emit('ask:cancelled', full
        ? {
            question: subject.question,
            context: subject.context,
            options: subject.options,
            ...position(batch)
          }
        : { question: subject.question, ...position(batch) })
    }
  }
}

export { createAskEvents }
export type { AskEvents, BatchPosition }
