import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
  bashPolicyTargets,
  tokenPolicyTargets
} from '../core/path-candidates.ts'
import { expandHome } from '../core/paths.ts'
import { checkPolicy, policiesForTool } from './policy-rules.ts'

import type { PolicyTarget } from '../core/path-candidates.ts'
import type { CompiledPolicy, PolicyMatch } from './policy-rules.ts'

interface CheckEnvironment {
  readonly cwd: string
  readonly home?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly exists?: (path: string) => boolean
}

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])

function stringField (
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return undefined
}

/**
 * Files a tool call may touch, as written.
 *
 * @param toolName - The tool being called.
 * @param input - Its arguments.
 * @param env - Working directory, home and environment.
 * @returns Targets to check against policies.
 */
function toolPolicyTargets (
  toolName: string,
  input: Record<string, unknown>,
  env: CheckEnvironment
): PolicyTarget[] {
  const home = env.home ?? homedir()
  if (FILE_TOOLS.has(toolName)) {
    const path = stringField(input, 'path', 'file_path')
    const targets: PolicyTarget[] = path === undefined
      ? []
      : [{ path, unresolved: false }]
    // `grep` with a glob names the files it will read.
    const glob = toolName === 'grep' ? stringField(input, 'glob') : undefined
    if (glob !== undefined) {
      targets.push({
        path: path === undefined ? glob : join(path, glob),
        unresolved: false
      }, { path: glob, unresolved: false })
    }
    return targets
  }
  const command = stringField(input, 'command')
  if (command === undefined) {
    return []
  }
  if (toolName === 'bash') {
    return bashPolicyTargets(command, {
      cwd: env.cwd, home, environment: env.environment, exists: env.exists
    })
  }
  if (toolName === 'powershell') {
    return tokenPolicyTargets(command)
  }
  return []
}

/**
 * The first policy a tool call breaks, checking the strictest policies
 * first.
 *
 * @param toolName - The tool being called.
 * @param input - Its arguments.
 * @param policies - Compiled policies, including self-protection.
 * @param env - Working directory, home, environment and probes.
 * @returns The match, or undefined when the call is allowed.
 */
function checkToolCall (
  toolName: string,
  input: Record<string, unknown>,
  policies: readonly CompiledPolicy[],
  env: CheckEnvironment
): PolicyMatch | undefined {
  const applicable = policiesForTool(policies, toolName)
  if (applicable.length === 0) {
    return undefined
  }
  const targets = toolPolicyTargets(toolName, input, env)
  for (const policy of applicable) {
    for (const target of targets) {
      const match = checkPolicy(policy, target, env)
      if (match !== undefined) {
        return match
      }
    }
  }
  return undefined
}

const GREP_LINE = /^(.+?)([:-])(\d+)\2 /

function isDirectory (path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Removes lines from protected files out of a `grep` tool result. The grep
 * tool searches whole directories, so a protected file that is not
 * gitignored would otherwise appear in its output.
 *
 * @param text - The tool's text output.
 * @param searchPath - The tool's `path` argument, if any.
 * @param policies - Compiled noAccess policies.
 * @param env - Working directory and home.
 * @returns The text with protected lines replaced, and whether any were.
 */
function redactGrepOutput (
  text: string,
  searchPath: string | undefined,
  policies: readonly CompiledPolicy[],
  env: CheckEnvironment
): { text: string, redacted: boolean } {
  const noAccess = policies.filter((policy) => policy.protection === 'noAccess')
  if (noAccess.length === 0) {
    return { text, redacted: false }
  }
  const home = env.home ?? homedir()
  const root = resolve(env.cwd, expandHome(searchPath ?? '.', home))
  const rootIsDirectory = isDirectory(root)
  const cache = new Map<string, PolicyMatch | undefined>()
  let redacted = false

  const protectedBy = (shown: string): PolicyMatch | undefined => {
    if (!cache.has(shown)) {
      const file = rootIsDirectory
        ? resolve(root, shown)
        : basename(root) === shown ? root : resolve(dirname(root), shown)
      const match = noAccess
        .map((policy) => checkPolicy(policy, { path: file, unresolved: false },
          { ...env, home }))
        .find((item) => item !== undefined)
      cache.set(shown, match)
    }
    return cache.get(shown)
  }

  const lines = text.split('\n').map((line) => {
    const parsed = GREP_LINE.exec(line)
    const shown = parsed?.[1]
    if (parsed === null || shown === undefined) {
      return line
    }
    const match = protectedBy(shown)
    if (match === undefined) {
      return line
    }
    redacted = true
    return `${shown}${parsed[2] ?? ':'}${parsed[3] ?? ''}${parsed[2] ?? ':'} ` +
      `[redacted by guardrails: ${match.ruleId}]`
  })
  return { text: lines.join('\n'), redacted }
}

export { checkToolCall, redactGrepOutput, toolPolicyTargets }
export type { CheckEnvironment }
