/*
 * LSP base-protocol framing (Content-Length headers). Used by the daemon,
 * which node runs directly, so this file must stay erasable TypeScript with
 * only node built-in imports.
 */

interface JsonRpcMessage {
  readonly jsonrpc: '2.0'
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii')
const CONTENT_LENGTH = /^Content-Length:\s*(\d+)\s*$/im

// Refuse absurd frames instead of buffering without bound.
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

function isJsonRpcMessage (value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null &&
    'jsonrpc' in value && value.jsonrpc === '2.0'
}

/**
 * Encodes a message with its Content-Length header.
 *
 * @param message - The JSON-RPC message.
 * @returns The framed bytes.
 */
function encodeMessage (message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/** Splits a byte stream into JSON-RPC messages. */
class MessageParser {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly onMessage: (message: JsonRpcMessage) => void
  private readonly onError: (error: Error) => void

  constructor (
    onMessage: (message: JsonRpcMessage) => void,
    onError: (error: Error) => void = () => {}
  ) {
    this.onMessage = onMessage
    this.onError = onError
  }

  feed (chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END)
      if (headerEnd === -1) {
        return
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = CONTENT_LENGTH.exec(header)
      const length = match?.[1] === undefined ? NaN : Number(match[1])
      if (Number.isNaN(length) || length > MAX_MESSAGE_BYTES) {
        this.buffer = Buffer.alloc(0)
        this.onError(new Error('Invalid LSP message header'))
        return
      }
      const bodyStart = headerEnd + HEADER_END.length
      if (this.buffer.length < bodyStart + length) {
        return
      }
      const body = this.buffer.subarray(bodyStart, bodyStart + length)
      this.buffer = this.buffer.subarray(bodyStart + length)
      this.emit(body.toString('utf8'))
    }
  }

  private emit (body: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      this.onError(new Error('Invalid JSON in LSP message'))
      return
    }
    if (isJsonRpcMessage(parsed)) {
      this.onMessage(parsed)
    } else {
      this.onError(new Error('Not a JSON-RPC 2.0 message'))
    }
  }
}

export { encodeMessage, isJsonRpcMessage, MAX_MESSAGE_BYTES, MessageParser }
export type { JsonRpcMessage }
