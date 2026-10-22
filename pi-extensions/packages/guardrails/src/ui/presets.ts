import type {
  DangerousPattern,
  GuardrailsConfig,
  PolicyRule
} from '../config/config-schema.ts'

interface PolicyPreset {
  readonly label: string
  readonly description: string
  readonly rule: PolicyRule
}

interface CommandPreset {
  readonly label: string
  readonly description: string
  readonly pattern: DangerousPattern
}

function noAccess (
  id: string,
  name: string,
  patterns: string[],
  allowed: string[] = []
): PolicyRule {
  return {
    id,
    name,
    patterns: patterns.map((pattern) => ({ pattern })),
    ...(allowed.length > 0
      ? { allowedPatterns: allowed.map((pattern) => ({ pattern })) }
      : {}),
    protection: 'noAccess',
    onlyIfExists: true,
    enabled: true
  }
}

function readOnly (id: string, name: string, patterns: string[]): PolicyRule {
  return {
    id,
    name,
    patterns: patterns.map((pattern) => ({ pattern })),
    protection: 'readOnly',
    onlyIfExists: true,
    enabled: true
  }
}

const POLICY_PRESETS: readonly PolicyPreset[] = [
  {
    label: 'Secrets (.env)',
    description: 'Blocks dotenv files, which usually hold secrets; example and sample files stay readable.',
    rule: noAccess('example-secret-env-files', 'Secret env files',
      ['.env', '.env.*'], ['.env.example', '*.sample.env'])
  },
  {
    label: 'Logs (*.log)',
    description: 'Lets the agent read log and output files but not rewrite them.',
    rule: readOnly('example-log-files', 'Log files', ['*.log', '*.out'])
  },
  {
    label: 'Regex env',
    description: 'The env-file rule written as regexes, with .env.example excepted.',
    rule: {
      id: 'example-regex-env',
      name: 'Regex env files',
      patterns: [{ pattern: '^\\.env(\\..+)?$', regex: true }],
      allowedPatterns: [{ pattern: '^\\.env\\.example$', regex: true }],
      protection: 'noAccess',
      onlyIfExists: true,
      enabled: true
    }
  },
  {
    label: 'SSH keys',
    description: 'Blocks private key files; .pub files stay readable.',
    rule: noAccess('example-ssh-keys', 'SSH keys',
      ['*.pem', '*_rsa', '*_ed25519'], ['*.pub'])
  },
  {
    label: 'AWS credentials',
    description: 'Blocks the AWS CLI credentials and config files.',
    rule: noAccess('example-aws-credentials', 'AWS credentials',
      ['.aws/credentials', '.aws/config'])
  },
  {
    label: 'Database files',
    description: 'Keeps SQLite and other database files read-only.',
    rule: readOnly('example-database-files', 'Database files',
      ['*.db', '*.sqlite', '*.sqlite3'])
  },
  {
    label: 'Kubernetes secrets',
    description: 'Blocks kubeconfig files, which carry cluster credentials.',
    rule: noAccess('example-k8s-secrets', 'Kubernetes secrets',
      ['.kube/config', '*kubeconfig*'])
  },
  {
    label: 'Certificates',
    description: 'Blocks certificates and private keys; signing requests stay readable.',
    rule: noAccess('example-certificates', 'Certificates',
      ['*.crt', '*.key', '*.p12'], ['*.csr'])
  }
]

function command (
  label: string,
  pattern: string,
  description: string,
  regex = false
): CommandPreset {
  return {
    label,
    description: `Asks before ${description.toLowerCase()}.`,
    pattern: { pattern, description, ...(regex ? { regex: true } : {}) }
  }
}

const COMMAND_PRESETS: readonly CommandPreset[] = [
  command('Homebrew', 'brew', 'Homebrew package manager'),
  command('Docker inspect', 'docker inspect', 'Docker inspect (may show env vars)'),
  command('Terraform apply', 'terraform apply', 'Terraform infrastructure changes'),
  command('Terraform destroy', 'terraform destroy', 'Terraform infrastructure destruction'),
  command('Terraform import', 'terraform import', 'Terraform resource import'),
  command('kubectl delete', 'kubectl delete', 'Kubernetes resource deletion'),
  command('kubectl apply', 'kubectl apply', 'Kubernetes resource changes'),
  command('kubectl scale', 'kubectl scale', 'Kubernetes scaling'),
  command('docker system prune', 'docker system prune', 'Docker system cleanup'),
  command('docker rm', 'docker rm', 'Docker container removal'),
  command('docker rmi', 'docker rmi', 'Docker image removal'),
  command('docker compose down', 'docker compose down', 'Docker Compose teardown'),
  command('git push --force',
    'git push .*(-f\\b|--force(?!-with-lease)|--force-with-lease)',
    'Git force push', true),
  command('npm publish', 'npm publish', 'npm package publishing'),
  command('yarn publish', 'yarn publish', 'Yarn package publishing'),
  command('pnpm publish', 'pnpm publish', 'pnpm package publishing'),
  command('DROP DATABASE', 'DROP DATABASE', 'SQL database drop'),
  command('DROP TABLE', 'DROP TABLE', 'SQL table drop'),
  command('dbt run', 'dbt run', 'dbt model runs'),
  command('dbt seed', 'dbt seed', 'dbt seed loading'),
  command('aws s3 rm', 'aws s3 rm', 'S3 object deletion'),
  command('aws iam', 'aws iam', 'AWS IAM changes'),
  command('aws ec2 terminate', 'aws ec2 terminate-instances', 'EC2 instance termination'),
  command('gcloud compute delete', 'gcloud compute instances delete', 'GCP instance deletion'),
  command('gcloud iam', 'gcloud iam', 'GCP IAM changes'),
  command('gcloud sql delete', 'gcloud sql instances delete', 'Cloud SQL instance deletion')
]

/** Lowercase, words joined by hyphens. */
function toKebabCase (input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** An id not already used by a rule in `config`. */
function uniqueRuleId (config: GuardrailsConfig, base: string): string {
  const used = new Set((config.policies?.rules ?? []).map((rule) => rule.id))
  const root = toKebabCase(base) || 'policy'
  let id = root
  for (let n = 2; used.has(id); n++) {
    id = `${root}-${n}`
  }
  return id
}

function addPolicyRule (
  config: GuardrailsConfig,
  rule: PolicyRule
): GuardrailsConfig {
  const next = structuredClone(config)
  const rules = next.policies?.rules ?? []
  next.policies = {
    ...next.policies,
    rules: [
      ...rules,
      { ...structuredClone(rule), id: uniqueRuleId(next, rule.id) }
    ]
  }
  return next
}

function addDangerousPattern (
  config: GuardrailsConfig,
  pattern: DangerousPattern
): GuardrailsConfig {
  const next = structuredClone(config)
  const patterns = next.permissionGate?.patterns ?? []
  if (patterns.some((item) => item.pattern === pattern.pattern)) {
    return next
  }
  next.permissionGate = {
    ...next.permissionGate,
    patterns: [...patterns, { ...pattern }]
  }
  return next
}

export {
  addDangerousPattern,
  addPolicyRule,
  COMMAND_PRESETS,
  POLICY_PRESETS,
  toKebabCase,
  uniqueRuleId
}
export type { CommandPreset, PolicyPreset }
