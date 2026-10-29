import { homedir } from 'node:os'

import {
  bashPathTargets,
  tokensFromCode
} from '../core/path-candidates.ts'
import {
  displayPath,
  isWithin,
  maybePathLike,
  pathForms,
  resolveFromCwd
} from '../core/paths.ts'

import type { CandidateOptions, PathTarget } from '../core/path-candidates.ts'
import type { AllowedPath } from '../core/paths.ts'
import type { PathAccessMode } from '../config/config-schema.ts'

interface PathAccessState {
  readonly cwd: string
  readonly mode: PathAccessMode
  /** Absolute grants. */
  readonly allowedPaths: readonly AllowedPath[]
  readonly hasUI: boolean
}

type PathDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny', readonly reason: string }
  | {
    readonly kind: 'ask'
    /** Undefined when the location is only known at runtime. */
    readonly absolutePath: string | undefined
    readonly displayPath: string
  }

/** Tools that only read. Bash never counts: a command can write. */
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])

function isReadOnlyTool (toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName)
}

function isPathAllowed (
  absolutePath: string,
  allowedPaths: readonly AllowedPath[]
): boolean {
  return allowedPaths.some((entry) => entry.kind === 'directory'
    ? isWithin(absolutePath, entry.path)
    : absolutePath === entry.path)
}

function resolveAllowedPaths (
  allowedPaths: readonly AllowedPath[],
  cwd: string,
  home = homedir()
): AllowedPath[] {
  return allowedPaths.map((entry) => ({
    kind: entry.kind,
    path: resolveFromCwd(entry.path, cwd, home)
  }))
}

/**
 * Paths a tool call may touch. File tools give their `path` (and its
 * symlink target); bash commands are analysed.
 *
 * @param toolName - The tool being called.
 * @param input - Its arguments.
 * @param options - Working directory, home and environment.
 * @returns Targets to check.
 */
function targetsForTool (
  toolName: string,
  input: Record<string, unknown>,
  options: CandidateOptions
): PathTarget[] {
  if (FILE_TOOLS.has(toolName)) {
    const raw = typeof input.path === 'string'
      ? input.path
      : typeof input.file_path === 'string' ? input.file_path : ''
    if (raw.trim() === '') {
      return []
    }
    return pathForms(resolveFromCwd(raw.trim(), options.cwd, options.home))
      .map((absolutePath) => ({ kind: 'path', absolutePath }))
  }
  const command = typeof input.command === 'string' ? input.command : ''
  if (toolName === 'bash') {
    return bashPathTargets(command, options)
  }
  if (toolName === 'powershell') {
    return tokensFromCode(command)
      .filter((token) => maybePathLike(token.text))
      .flatMap((token) => pathForms(
        resolveFromCwd(token.text, options.cwd, options.home)))
      .map((absolutePath) => ({ kind: 'path', absolutePath }))
  }
  return []
}

/**
 * Decides whether a target outside the workspace may be accessed.
 *
 * @param target - A path, or a location only known at runtime.
 * @param state - Mode, grants, cwd and whether a prompt can be shown.
 * @param home - Home directory, for display.
 * @returns allow, deny with a reason, or ask.
 */
function decidePathAccess (
  target: PathTarget,
  state: PathAccessState,
  home = homedir()
): PathDecision {
  if (state.mode === 'allow') {
    return { kind: 'allow' }
  }
  let absolutePath: string | undefined
  let shown: string
  if (target.kind === 'path') {
    if (isWithin(target.absolutePath, state.cwd) ||
      isPathAllowed(target.absolutePath, state.allowedPaths)) {
      return { kind: 'allow' }
    }
    absolutePath = target.absolutePath
    shown = displayPath(target.absolutePath, state.cwd, home)
  } else {
    shown = target.text
  }
  const where = target.kind === 'path'
    ? 'outside working directory'
    : 'location only known at runtime'
  if (state.mode === 'block') {
    return { kind: 'deny', reason: `Access to ${shown} is blocked (${where}).` }
  }
  if (!state.hasUI) {
    return {
      kind: 'deny',
      reason: `Access to ${shown} is blocked (${where}, no UI to confirm).`
    }
  }
  return { kind: 'ask', absolutePath, displayPath: shown }
}

export {
  decidePathAccess,
  isPathAllowed,
  isReadOnlyTool,
  resolveAllowedPaths,
  targetsForTool
}
export type { PathAccessState, PathDecision }
