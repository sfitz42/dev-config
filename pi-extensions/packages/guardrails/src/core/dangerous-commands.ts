import { commandName } from './shell-analysis.ts'

import type { Argument } from './shell-analysis.ts'

/** Returns a description when argv is dangerous. */
type Matcher = (name: string, args: readonly string[]) => string | undefined

/** Options before `--`; arguments after it are operands, never flags. */
function optionsOf (args: readonly string[]): string[] {
  const end = args.indexOf('--')
  return (end === -1 ? args : args.slice(0, end))
    .filter((arg) => arg.startsWith('-') && arg !== '-')
}

function hasShortFlag (options: readonly string[], flag: string): boolean {
  return options.some((option) =>
    !option.startsWith('--') && option.slice(1).includes(flag))
}

function hasLongOption (options: readonly string[], name: string): boolean {
  return options.some((option) =>
    option === `--${name}` || option.startsWith(`--${name}=`))
}

function isRecursive (options: readonly string[]): boolean {
  return hasShortFlag(options, 'R') || hasLongOption(options, 'recursive')
}

const removal: Matcher = (name, args) => {
  if (name !== 'rm') {
    return undefined
  }
  const options = optionsOf(args)
  const recursive = hasShortFlag(options, 'r') ||
    hasShortFlag(options, 'R') || hasLongOption(options, 'recursive') ||
    hasLongOption(options, 'dir')
  const force = hasShortFlag(options, 'f') || hasLongOption(options, 'force')
  return recursive && force ? 'recursive force delete' : undefined
}

const byName: Readonly<Record<string, string>> = {
  shred: 'secure file overwrite',
  sudo: 'superuser command',
  doas: 'privileged command execution',
  pkexec: 'privileged command execution',
  wipefs: 'filesystem signature wipe',
  blkdiscard: 'block device discard',
  fdisk: 'disk partitioning',
  sfdisk: 'disk partitioning',
  cfdisk: 'disk partitioning',
  parted: 'disk partitioning',
  sgdisk: 'disk partitioning'
}

const named: Matcher = (name) =>
  Object.hasOwn(byName, name) ? byName[name] : undefined

const diskWrite: Matcher = (name, args) =>
  name === 'dd' && args.some((arg) => arg.startsWith('of='))
    ? 'disk write operation'
    : undefined

const format: Matcher = (name) =>
  name === 'mkfs' || name.startsWith('mkfs.') ? 'filesystem format' : undefined

/** Octal modes granting write to others, or symbolic `o+w`/`a=rwx`. */
function isWorldWritable (mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) {
    const others = Number(mode.at(-1))
    return (others & 2) === 2
  }
  return mode.split(',').some((clause) => {
    const match = /^([ugoa]*)([+=])([rwxXst]*)$/.exec(clause)
    if (match === null) {
      return false
    }
    const who = match[1] ?? ''
    const perms = match[3] ?? ''
    // A bare `+w` is filtered by the umask, which normally keeps others out.
    return (who.includes('o') || who.includes('a')) && perms.includes('w')
  })
}

const permissions: Matcher = (name, args) => {
  if (name !== 'chmod') {
    return undefined
  }
  const options = optionsOf(args)
  const operands = args.filter((arg) => !arg.startsWith('-') || arg === '-')
  return isRecursive(options) && operands.some(isWorldWritable)
    ? 'insecure recursive permissions'
    : undefined
}

const ownership: Matcher = (name, args) =>
  name === 'chown' && isRecursive(optionsOf(args))
    ? 'recursive ownership change'
    : undefined

/** `--flag=value`, `--flag value`. */
function optionValues (args: readonly string[], flag: string): string[] {
  const values: string[] = []
  args.forEach((arg, i) => {
    if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1))
    } else if (arg === flag && args[i + 1] !== undefined) {
      values.push(args[i + 1] ?? '')
    }
  })
  return values
}

function mounts (args: readonly string[]): string[] {
  const values = [
    ...optionValues(args, '-v'),
    ...optionValues(args, '--volume'),
    ...optionValues(args, '--mount')
  ]
  for (const arg of args) {
    if (arg.startsWith('-v') && arg.length > 2 && arg[2] !== '=') {
      values.push(arg.slice(2))
    }
  }
  return values
}

