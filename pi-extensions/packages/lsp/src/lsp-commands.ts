import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { statusReport } from './lsp-status.ts'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import type { LspRuntime } from './lsp-runtime.ts'
import type { StatusColour } from './lsp-status.ts'

type SetStatus = (colour: StatusColour, text: string) => void

const SAFE_LANGUAGE_ID = /^[A-Za-z0-9_+-]+$/

/**
 * Registers `/lsp`, `/lsp-restart`, `/lsp-config` and `/lsp-lombok`.
 *
 * @param pi - The extension API.
 * @param runtime - The LSP runtime.
 * @param setStatus - Updates the footer status.
 */
function registerLspCommands (
  pi: ExtensionAPI,
  runtime: LspRuntime,
  setStatus: SetStatus
): void {
  pi.registerCommand('lsp', {
    description: 'Show LSP server status',
    handler: async (_args, ctx) => {
      const manager = runtime.activeManager
      if (manager === undefined) {
        ctx.ui.notify('LSP manager not initialized', 'warning')
        return
      }
      const statuses = manager.getStatus()
      ctx.ui.notify(statuses.length === 0
        ? 'No LSP servers configured'
        : statusReport(statuses), 'info')
    }
  })

  pi.registerCommand('lsp-restart', {
    description: 'Restart an LSP server: /lsp-restart <language> (e.g. java, typescript)',
    handler: async (args, ctx) => {
      const manager = runtime.activeManager
      if (manager === undefined) {
        ctx.ui.notify('LSP manager not initialized', 'warning')
        return
      }
      const languageId = args.trim().toLowerCase()
      if (languageId === '') {
        const running = manager.getStatus().filter((s) => s.running)
          .map((s) => s.languageId)
        ctx.ui.notify(running.length === 0
          ? 'No LSP servers are running.\n\nUsage: /lsp-restart <language>'
          : `Running servers: ${running.join(', ')}\n\nUsage: ` +
            '/lsp-restart <language>\nExample: /lsp-restart java', 'info')
        return
      }
      setStatus('warning', `LSP: restarting ${languageId}...`)
      ctx.ui.notify(`Restarting ${languageId} server (stops its shared ` +
        'daemon too)...', 'info')
      try {
        await manager.restartServer(languageId)
        const lombok = languageId === 'java' ? manager.getLombokJar() : undefined
        ctx.ui.notify(`${languageId} server restarted.` +
          (lombok === undefined ? '' : `\nLombok: ${lombok}`), 'info')
        setStatus('accent', `LSP: ${languageId} ready`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`Failed to restart ${languageId}: ${message}`, 'error')
        setStatus('error', `LSP: ${languageId} restart failed`)
      }
    }
  })

  pi.registerCommand('lsp-config', {
    description: 'Configure an LSP server: /lsp-config <language> <command> [args...]',
    handler: async (args, ctx) => {
      const [languageId, command, ...serverArgs] = args.trim().split(/\s+/)
      if (languageId === undefined || languageId === '' ||
        command === undefined) {
        ctx.ui.notify('Usage: /lsp-config <language> <command> [args...]\n' +
          'Example: /lsp-config python pylsp', 'info')
        return
      }
      if (!SAFE_LANGUAGE_ID.test(languageId)) {
        ctx.ui.notify(`Invalid language id: ${languageId}`, 'warning')
        return
      }
      runtime.manager.setServerConfig(languageId,
        { command, args: serverArgs })
      ctx.ui.notify(`Configured LSP for ${languageId}: ` +
        `${[command, ...serverArgs].join(' ')}`, 'info')
    }
  })

  pi.registerCommand('lsp-lombok', {
    description: 'Set Lombok jar path for Java: /lsp-lombok <path-to-lombok.jar>',
    handler: async (args, ctx) => {
      const manager = runtime.manager
      const path = args.trim()
      if (path === '') {
        const current = manager.getLombokJar()
        ctx.ui.notify(current === undefined
          ? 'No Lombok jar configured or detected.\n\nUsage: /lsp-lombok ' +
            '<path-to-lombok.jar>\nOr set the LOMBOK_JAR environment ' +
            'variable.\n\nDownload from: https://projectlombok.org/download'
          : `Lombok jar: ${current}`, 'info')
        return
      }
      const jar = resolve(ctx.cwd, path)
      if (!existsSync(jar)) {
        ctx.ui.notify(`File not found: ${jar}`, 'error')
        return
      }
      if (!jar.endsWith('.jar')) {
        ctx.ui.notify(`Warning: ${basename(jar)} doesn't end in .jar — ` +
          'setting anyway', 'warning')
      }
      manager.setLombokJar(jar)
      ctx.ui.notify(`Lombok jar set: ${jar}\nRun /lsp-restart java to ` +
        'apply it.', 'info')
    }
  })
}

export { registerLspCommands }
