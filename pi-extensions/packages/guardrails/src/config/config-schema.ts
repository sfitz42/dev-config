import { Type } from 'typebox'

import type { Static } from 'typebox'

const pattern = Type.Object({
  pattern: Type.String({ description: 'Glob or substring; regex when regex is true.' }),
  description: Type.Optional(Type.String({
    description: 'Shown to the agent when the pattern triggers.'
  })),
  regex: Type.Optional(Type.Boolean({ description: 'Match as a regular expression.' }))
})

const dangerousPattern = Type.Object({
  pattern: Type.String(),
  description: Type.String({ description: 'Shown in the confirmation prompt.' }),
  regex: Type.Optional(Type.Boolean())
})

const protection = Type.Union([
  Type.Literal('none'),
  Type.Literal('readOnly'),
  Type.Literal('noAccess')
], { description: 'noAccess blocks reads and writes; readOnly blocks writes.' })

const policyRule = Type.Object({
  id: Type.String({ description: 'Stable id; a rule with the same id in a later scope replaces this one.' }),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  patterns: Type.Array(pattern, { description: 'Files the rule protects.' }),
  allowedPatterns: Type.Optional(Type.Array(pattern, { description: 'Exceptions.' })),
  protection,
  onlyIfExists: Type.Optional(Type.Boolean({
    description: 'Only block files that exist. Default true.'
  })),
  respectCwd: Type.Optional(Type.Boolean({
    description: 'Ignore ~- and /-anchored patterns for files inside the working directory. Default true.'
  })),
  blockMessage: Type.Optional(Type.String({ description: 'Supports {file}.' })),
  enabled: Type.Optional(Type.Boolean({ description: 'Default true.' }))
})

const allowedPath = Type.Object({
  kind: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
  path: Type.String({ description: 'Absolute or ~/ path.' })
})

const featureFlags = Type.Object({
  policies: Type.Optional(Type.Boolean()),
  permissionGate: Type.Optional(Type.Boolean()),
  pathAccess: Type.Optional(Type.Boolean()),
  protectEnvFiles: Type.Optional(Type.Boolean({ description: 'Deprecated; migrated to policies.' }))
})

/** The settings file format; every field is optional. */
const guardrailsConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  version: Type.Optional(Type.String({ description: 'Config format marker, managed by guardrails.' })),
  enabled: Type.Optional(Type.Boolean({ description: 'Turn all checks on or off.' })),
  applyBuiltinDefaults: Type.Optional(Type.Boolean({
    description: 'Include the built-in policy rules before user rules.'
  })),
  onboarding: Type.Optional(Type.Object({
    completed: Type.Optional(Type.Boolean()),
    completedAt: Type.Optional(Type.String()),
    version: Type.Optional(Type.String())
  })),
  features: Type.Optional(featureFlags),
  policies: Type.Optional(Type.Object({
    rules: Type.Optional(Type.Array(policyRule))
  })),
  pathAccess: Type.Optional(Type.Object({
    mode: Type.Optional(Type.Union([
      Type.Literal('allow'), Type.Literal('ask'), Type.Literal('block')
    ])),
    applyTo: Type.Optional(Type.Union([
      Type.Literal('all'), Type.Literal('write')
    ], { description: 'write: only gate writes; reads by read/grep/find/ls pass.' })),
    allowedPaths: Type.Optional(Type.Array(allowedPath)),
    alwaysScope: Type.Optional(Type.Union([
      Type.Literal('local'), Type.Literal('global')
    ], { description: 'Where "always" grants are saved.' }))
  })),
  permissionGate: Type.Optional(Type.Object({
    patterns: Type.Optional(Type.Array(dangerousPattern, {
      description: 'Added to the default dangerous patterns.'
    })),
    customPatterns: Type.Optional(Type.Array(dangerousPattern, {
      description: 'Replaces the default patterns and built-in matchers.'
    })),
    requireConfirmation: Type.Optional(Type.Boolean({
      description: 'Prompt for dangerous commands; when false, only warn.'
    })),
    allowedPatterns: Type.Optional(Type.Array(pattern, {
      description: 'Commands that skip the prompt. Matched per simple command.'
    })),
    autoDenyPatterns: Type.Optional(Type.Array(pattern, {
      description: 'Commands blocked without a prompt.'
    }))
  })),
  envFiles: Type.Optional(Type.Object({}, {
    description: 'Deprecated; migrated to policies.',
    additionalProperties: true
  }))
}, { additionalProperties: true })

type GuardrailsConfig = Static<typeof guardrailsConfigSchema>
type PolicyRule = Static<typeof policyRule>
type DangerousPattern = Static<typeof dangerousPattern>
type Protection = Static<typeof protection>
type FeatureId = 'policies' | 'permissionGate' | 'pathAccess'
type PathAccessMode = 'allow' | 'ask' | 'block'
type ConfigScope = 'global' | 'local' | 'memory'

export { guardrailsConfigSchema }
export type {
  ConfigScope,
  DangerousPattern,
  FeatureId,
  GuardrailsConfig,
  PathAccessMode,
  PolicyRule,
  Protection
}
