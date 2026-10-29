import {
  isEditToolResult,
  isReadToolResult,
  isWriteToolResult
} from '@earendil-works/pi-coding-agent'

import { REGISTER_PROVIDER_EVENT } from './lsp/workspace-provider.ts'
import { registerLspCommands } from './lsp-commands.ts'
import { LspRuntime } from './lsp-runtime.ts'
import { footerStatus } from './lsp-status.ts'
import { registerProviderListener, startSession } from './session-setup.ts'
import { createAstSearchTool } from './tools/ast-search-tool.ts'
import { createCodeActionsTool } from './tools/code-actions-tool.ts'
import { createCodeOverviewTool } from './tools/code-overview-tool.ts'
import { createCodeRewriteTool } from './tools/code-rewrite-tool.ts'
import { createCompletionsTool } from './tools/completions-tool.ts'
import { createDefinitionTool } from './tools/definition-tool.ts'
import { injectedErrorNote } from './tools/diagnostic-format.ts'
import {
  createDiagnosticsTool,
  DIAGNOSTIC_SETTLE_MS,
  sleep
} from './tools/diagnostics-tool.ts'
import { createHoverTool } from './tools/hover-tool.ts'
import { createReferencesTool } from './tools/references-tool.ts'
import { createRenameTool } from './tools/rename-tool.ts'
import { createSymbolsTool } from './tools/symbols-tool.ts'
import { displayPath } from './tools/tool-support.ts'
import { shouldInjectDiagnostics } from './project-config.ts'

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent
} from '@earendil-works/pi-coding-agent'

import type { StatusColour } from './lsp-status.ts'

function inputPath (event: ToolResultEvent): string | undefined {
  const path = event.input.path
  return typeof path === 'string' && path !== '' ? path : undefined
}

/**
 * Pi entry point: LSP and tree-sitter code intelligence tools, file sync
 * with language servers, and the `/lsp*` commands.
 *
 * @param pi - The extension API for this runtime.
 */
export default function lsp (pi: ExtensionAPI): void {
  // Lifecycle callbacks can fire after the session that started a server
  // has gone; they then find no context and do nothing.
  let context: ExtensionContext | undefined
  const withContext = (fn: (ctx: ExtensionContext) => void): void => {
    if (context === undefined) {
      return
    }
    try {
      fn(context)
    } catch {
      context = undefined
    }
  }
  const setStatus = (colour: StatusColour, text: string): void => {
    withContext((ctx) => ctx.ui.setStatus('lsp', ctx.ui.theme.fg(colour, text)))
  }

  const runtime = new LspRuntime({
    onWorkspaceSetupStart: () => setStatus('warning', 'LSP: workspace setup...'),
    onWorkspaceSetupEnd: (success, ms) => {
      const seconds = (ms / 1000).toFixed(1)
      setStatus(success ? 'accent' : 'warning', success
        ? `LSP: workspace ready (${seconds}s)`
        : `LSP: workspace setup failed (${seconds}s)`)
    },
    onServerStart: (languageId, command) =>
      setStatus('warning', `LSP: starting ${languageId} (${command})...`),
    onServerReady: (languageId) => setStatus('accent', `LSP: ${languageId} ready`),
    onServerError: (languageId) => setStatus('error', `LSP: ${languageId} failed`),
    onServerNotice: (_languageId, message, level) =>
      withContext((ctx) => ctx.ui.notify(message, level)),
    onServerCrash: (languageId, restarting, attempt) => setStatus(
      restarting ? 'warning' : 'error', restarting
        ? `LSP: restarting ${languageId}... (attempt ${attempt}/3)`
        : `LSP: ${languageId} crashed — auto-restart exhausted`)
  })

  registerProviderListener(pi, runtime, REGISTER_PROVIDER_EVENT, (text) =>
    setStatus('accent', `LSP: ${text}`))

  pi.on('session_start', async (_event, ctx) => {
    context = ctx
    await startSession(ctx, runtime, setStatus)
  })

  pi.registerTool(createDiagnosticsTool(runtime))
  pi.registerTool(createHoverTool(runtime))
  pi.registerTool(createDefinitionTool(runtime))
  pi.registerTool(createReferencesTool(runtime))
  pi.registerTool(createSymbolsTool(runtime))
  pi.registerTool(createRenameTool(runtime))
  pi.registerTool(createCodeActionsTool(runtime))
  pi.registerTool(createCompletionsTool(runtime))
  pi.registerTool(createCodeOverviewTool(runtime))
  pi.registerTool(createAstSearchTool(runtime))
  pi.registerTool(createCodeRewriteTool(runtime))

  pi.on('tool_result', async (event) => {
    const path = inputPath(event)
    if (path === undefined || event.isError) {
      return undefined
    }
    const isRead = isReadToolResult(event)
    const isWrite = isWriteToolResult(event) || isEditToolResult(event)
    if (!isRead && !isWrite) {
      return undefined
    }
    const sync = runtime.fileSync
    await (isRead ? sync.handleFileRead(path) : sync.handleFileWrite(path))
      .catch(() => {})
    if (!isWrite) {
      return undefined
    }

    // Append the edited file's errors, from a server that is already up.
    const manager = runtime.manager
    const languageId = manager.getLanguageId(path)
    if (languageId === undefined ||
      !shouldInjectDiagnostics(runtime.projectConfig, languageId)) {
      return undefined
    }
    const client = manager.getRunningClient(languageId)
    if (client === undefined) {
      return undefined
    }
    await sleep(DIAGNOSTIC_SETTLE_MS)
    const note = injectedErrorNote(
      client.getDiagnostics(manager.getFileUri(path)),
      displayPath(manager.rootDir, manager.resolvePath(path)))
    return note === undefined
      ? undefined
      : { content: [...event.content, { type: 'text' as const, text: note }] }
  })

  pi.on('tool_execution_end', (_event, ctx) => {
    context = ctx
    const manager = runtime.activeManager
    if (manager !== undefined) {
      const status = footerStatus(manager.getStatus())
      setStatus(status.colour, status.text)
    }
  })

  registerLspCommands(pi, runtime, setStatus)

  pi.on('session_shutdown', async () => {
    context = undefined
    await runtime.shutdown()
  })
}
