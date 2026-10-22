import {
  BUILTIN_KEYWORD_PATTERNS,
  matchDangerousLayers
} from '../core/dangerous-commands.ts'
import { compileCommandPattern, exactRegex } from '../core/patterns.ts'
import { analyseShell } from '../core/shell-analysis.ts'

import type { PatternConfig } from '../core/patterns.ts'
import type { AnalyseOptions } from '../core/shell-analysis.ts'
import type { DangerousPattern } from '../config/config-schema.ts'

interface GateSettings {
  readonly patterns: readonly DangerousPattern[]
  readonly useBuiltinMatchers: boolean
  readonly allowedPatterns: readonly PatternConfig[]
  readonly autoDenyPatterns: readonly PatternConfig[]
}

interface GateFinding {
  /** Why the command is dangerous. */
  readonly description: string
  /** The pattern that matched, or `(structural)` for built-ins. */
  readonly pattern: string
  /** The part of the command it was found in. */
  readonly segment: string
}

type GateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny', readonly pattern: PatternConfig }
  | { readonly kind: 'dangerous', readonly finding: GateFinding }

/** Marks allowed patterns created by "Allow for session". */
const SESSION_GRANT = 'Allowed for this session'

/** An allowed pattern matching exactly this command, for the session. */
function sessionGrant (command: string): PatternConfig {
  return {
    pattern: exactRegex(command), regex: true, description: SESSION_GRANT
  }
}

/**
 * Decides what the permission gate does with a bash command.
 *
 * Auto-deny patterns win over everything. Built-in matchers run on every
 * command the line may execute (nested shells, wrappers, substitutions).
 * Each finding is waived only if an allowed pattern matches the command
 * it was found in, so `npm test` being allowed does not allow
 * `npm test; rm -rf ~`. Text that cannot be parsed is itself a finding.
 *
 * @param command - The bash command.
 * @param settings - Gate configuration.
 * @param options - Working directory, home and environment for analysis.
 * @returns allow, deny (auto-deny pattern), or dangerous with a reason.
 */
function assessCommand (
  command: string,
  settings: GateSettings,
  options: AnalyseOptions
): GateDecision {
  const analysis = analyseShell(command, options)
  const segments = [
    command,
    ...analysis.commands.map((item) => item.source).filter((s) => s !== '')
  ]

  const autoDeny = settings.autoDenyPatterns.find((config) => {
    const compiled = compileCommandPattern(config)
    return segments.some((segment) => compiled.test(segment))
  })
  if (autoDeny !== undefined) {
    return { kind: 'deny', pattern: autoDeny }
  }

  const findings: GateFinding[] = []
  if (settings.useBuiltinMatchers) {
    for (const failure of analysis.failures) {
      findings.push({
        description: failure.source === command
          ? 'command could not be parsed'
          : 'nested command could not be parsed',
        pattern: '(parse)',
        segment: failure.source === command ? command : failure.source
      })
    }
    for (const instance of analysis.commands) {
      const description = matchDangerousLayers(instance.layers)
      if (description !== undefined) {
        findings.push({
          description, pattern: '(structural)', segment: instance.source
        })
      }
    }
  }
  const parsed = analysis.failures.length === 0
  for (const config of settings.patterns) {
    if (settings.useBuiltinMatchers && parsed && config.regex !== true &&
      BUILTIN_KEYWORD_PATTERNS.has(config.pattern)) {
      continue
    }
    if (compileCommandPattern(config).test(command)) {
      findings.push({
        description: config.description,
        pattern: config.pattern,
        segment: command
      })
    }
  }

  const allowed = settings.allowedPatterns.map(compileCommandPattern)
  const sessionAllowed = allowed.some((compiled) =>
    compiled.source.description === SESSION_GRANT && compiled.test(command))
  const remaining = findings.filter((finding) => !sessionAllowed &&
    !allowed.some((compiled) => compiled.source.description !== SESSION_GRANT &&
      compiled.test(finding.segment)))
  const [first] = remaining
  return first === undefined
    ? { kind: 'allow' }
    : { kind: 'dangerous', finding: first }
}

function autoDenyReason (pattern: PatternConfig): string {
  const description = pattern.description?.trim() ?? ''
  return description === ''
    ? 'Command matched an auto-deny pattern and was blocked automatically.'
    : `Command auto-denied: ${description}`
}

export { assessCommand, autoDenyReason, SESSION_GRANT, sessionGrant }
export type { GateDecision, GateFinding, GateSettings }
