import { createAskUserTool, TOOL_NAME } from './ask-user-tool.ts'
import { askToolCard, registerTernTool } from './tern.ts'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * Pi entry point: the `ask_user` tool, plus its optional Tern card.
 *
 * @param pi - The extension API for this runtime.
 */
export default function askUser (pi: ExtensionAPI): void {
  pi.registerTool(createAskUserTool(pi, process.env))
  registerTernTool(pi, TOOL_NAME, askToolCard)
}
