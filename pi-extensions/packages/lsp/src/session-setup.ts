import { getAgentDir } from '@earendil-works/pi-coding-agent'

import {
  approvalsPath,
  approveConfig,
  describeExecutableSettings,
  isConfigApproved
} from './config-approval.ts'
import { isWorkspaceProvider } from './lsp/workspace-provider.ts'
import {
  CONFIG_FILE,
  EMPTY_CONFIG,
  hasExecutableSettings,
  loadProjectConfig,
  withoutExecutableSettings
} from './project-config.ts'

import type {
  ExtensionAPI,
  ExtensionContext
} from '@earendil-works/pi-coding-agent'

import type { LspRuntime } from './lsp-runtime.ts'
import type { StatusColour } from './lsp-status.ts'
import type { LoadedConfig, ProjectConfig } from './project-config.ts'

/** Where a provider registered before this extension loaded is left. */
const EARLY_PROVIDER_PROPERTY = 'lsp:workspace-provider'

/**
 * Accepts workspace providers from other extensions over the event bus,
 * including one registered before this extension loaded. Anything that
 * does not have the provider shape is ignored.
 *
 * @param pi - The extension API.
 * @param runtime - The LSP runtime.
 * @param channel - The registration event.
 * @param onStatus - Shows the provider's status text.
 */
function registerProviderListener (
  pi: ExtensionAPI,
  runtime: LspRuntime,
  channel: string,
  onStatus: (text: string) => void
): void {
  const apply = (data: unknown): void => {
    if (!isWorkspaceProvider(data)) {
      return
    }
    runtime.setWorkspaceProvider(data)
    const text = data.getStatusText()
    if (text !== '') {
      onStatus(text)
    }
  }
  pi.events.on(channel, apply)
  const early: unknown = Reflect.get(pi.events, EARLY_PROVIDER_PROPERTY)
  if (early !== undefined) {
    apply(early)
  }
}

type ApprovalContext = Pick<ExtensionContext,
'cwd' | 'hasUI' | 'isProjectTrusted' | 'ui'>

type SetStatus = (colour: StatusColour, text: string) => void

/**
 * Whether the program-running parts of a config (servers, autoStart, the
 * Lombok agent jar) may be used without asking: there are none, or the
 * user approved this exact file for this project. Pi's project trust is
 * required but not enough, since a folder without `.pi` resources counts
 * as trusted without anyone being asked.
 *
 * @param ctx - The session context.
 * @param loaded - The loaded config file.
 * @param store - The approvals file.
 */
async function isPreApproved (
  ctx: ApprovalContext,
  loaded: LoadedConfig,
  store: string
): Promise<boolean> {
  return !hasExecutableSettings(loaded.config) ||
    (ctx.isProjectTrusted() &&
      await isConfigApproved(store, ctx.cwd, loaded.text))
}

/**
 * Asks the user to approve a config's program-running parts and records
 * a yes. Untrusted projects and sessions without UI are never asked.
 *
 * @param ctx - The session context.
 * @param loaded - The loaded config file.
 * @param store - The approvals file.
 * @returns True when approved.
 */
async function askApproval (
  ctx: ApprovalContext,
  loaded: LoadedConfig,
  store: string
): Promise<boolean> {
  let approved = false
  if (ctx.isProjectTrusted() && ctx.hasUI) {
    approved = await ctx.ui.confirm(`Allow ${CONFIG_FILE} to run programs?`,
      `${ctx.cwd}/${CONFIG_FILE} asks to run:\n\n` +
      `${describeExecutableSettings(loaded.config)}\n\nOnly allow this if ` +
      'you trust this project. Approval is remembered until the file ' +
      'changes.')
  }
  if (approved) {
    await approveConfig(store, ctx.cwd, loaded.text)
  } else {
    ctx.ui.notify(`${CONFIG_FILE}: servers, autoStart and lombokJar are ` +
      'ignored because they were not approved.', 'warning')
  }
  return approved
}

/** Applies a config's Lombok jar and starts its `autoStart` servers. */
function applyStartup (
  runtime: LspRuntime,
  config: ProjectConfig,
  setStatus: SetStatus
): void {
  const manager = runtime.manager
  if (config.lombokJar !== undefined && config.lombokJar !== 'auto') {
    manager.setLombokJar(config.lombokJar)
  }
  if (config.autoStart.length > 0) {
    const lombok = config.autoStart.includes('java')
      ? manager.getLombokJar()
      : undefined
    const note = lombok === undefined
      ? ''
      : ` (lombok: ${lombok.split('/').pop() ?? lombok})`
    setStatus('warning',
      `LSP: auto-starting ${config.autoStart.join(', ')}${note}...`)
    manager.startEagerly(config.autoStart)
  }
}

/**
 * Sets up LSP state for a session from `.pi-lsp.json`. Program-running
 * settings apply at once when already approved; otherwise the session
 * starts without them and they apply if the user approves. The prompt is
 * not awaited here: blocking `session_start` on a dialog stalls startup.
 *
 * @param ctx - The session context.
 * @param runtime - The LSP runtime.
 * @param setStatus - Updates the footer status.
 */
async function startSession (
  ctx: ExtensionContext,
  runtime: LspRuntime,
  setStatus: SetStatus
): Promise<void> {
  const loaded = await loadProjectConfig(ctx.cwd)
  for (const warning of loaded?.warnings ?? []) {
    ctx.ui.notify(`${CONFIG_FILE}: ${warning}`, 'warning')
  }
  const store = approvalsPath(getAgentDir())
  const full = loaded?.config ?? EMPTY_CONFIG
  const approved = loaded === undefined ||
    await isPreApproved(ctx, loaded, store)

  await runtime.reset(ctx.cwd,
    approved ? full : withoutExecutableSettings(full))
  runtime.treeSitter.init().catch(() => {
    ctx.ui.notify('LSP: tree-sitter failed to load; syntax fallbacks are ' +
      'unavailable.', 'warning')
  })
  const providerText = runtime.workspaceProvider.getStatusText()
  setStatus(providerText === '' ? 'dim' : 'accent',
    providerText === '' ? 'LSP: idle' : `LSP: ${providerText}`)

  if (approved) {
    applyStartup(runtime, full, setStatus)
    return
  }
  if (loaded === undefined) {
    return
  }
  const manager = runtime.manager
  askApproval(ctx, loaded, store).then((ok) => {
    // Apply only to the session that asked.
    if (ok && runtime.activeManager === manager) {
      for (const [languageId, server] of Object.entries(full.servers)) {
        manager.setServerConfig(languageId, server)
      }
      applyStartup(runtime, full, setStatus)
    }
  }, () => {})
}

export {
  askApproval,
  isPreApproved,
  registerProviderListener,
  startSession
}
