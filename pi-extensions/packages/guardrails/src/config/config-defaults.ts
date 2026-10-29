import type { AllowedPath } from '../core/paths.ts'
import type { PatternConfig } from '../core/patterns.ts'
import type {
  DangerousPattern,
  FeatureId,
  PathAccessMode,
  PolicyRule
} from './config-schema.ts'

/** Format marker written to config files; the upstream format it mirrors. */
const CONFIG_VERSION = '0.19.0'

/** Config with every default applied and every scope merged. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly applyBuiltinDefaults: boolean
  readonly features: Readonly<Record<FeatureId, boolean>>
  readonly policies: { readonly rules: readonly PolicyRule[] }
  readonly pathAccess: {
    readonly mode: PathAccessMode
    readonly applyTo: 'all' | 'write'
    readonly allowedPaths: readonly AllowedPath[]
    readonly alwaysScope: 'local' | 'global'
  }
  readonly permissionGate: {
    readonly patterns: readonly DangerousPattern[]
    /** False when customPatterns replaced the defaults. */
    readonly useBuiltinMatchers: boolean
    readonly requireConfirmation: boolean
    readonly allowedPatterns: readonly PatternConfig[]
    readonly autoDenyPatterns: readonly PatternConfig[]
  }
}

const SECRET_FILES: PolicyRule = {
  id: 'secret-files',
  description: 'Files containing secrets',
  patterns: [
    { pattern: '.env' },
    { pattern: '.env.local' },
    { pattern: '.env.production' },
    { pattern: '.env.prod' },
    { pattern: '.dev.vars' }
  ],
  allowedPatterns: [
    { pattern: '*.example.env' },
    { pattern: '*.sample.env' },
    { pattern: '*.test.env' },
    { pattern: '.env.example' },
    { pattern: '.env.sample' },
    { pattern: '.env.test' }
  ],
  protection: 'noAccess',
  onlyIfExists: true,
  blockMessage: 'Accessing {file} is not allowed. This file contains secrets. ' +
    'Explain to the user why you want to access it, and if changes are needed ask the user to make them.'
}

const BUILTIN_RULES: readonly PolicyRule[] = [
  SECRET_FILES,
  {
    id: 'home-ssh',
    description: 'SSH directory and keys',
    enabled: false,
    patterns: [
      { pattern: '~/.ssh/**' },
      { pattern: '~/.ssh/*_rsa' },
      { pattern: '~/.ssh/*_ed25519' },
      { pattern: '~/.ssh/*.pem' }
    ],
    allowedPatterns: [{ pattern: '~/.ssh/*.pub' }],
    protection: 'noAccess',
    onlyIfExists: true,
    blockMessage: 'Accessing {file} is not allowed. It is part of your SSH configuration and may contain private keys or host details.'
  },
  {
    id: 'home-config',
    description: 'Sensitive user configuration directories',
    enabled: false,
    patterns: [
      { pattern: '~/.config/gh/**' },
      { pattern: '~/.config/gcloud/**' },
      { pattern: '~/.config/op/**' },
      { pattern: '~/.config/sops/**' }
    ],
    protection: 'noAccess',
    onlyIfExists: true,
    blockMessage: 'Accessing {file} is not allowed. It is in a sensitive configuration directory and may contain credentials or tokens.'
  },
  {
    id: 'home-gpg',
    description: 'GPG keys and configuration',
    enabled: false,
    patterns: [
      { pattern: '~/.gnupg/**' },
      { pattern: '~/*.gpg' },
      { pattern: '~/.gpg-agent.conf' }
    ],
    protection: 'noAccess',
    onlyIfExists: true,
    blockMessage: 'Accessing {file} is not allowed. It is part of your GPG configuration and may contain private keys or trust settings.'
  }
]

const DEFAULT_DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  { pattern: 'rm -rf', description: 'recursive force delete' },
  { pattern: 'sudo', description: 'superuser command' },
  { pattern: 'dd of=', description: 'disk write operation' },
  { pattern: 'mkfs.', description: 'filesystem format' },
  { pattern: 'chmod -R 777', description: 'insecure recursive permissions' },
  { pattern: 'chown -R', description: 'recursive ownership change' },
  { pattern: 'doas', description: 'privileged command execution' },
  { pattern: 'pkexec', description: 'privileged command execution' },
  { pattern: 'shred', description: 'secure file overwrite' },
  { pattern: 'wipefs', description: 'filesystem signature wipe' },
  { pattern: 'blkdiscard', description: 'block device discard' },
  { pattern: 'fdisk', description: 'disk partitioning' },
  { pattern: 'parted', description: 'disk partitioning' },
  {
    pattern: 'docker run --privileged',
    description: 'container with privileged mode'
  }
]

const DEFAULT_CONFIG: ResolvedConfig = {
  enabled: true,
  applyBuiltinDefaults: true,
  features: { policies: true, permissionGate: true, pathAccess: false },
  policies: { rules: BUILTIN_RULES },
  pathAccess: {
    mode: 'ask',
    applyTo: 'all',
    allowedPaths: [{ kind: 'file', path: '/dev/null' }],
    alwaysScope: 'local'
  },
  permissionGate: {
    patterns: DEFAULT_DANGEROUS_PATTERNS,
    useBuiltinMatchers: true,
    requireConfirmation: true,
    allowedPatterns: [],
    autoDenyPatterns: []
  }
}

export { BUILTIN_RULES, CONFIG_VERSION, DEFAULT_CONFIG, SECRET_FILES }
export type { ResolvedConfig }