const container: Matcher = (name, args) => {
  if (!['docker', 'podman', 'nerdctl'].includes(name)) {
    return undefined
  }
  const subcommand = args[0] === 'container' ? args[1] : args[0]
  if (subcommand !== 'run' && subcommand !== 'create') {
    return undefined
  }
  if (args.some((arg) => arg === '--privileged' ||
    arg.startsWith('--privileged='))) {
    return 'container with privileged mode'
  }
  const namespaces: [string, string][] = [
    ['--pid', 'container with host PID namespace'],
    ['--network', 'container with host network'],
    ['--net', 'container with host network'],
    ['--userns', 'container with host user namespace'],
    ['--uts', 'container with host UTS namespace'],
    ['--ipc', 'container with host IPC']
  ]
  for (const [flag, description] of namespaces) {
    if (optionValues(args, flag).includes('host')) {
      return description
    }
  }
  for (const mount of mounts(args)) {
    const source = mount.includes('source=') || mount.includes('src=')
      ? /(?:source|src)=([^,]*)/.exec(mount)?.[1] ?? ''
      : mount.split(':')[0] ?? ''
    if (source === '/' || source === '//') {
      return 'container with root filesystem mount'
    }
    if (/\/(?:var\/)?run\/(?:docker|podman)\.sock/.test(mount)) {
      return 'container with docker socket access'
    }
  }
  return undefined
}

const findDelete: Matcher = (name, args) =>
  name === 'find' && args.includes('-delete')
    ? 'recursive delete (find -delete)'
    : undefined

const SHELLS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'dash', 'zsh', 'ksh', 'mksh', 'ash', 'fish', 'busybox'
])

/**
 * A shell with no `-c` and no script file runs whatever arrives on stdin
 * (`curl … | sh`, `bash <<< "…"`, `sh < file`), which cannot be checked.
 * `bash -c '…'` is parsed and checked separately; `bash script.sh` is
 * treated like running the script directly.
 */
const shellFromStdin: Matcher = (name, args) => {
  if (!SHELLS.has(name) || (name === 'busybox' && args[0] !== 'sh')) {
    return undefined
  }
  const rest = name === 'busybox' ? args.slice(1) : args
  const options = optionsOf(rest)
  if (hasShortFlag(options, 'c')) {
    return undefined
  }
  const operands = rest.filter((arg) => !arg.startsWith('-') || arg === '-')
  return hasShortFlag(options, 's') || operands.length === 0 ||
    operands[0] === '-'
    ? 'shell runs commands from standard input'
    : undefined
}

/** Interpreter flags that take a program as their argument. */
const INLINE_CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  perl: ['-e', '-E'],
  ruby: ['-e'],
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  python: ['-c'],
  python3: ['-c'],
  php: ['-r'],
  lua: ['-e'],
  osascript: ['-e'],
  pwsh: ['-c', '-Command', '-EncodedCommand'],
  powershell: ['-c', '-Command', '-EncodedCommand']
}

const inlineScript: Matcher = (name, args) => {
  const base = /^python3\.\d+$/.test(name) ? 'python3' : name
  const flags = Object.hasOwn(INLINE_CODE_FLAGS, base)
    ? INLINE_CODE_FLAGS[base] ?? []
    : []
  const used = args.some((arg) => flags.some((flag) =>
    arg === flag || arg.startsWith(`${flag}=`) ||
    // Clustered short flags such as `perl -we '…'` or `python -Bc '…'`.
    (/^-[a-zA-Z]{2,}$/.test(arg) && flag.length === 2 &&
      arg.endsWith(flag.slice(1)))))
  return used ? 'runs an inline script the gate cannot inspect' : undefined
}

const MATCHERS: readonly Matcher[] = [
  removal, named, diskWrite, format, permissions, ownership, container,
  findDelete, shellFromStdin, inlineScript
]

/** Keywords the built-in matchers replace in the default pattern list. */
const BUILTIN_KEYWORD_PATTERNS: ReadonlySet<string> = new Set([
  'rm -rf', 'sudo', 'dd of=', 'mkfs.', 'chmod -R 777', 'chown -R', 'doas',
  'pkexec', 'shred', 'wipefs', 'blkdiscard', 'fdisk', 'parted',
  'docker run --privileged'
])

/**
 * Checks each wrapper layer of a command against the built-in matchers.
 *
 * @param layers - argv per wrapper layer, outermost first.
 * @returns The first danger found, or undefined.
 */
function matchDangerousLayers (
  layers: readonly (readonly Argument[])[]
): string | undefined {
  for (const layer of layers) {
    const [first, ...rest] = layer
    if (first === undefined) {
      continue
    }
    if (first.unresolvedPrefix) {
      return 'command name is only known at runtime'
    }
    const name = commandName(first.text)
    const args = rest.map((arg) => arg.text)
    for (const matcher of MATCHERS) {
      const description = matcher(name, args)
      if (description !== undefined) {
        return description
      }
    }
  }
  return undefined
}

export { BUILTIN_KEYWORD_PATTERNS, isWorldWritable, matchDangerousLayers }
