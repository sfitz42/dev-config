import { homedir } from 'node:os'
import { dirname } from 'node:path'

import {
  getDocsPath,
  getExamplesPath,
  getReadmePath
} from '@earendil-works/pi-coding-agent'

import {
  displayPath,
  isGrantTooBroad,
  toStorageGrant
} from '../core/paths.ts'
import {
  announceFeature,
  emitBlocked,
  withPromptEvents
} from '../events.ts'
import { createRuntime } from '../runtime.ts'
import {
  decidePathAccess,
  isReadOnlyTool,
  resolveAllowedPaths,
  targetsForTool
} from './path-check.ts'
import { createPathPrompt, promptOptions } from './path-prompt.ts'

import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

import type { AllowedPath } from '../core/paths.ts'
import type { Runtime } from '../runtime.ts'
import type { PathPromptRequest, PathPromptResult } from './path-prompt.ts'

/** Pi's own docs, which the model is told to read. */
function documentationGrants (): AllowedPath[] {
  try {
    return [
      { kind: 'file', path: getReadmePath() },
      { kind: 'directory', path: getDocsPath() },
      { kind: 'directory', path: getExamplesPath() }
    ]
  } catch {
    return []
  }
}

async function askPath (
  ctx: ExtensionContext,
  request: PathPromptRequest
): Promise<PathPromptResult> {
  if (ctx.mode === 'tui') {
    return await ctx.ui.custom<PathPromptResult>(createPathPrompt(request))
  }
  const options = promptOptions(request)
  const note = request.fileOptions && request.grantable
    ? '\nDirectory grants apply to the parent directory.'
    : ''
  const choice = await ctx.ui.select(
    `Allow access to ${request.displayPath}? (outside ${request.cwd})${note}`,
    options.map((option) => option.label))
  return options.find((option) => option.label === choice)?.result ?? 'deny'
}

async function persistGrant (
  runtime: Runtime,
  ctx: ExtensionContext,
  grant: AllowedPath,
  scope: 'memory' | 'local' | 'global'
): Promise<void> {
  const save = async (target: 'memory' | 'local' | 'global'): Promise<void> => {
    const raw = runtime.loader.raw(target) ?? {}
    const existing = raw.pathAccess?.allowedPaths ?? []
    if (existing.some((entry) =>
      entry.kind === grant.kind && entry.path === grant.path)) {
      return
    }
    await runtime.loader.save(target, {
      ...raw,
      pathAccess: { ...raw.pathAccess, allowedPaths: [...existing, grant] }
    })
  }
  await save(scope)
  if (scope === 'local' && !runtime.loader.trusted) {
    // The project file is ignored until the project is trusted.
    await save('memory')
    ctx.ui.notify('Grant saved to the project config, which applies once ' +
      'the project is trusted; allowed for this session meanwhile.', 'info')
  }
  if (scope !== 'memory') {
    runtime.notifyChanged()
  }
}

/**
 * Pi entry point: prompts before tools touch paths outside the working
 * directory.
 *
 * @param pi - The extension API.
 */
export default function pathAccess (pi: ExtensionAPI): void {
  const runtime = createRuntime(pi)
  const home = homedir()
  const docs = documentationGrants()
  let skills: AllowedPath[] = []

  announceFeature(pi, 'pathAccess')

  pi.on('before_agent_start', (event) => {
    skills = (event.systemPromptOptions.skills ?? []).flatMap((skill) => [
      { kind: 'file' as const, path: skill.filePath },
      { kind: 'directory' as const, path: skill.baseDir }
    ])
  })

  pi.on('tool_call', async (event, ctx) => {
    await runtime.ensureLoaded(ctx)
    const config = runtime.loader.config
    const settings = config.pathAccess
    if (!config.enabled || !config.features.pathAccess ||
      settings.mode === 'allow') {
      return undefined
    }
    const readOnly = isReadOnlyTool(event.toolName)
    if (settings.applyTo === 'write' && readOnly) {
      return undefined
    }
    const input = event.input as Record<string, unknown>
    const targets = targetsForTool(event.toolName, input, {
      cwd: ctx.cwd, home, environment: process.env
    })
    const accepted: AllowedPath[] = []

    for (const target of targets) {
      // Re-read each time: an earlier prompt in this call may have saved one.
      const allowedPaths = [
        ...resolveAllowedPaths(runtime.loader.config.pathAccess.allowedPaths,
          ctx.cwd, home),
        ...(readOnly ? [...docs, ...skills] : []),
        ...accepted
      ]
      const decision = decidePathAccess(target, {
        cwd: ctx.cwd, mode: settings.mode, allowedPaths, hasUI: ctx.hasUI
      }, home)
      if (decision.kind === 'allow') {
        continue
      }
      const action = {
        kind: 'file' as const,
        path: target.kind === 'path' ? target.absolutePath : target.text,
        origin: event.toolName
      }
      const metadata = {
        absolutePath: decision.kind === 'ask' ? decision.absolutePath : undefined,
        displayPath: decision.kind === 'ask' ? decision.displayPath : action.path
      }
      if (decision.kind === 'deny') {
        emitBlocked(pi, {
          feature: 'pathAccess',
          action,
          reason: decision.reason,
          block: { source: ctx.hasUI ? 'policy' : 'nonInteractive', metadata },
          context: { toolName: event.toolName, input }
        })
        return { block: true, reason: decision.reason }
      }

      const absolutePath = decision.absolutePath
      const fileOptions = event.toolName !== 'ls' && event.toolName !== 'find'
      const directory = absolutePath === undefined
        ? undefined
        : fileOptions ? dirname(absolutePath) : absolutePath
      const reason = `Access to ${decision.displayPath} requires confirmation.`
      const result = await withPromptEvents(pi, {
        feature: 'pathAccess',
        action,
        reason,
        prompt: { kind: 'confirmation', metadata },
        context: { toolName: event.toolName, input }
      }, async () => await askPath(ctx, {
        toolName: event.toolName,
        displayPath: decision.displayPath,
        displayDirectory: directory === undefined
          ? undefined
          : displayPath(directory, ctx.cwd, home),
        cwd: ctx.cwd,
        fileOptions,
        directoryGrantable: directory !== undefined &&
          !isGrantTooBroad(directory, home),
        grantable: absolutePath !== undefined,
        command: typeof input.command === 'string' ? input.command : undefined
      }))

      if (result === 'allow-file-once' || result === 'allow-dir-once') {
        continue
      }
      if (result !== 'deny' && absolutePath !== undefined) {
        const isDirectory = result.startsWith('allow-dir')
        const grantPath = isDirectory ? directory ?? absolutePath : absolutePath
        if (isDirectory && isGrantTooBroad(grantPath, home)) {
          ctx.ui.notify(`Cannot grant ${displayPath(grantPath, ctx.cwd, home)}: ` +
            'too broad. Allowed once.', 'warning')
          continue
        }
        accepted.push({ kind: isDirectory ? 'directory' : 'file', path: grantPath })
        const scope = result.endsWith('-session')
          ? 'memory'
          : settings.alwaysScope
        await persistGrant(runtime, ctx,
          toStorageGrant(grantPath, isDirectory, home), scope)
        continue
      }

      const denied = 'User denied access outside working directory'
      emitBlocked(pi, {
        feature: 'pathAccess',
        action,
        reason: denied,
        block: { source: 'user', metadata },
        context: { toolName: event.toolName, input }
      })
      return { block: true, reason: denied }
    }
    return undefined
  })
}
