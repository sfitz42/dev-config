import type { Checkpoint } from './checkpoint-types.ts'

/** Tools that can change files, so a turn using one gets a checkpoint. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'bash'])

function truncate (text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function stringField (input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) {
    return '?'
  }
  const value: unknown = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : '?'
}

/**
 * Describes a mutating tool call for a checkpoint label.
 *
 * @param toolName - The tool's name.
 * @param input - The call's arguments, as received.
 * @returns e.g. `write → src/a.ts` or `bash: npm test`.
 */
function describeToolCall (toolName: string, input: unknown): string {
  switch (toolName) {
    case 'write':
    case 'edit':
      return `${toolName} → ${stringField(input, 'path')}`
    case 'bash':
      return `bash: ${truncate(stringField(input, 'command'), 50)}`
    default:
      return toolName
  }
}

/**
 * Builds a turn checkpoint's description from the prompt and its tools.
 *
 * @returns `"prompt" → tool, tool`, whichever parts exist, or `Turn n`.
 */
function describeTurn (
  prompt: string,
  tools: readonly string[],
  turnIndex: number
): string {
  const parts = [
    prompt === '' ? '' : `"${prompt}"`,
    tools.join(', ')
  ].filter((part) => part !== '')
  return parts.length > 0 ? parts.join(' → ') : `Turn ${turnIndex}`
}

function formatTime (timestamp: number): string {
  const date = new Date(timestamp)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

/**
 * Labels a checkpoint in a picker.
 *
 * @param checkpoint - The checkpoint.
 * @param position - Its 1-based position in the list.
 * @param branch - The current branch (null when detached).
 * @returns e.g. `#2 [14:03:07] [main] "fix it" → edit → a.ts`, with
 *   `⚠️ other` in place of `[main]` when the branch differs.
 */
function checkpointLabel (
  checkpoint: Checkpoint,
  position: number,
  branch: string | null
): string {
  const name = checkpoint.branch ?? 'detached'
  const tag = checkpoint.branch === branch ? `[${name}]` : `⚠️ ${name}`
  return `#${position} [${formatTime(checkpoint.timestamp)}] ${tag} ` +
    checkpoint.description
}

export {
  checkpointLabel,
  describeToolCall,
  describeTurn,
  formatTime,
  MUTATING_TOOLS,
  truncate
}
