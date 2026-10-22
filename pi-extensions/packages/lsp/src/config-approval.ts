import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ProjectConfig } from './project-config.ts'

/** File name under Pi's agent directory. */
const APPROVALS_FILE = 'pi-lsp-approvals.json'

function digest (text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function readApprovals (store: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(store, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null ||
      Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(Object.entries(parsed)
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

async function projectKey (dir: string): Promise<string> {
  return await realpath(dir).catch(() => dir)
}

/**
 * Whether the user approved this exact `.pi-lsp.json` for this project.
 * Any change to the file needs a new approval.
 *
 * @param store - The approvals file.
 * @param dir - The project directory.
 * @param text - The config file's current text.
 */
async function isConfigApproved (
  store: string,
  dir: string,
  text: string
): Promise<boolean> {
  const approvals = await readApprovals(store)
  return approvals[await projectKey(dir)] === digest(text)
}

/**
 * Records approval of a config file's current text (file mode 0600).
 *
 * @param store - The approvals file.
 * @param dir - The project directory.
 * @param text - The approved config text.
 */
async function approveConfig (
  store: string,
  dir: string,
  text: string
): Promise<void> {
  const approvals = await readApprovals(store)
  approvals[await projectKey(dir)] = digest(text)
  await mkdir(dirname(store), { recursive: true })
  await writeFile(store, `${JSON.stringify(approvals, null, 2)}\n`,
    { mode: 0o600 })
}

/**
 * What a config would run, for the approval prompt.
 *
 * @param config - The project config.
 * @returns One line per server, auto-start list and agent jar.
 */
function describeExecutableSettings (config: ProjectConfig): string {
  // Environment variables are shown too: NODE_OPTIONS and the like can make
  // a harmless-looking command load other code.
  const servers = Object.entries(config.servers).map(([id, server]) => {
    const env = Object.entries(server.env ?? {})
      .map(([name, value]) => `${name}=${value}`)
    return `• ${id}: ${[...env, server.command, ...server.args].join(' ')}`
  })
  return [
    ...(servers.length > 0 ? ['Language servers:', ...servers] : []),
    ...(config.autoStart.length > 0
      ? [`Start at launch: ${config.autoStart.join(', ')}`]
      : []),
    ...(config.lombokJar === undefined
      ? []
      : [`Java agent jar: ${config.lombokJar}`])
  ].join('\n')
}

/**
 * The approvals file under an agent directory.
 *
 * @param agentDir - Pi's agent directory.
 */
function approvalsPath (agentDir: string): string {
  return join(agentDir, APPROVALS_FILE)
}

export {
  approvalsPath,
  approveConfig,
  describeExecutableSettings,
  isConfigApproved
}
