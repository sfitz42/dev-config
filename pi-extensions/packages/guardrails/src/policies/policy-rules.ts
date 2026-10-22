import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { expandHome, isWithin, pathForms } from '../core/paths.ts'
import {
  compileFilePattern,
  exactRegex,
  normalizeFilePath
} from '../core/patterns.ts'

import type { CompiledPattern } from '../core/patterns.ts'
import type { PolicyRule, Protection } from '../config/config-schema.ts'

interface CompiledPolicy {
  readonly id: string
  readonly protection: Protection
  readonly patterns: readonly CompiledPattern[]
  readonly allowedPatterns: readonly CompiledPattern[]
  readonly onlyIfExists: boolean
  readonly respectCwd: boolean
  readonly blockMessage: string
}

interface PolicyTarget {
  readonly path: string
  readonly unresolved: boolean
}

interface PolicyMatch {
  readonly ruleId: string
  readonly protection: Protection
  readonly path: string
  readonly reason: string
}

interface PolicyEnvironment {
  readonly cwd: string
  readonly home?: string
  readonly exists?: (path: string) => boolean
}

const DEFAULT_MESSAGES: Readonly<Record<Protection, string>> = {
  noAccess: 'Accessing {file} is not allowed. This file is protected. ' +
    'Ask the user if changes are needed.',
  readOnly: 'Writing to {file} is not allowed. This file is read-only. ' +
    'Use the read tool to inspect it instead.',
  none: ''
}

/** Tools each protection level blocks. */
const BLOCKED_TOOLS: Readonly<Record<Protection, ReadonlySet<string>>> = {
  noAccess: new Set([
    'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'powershell'
  ]),
  readOnly: new Set(['write', 'edit', 'bash', 'powershell']),
  none: new Set()
}

const RANK: Readonly<Record<Protection, number>> = {
  noAccess: 2, readOnly: 1, none: 0
}

function compilePolicies (rules: readonly PolicyRule[]): CompiledPolicy[] {
  return rules
    .filter((rule) => rule.enabled !== false && rule.id.trim() !== '' &&
      rule.patterns.length > 0)
    .map((rule) => ({
      id: rule.id,
      protection: rule.protection,
      patterns: rule.patterns.map(compileFilePattern),
      allowedPatterns: (rule.allowedPatterns ?? []).map(compileFilePattern),
      onlyIfExists: rule.onlyIfExists ?? true,
      respectCwd: rule.respectCwd ?? true,
      blockMessage: rule.blockMessage ?? DEFAULT_MESSAGES[rule.protection]
    }))
    .sort((a, b) => RANK[b.protection] - RANK[a.protection])
}

/** Policies that apply to a tool, strictest first. */
function policiesForTool (
  policies: readonly CompiledPolicy[],
  toolName: string
): CompiledPolicy[] {
  return policies.filter((policy) =>
    BLOCKED_TOOLS[policy.protection].has(toolName))
}

function isLocationAnchored (pattern: CompiledPattern): boolean {
  if (pattern.source.regex === true) {
    return false
  }
  const value = normalizeFilePath(pattern.source.pattern)
  return value === '~' || value.startsWith('~/') || value.startsWith('/')
}

/**
 * Spellings of a path that patterns are tested against: cwd-relative,
 * `~/...` and absolute, for both the path and its symlink target.
 */
function targetForms (
  path: string,
  cwd: string,
  home: string
): { forms: string[], absolutes: string[] } {
  const absolute = resolve(cwd, expandHome(path, home))
  const absolutes = pathForms(absolute)
  const forms = new Set<string>()
  for (const item of absolutes) {
    if (isWithin(item, cwd)) {
      forms.add(normalizeFilePath(relative(cwd, item) || '.'))
    }
    if (item === home) {
      forms.add('~')
    } else if (isWithin(item, home)) {
      forms.add(`~/${normalizeFilePath(relative(home, item))}`)
    }
    forms.add(normalizeFilePath(item))
  }
  if (!isAbsolute(path) && !path.startsWith('~')) {
    forms.add(normalizeFilePath(path))
  }
  return { forms: [...forms], absolutes }
}

function displayTarget (path: string, cwd: string, home: string): string {
  const absolute = resolve(cwd, expandHome(path, home))
  if (isWithin(absolute, cwd)) {
    return normalizeFilePath(relative(cwd, absolute) || '.')
  }
  if (isWithin(absolute, home)) {
    return `~/${normalizeFilePath(relative(home, absolute))}`
  }
  return normalizeFilePath(absolute)
}

/**
 * Checks one target against one policy.
 *
 * @param policy - A compiled policy.
 * @param target - A path as written, and whether it holds an expansion.
 * @param env - Working directory, home and existence probe.
 * @returns The match, or undefined if the policy does not block it.
 */
function checkPolicy (
  policy: CompiledPolicy,
  target: PolicyTarget,
  env: PolicyEnvironment
): PolicyMatch | undefined {
  if (policy.protection === 'none') {
    return undefined
  }
  const home = env.home ?? homedir()
  const exists = env.exists ?? existsSync
  const { forms, absolutes } = target.unresolved
    ? { forms: [normalizeFilePath(target.path)], absolutes: [] }
    : targetForms(target.path, env.cwd, home)
  // Anchored patterns (`~/...`, `/...`) are skipped only when every real
  // location of the file is inside the workspace.
  const insideCwd = !target.unresolved && absolutes.length > 0 &&
    absolutes.every((item) => isWithin(item, env.cwd))
  const patterns = policy.respectCwd && insideCwd
    ? policy.patterns.filter((pattern) => !isLocationAnchored(pattern))
    : policy.patterns
  const matches = (list: readonly CompiledPattern[]): boolean =>
    list.some((pattern) => forms.some((form) => pattern.test(form)))

  if (!matches(patterns) || matches(policy.allowedPatterns)) {
    return undefined
  }
  if (policy.onlyIfExists && !target.unresolved &&
    !absolutes.some((item) => exists(item))) {
    return undefined
  }
  const shown = target.unresolved
    ? target.path
    : displayTarget(target.path, env.cwd, home)
  return {
    ruleId: policy.id,
    protection: policy.protection,
    path: shown,
    reason: policy.blockMessage.replaceAll('{file}', shown)
  }
}

/**
 * Read-only protection for the files that control guardrails and Pi
 * itself, so the agent cannot switch its own checks off.
 *
 * @param agentDir - Pi's agent directory.
 * @returns A policy that is always applied, whatever the config says.
 */
function selfProtectionPolicy (agentDir: string): CompiledPolicy {
  const files = ['extensions/guardrails.json', 'settings.json', 'trust.json']
    .map((file) => ({
      pattern: exactRegex(normalizeFilePath(join(agentDir, file))),
      regex: true
    }))
  const project = [
    { pattern: '.pi/extensions/guardrails.json' },
    { pattern: '**/.pi/extensions/guardrails.json' },
    { pattern: '.pi/settings.json' },
    { pattern: '**/.pi/settings.json' }
  ]
  return {
    id: 'guardrails-self-protection',
    protection: 'readOnly',
    patterns: [...files, ...project].map(compileFilePattern),
    allowedPatterns: [],
    onlyIfExists: false,
    respectCwd: false,
    blockMessage: 'Changing {file} is not allowed: it controls Pi and ' +
      'guardrails. Ask the user to make this change.'
  }
}

export {
  BLOCKED_TOOLS,
  checkPolicy,
  compilePolicies,
  policiesForTool,
  selfProtectionPolicy,
  targetForms
}
export type { CompiledPolicy, PolicyMatch, PolicyTarget }
