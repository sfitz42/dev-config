import { basename } from 'node:path'

import { parseShell, ShellParseError } from '../shell/shell-parser.ts'
import { collectAssignments, walkCommands } from '../shell/shell-walk.ts'
import { evaluateWord, expandBraces, staticText } from '../shell/shell-words.ts'

import type {
  Redirect,
  RedirectOperator,
  Script,
  Word
} from '../shell/shell-ast.ts'
import type { EvaluateOptions, WordValue } from '../shell/shell-words.ts'

/** One evaluated argument. */
interface Argument extends WordValue {}

interface RedirectTarget {
  readonly operator: RedirectOperator
  readonly fd: number | undefined
  readonly target: Argument
}

/** A command bash may run, with wrappers peeled off into layers. */
interface CommandInstance {
  /** argv at each wrapper layer; `[0]` is the full argv as written. */
  readonly layers: readonly (readonly Argument[])[]
  readonly redirects: readonly RedirectTarget[]
  /** Source text of the command, for display and pattern matching. */
  readonly source: string
  /** True when the command's output feeds a word (`$(...)`). */
  readonly inSubstitution: boolean
  /** True when the command runs on another machine (`ssh host cmd`). */
  readonly remote: boolean
}

interface ParseFailure {
  readonly source: string
  readonly reason: string
}

interface ShellAnalysis {
  readonly commands: readonly CommandInstance[]
  /** Text that could not be parsed: the whole command or a nested one. */
  readonly failures: readonly ParseFailure[]
  /** Directories the script changes into, as evaluated arguments. */
  readonly directories: readonly Argument[]
}

interface AnalyseOptions {
  readonly cwd: string
  readonly home: string
  /** Environment values worth resolving (`HOME`, `TMPDIR`, ...). */
  readonly environment?: Readonly<Record<string, string | undefined>>
}

const MAX_NESTING = 4
const MAX_ARGV_VARIANTS = 8
const SHELLS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox-sh'
])
const KNOWN_ENVIRONMENT = ['HOME', 'TMPDIR', 'USER', 'PWD', 'OLDPWD']

/**
 * Wrappers that run another command: options that take a value, and
 * options that mean nothing is run (`command -v`).
 */
interface WrapperSpec {
  readonly valueOptions: ReadonlySet<string>
  readonly noRunOptions?: ReadonlySet<string>
  /** Positional arguments before the wrapped command (`timeout 5 cmd`). */
  readonly positionals?: number
  /** Skips `NAME=value` arguments (`env A=1 cmd`). */
  readonly assignments?: boolean
}

const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  sudo: {
    valueOptions: new Set([
      '-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '-R',
      '--user', '--group', '--host', '--prompt', '--chdir', '--role',
      '--type', '--other-user', '--close-from', '--chroot', '--command-timeout'
    ]),
    noRunOptions: new Set(['-l', '-v', '-k', '-K', '-V', '--list'])
  },
  doas: { valueOptions: new Set(['-u', '-C']) },
  pkexec: { valueOptions: new Set(['--user']) },
  env: {
    valueOptions: new Set(['-u', '-C', '--unset', '--chdir']),
    assignments: true
  },
  command: {
    valueOptions: new Set(),
    noRunOptions: new Set(['-v', '-V'])
  },
  builtin: { valueOptions: new Set() },
  exec: { valueOptions: new Set(['-a']) },
  nohup: { valueOptions: new Set() },
  time: { valueOptions: new Set(['-f', '-o', '--format', '--output']) },
  nice: { valueOptions: new Set(['-n', '--adjustment']) },
  ionice: {
    valueOptions: new Set(['-c', '-n', '--class', '--classdata']),
    noRunOptions: new Set(['-p', '-P', '-u', '--pid', '--pgid', '--uid'])
  },
  chrt: {
    valueOptions: new Set(['-T', '-P', '-D']),
    noRunOptions: new Set(['-p', '--pid', '-m', '--max']),
    positionals: 1
  },
  taskset: {
    valueOptions: new Set(),
    noRunOptions: new Set(['-p', '--pid']),
    positionals: 1
  },
  stdbuf: {
    valueOptions: new Set(['-i', '-o', '-e', '--input', '--output', '--error'])
  },
  timeout: {
    valueOptions: new Set(['-s', '-k', '--signal', '--kill-after']),
    positionals: 1
  },
  setsid: { valueOptions: new Set() },
  unbuffer: { valueOptions: new Set() },
  xargs: {
    valueOptions: new Set([
      '-I', '-J', '-L', '-n', '-P', '-s', '-S', '-E', '-d', '-a',
      '--max-args', '--max-procs', '--delimiter', '--arg-file',
      '--max-lines', '--max-chars', '--replace', '--eof'
    ])
  },
  busybox: { valueOptions: new Set() },
  flock: {
    valueOptions: new Set(['-w', '-E', '--timeout', '--conflict-exit-code']),
    positionals: 1
  }
}

const SSH_VALUE_OPTIONS = new Set([
  '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
  '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B'
])

function commandName (text: string): string {
  return basename(text).toLowerCase()
}

function isOption (text: string): boolean {
  return text.startsWith('-') && text !== '-'
}

/**
 * The argv of the command a wrapper runs, or undefined when `argv` is not
 * a wrapper or runs nothing.
 */
function unwrapOnce (argv: readonly Argument[]): Argument[] | undefined {
  const [first, ...rest] = argv
  if (first === undefined || first.unresolvedPrefix) {
    return undefined
  }
  const spec = WRAPPERS[commandName(first.text)]
  if (spec === undefined) {
    return undefined
  }
  let positionals = spec.positionals ?? 0
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === undefined) {
      break
    }
    const text = arg.text
    if (text === '--') {
      return rest.slice(i + 1 + positionals)
    }
    if (spec.noRunOptions?.has(text) === true) {
      return undefined
    }
    if (isOption(text)) {
      const name = text.includes('=') ? text.slice(0, text.indexOf('=')) : text
      if (spec.valueOptions.has(name) && !text.includes('=')) {
        i += 1
      }
      continue
    }
    if (spec.assignments === true && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
      continue
    }
    if (positionals > 0) {
      positionals -= 1
      continue
    }
    return rest.slice(i)
  }
  return undefined
}

function unwrapLayers (argv: readonly Argument[]): Argument[][] {
  const layers: Argument[][] = [[...argv]]
  let current: readonly Argument[] = argv
  for (let hops = 0; hops < 8; hops++) {
    const inner = unwrapOnce(current)
    if (inner === undefined || inner.length === 0) {
      break
    }
    layers.push(inner)
    current = inner
  }
  return layers
}

/** Text of a nested shell program carried by a command, if any. */
function nestedPrograms (argv: readonly Argument[]): string[] {
  const [first, ...rest] = argv
  if (first === undefined) {
    return []
  }
  const name = commandName(first.text)
  const texts = rest.map((arg) => arg.text)

  if (SHELLS.has(name) || (name === 'busybox' && texts[0] === 'sh')) {
    const args = name === 'busybox' ? texts.slice(1) : texts
    const flagIndex = args.findIndex((text) =>
      /^-[A-Za-z]*c[A-Za-z]*$/.test(text) && !text.startsWith('--'))
    if (flagIndex === -1) {
      return []
    }
    const program = args.slice(flagIndex + 1).find((text) => !isOption(text))
    return program === undefined ? [] : [program]
  }
  switch (name) {
    case 'eval':
      return texts.length > 0 ? [texts.join(' ')] : []
    case 'watch': {
      const valueOptions = new Set(['-n', '--interval', '-d', '--differences'])
      const start = texts.findIndex((text, i) =>
        !isOption(text) && !valueOptions.has(texts[i - 1] ?? ''))
      return start === -1 ? [] : [texts.slice(start).join(' ')]
    }
    case 'su':
    case 'runuser':
    case 'script': {
      const index = texts.findIndex((text) =>
        text === '-c' || text === '--command')
      const program = index === -1 ? undefined : texts[index + 1]
      return program === undefined ? [] : [program]
    }
    case 'env': {
      const index = texts.findIndex((text) =>
        text === '-S' || text === '--split-string')
      const program = index === -1 ? undefined : texts[index + 1]
      return program === undefined ? [] : [program]
    }
    default:
      return []
  }
}

/** `find ... -exec cmd {} ;` runs `cmd`; returns each such argv. */
function findExecCommands (argv: readonly Argument[]): Argument[][] {
  const [first, ...rest] = argv
  if (first === undefined || !['find', 'gfind'].includes(commandName(first.text))) {
    return []
  }
  const result: Argument[][] = []
  for (let i = 0; i < rest.length; i++) {
    const text = rest[i]?.text
    if (text !== '-exec' && text !== '-execdir' && text !== '-ok' &&
      text !== '-okdir') {
      continue
    }
    const end = rest.findIndex((arg, j) =>
      j > i && (arg.text === ';' || arg.text === '+'))
    const stop = end === -1 ? rest.length : end
    result.push(rest.slice(i + 1, stop))
    i = stop
  }
  return result
}

/** The command `ssh host cmd...` runs remotely, as shell text. */
function sshRemoteProgram (argv: readonly Argument[]): string | undefined {
  const [first, ...rest] = argv
  if (first === undefined || commandName(first.text) !== 'ssh') {
    return undefined
  }
  for (let i = 0; i < rest.length; i++) {
    const text = rest[i]?.text ?? ''
    if (isOption(text)) {
      if (SSH_VALUE_OPTIONS.has(text)) {
        i += 1
      }
      continue
    }
    const remote = rest.slice(i + 1).map((arg) => arg.text)
    return remote.length > 0 ? remote.join(' ') : undefined
  }
  return undefined
}

function argvVariants (
  words: readonly Word[],
  options: EvaluateOptions
): Argument[][] {
  let variants: Argument[][] = [[]]
  for (const word of words) {
    // A variable with several known values gives alternative argvs. Brace
    // expansion gives extra arguments within one argv; bash runs the
    // expansions, so they come first and the unexpanded text is kept last
    // (it costs nothing and covers text the expander misreads).
    const alternatives = evaluateWord(word, options).map((value) => {
      const [original, ...expanded] = expandBraces(value.text)
      return [...expanded, original ?? value.text]
        .map((text) => ({ ...value, text }))
    })
    if (alternatives.length === 0) {
      continue
    }
    variants = variants
      .flatMap((argv) => alternatives.map((args) => [...argv, ...args]))
      .slice(0, MAX_ARGV_VARIANTS)
  }
  return variants
}

function redirectTargets (
  redirects: readonly Redirect[],
  options: EvaluateOptions
): RedirectTarget[] {
  const result: RedirectTarget[] = []
  for (const redirect of redirects) {
    if (redirect.heredoc !== undefined || redirect.operator === '<<<') {
      continue
    }
    for (const target of evaluateWord(redirect.target, options)) {
      const isFdDuplicate = (redirect.operator === '<&' ||
        redirect.operator === '>&') &&
        (redirect.fd !== undefined || /^(?:\d+|-)$/.test(target.text))
      if (!isFdDuplicate) {
        result.push({ operator: redirect.operator, fd: redirect.fd, target })
      }
    }
  }
  return result
}

/** `$(pwd)` is the only substitution whose output is known statically. */
function knownSubstitution (
  cwd: string
): (script: Script) => string | undefined {
  return (script) => {
    const [statement, ...others] = script.statements
    const command = statement?.command
    if (others.length > 0 || command?.kind !== 'simple') {
      return undefined
    }
    const [name, ...args] = command.words
    if (name !== undefined && args.length === 0 &&
      staticText(name) === 'pwd') {
      return cwd
    }
    return undefined
  }
}

class Analyser {
  private readonly commands: CommandInstance[] = []
  private readonly failures: ParseFailure[] = []
  private readonly directories: Argument[] = []

  constructor (private readonly options: AnalyseOptions) {}

  run (source: string): ShellAnalysis {
    this.analyse(source, 0, false, false)
    return {
      commands: this.commands,
      failures: this.failures,
      directories: this.directories
    }
  }

  private analyse (
    source: string,
    depth: number,
    remote: boolean,
    inSubstitution: boolean
  ): void {
    let script: Script
    try {
      script = parseShell(source)
    } catch (error) {
      if (!(error instanceof ShellParseError)) {
        throw error
      }
      this.failures.push({ source, reason: error.message })
      return
    }
    const options = this.evaluateOptions(script)

    walkCommands(script, ({ command, redirects, inSubstitution: inner }) => {
      const substituted = inSubstitution || inner
      if (command === undefined) {
        this.commands.push({
          layers: [[]],
          redirects: redirectTargets(redirects, options),
          source: '',
          inSubstitution: substituted,
          remote
        })
        return
      }
      const targets = redirectTargets(redirects, options)
      for (const argv of argvVariants(command.words, options)) {
        this.addCommand(argv, targets, command.source, depth, remote,
          substituted)
      }
    })
  }

  private addCommand (
    argv: Argument[],
    redirects: RedirectTarget[],
    source: string,
    depth: number,
    remote: boolean,
    inSubstitution: boolean
  ): void {
    const layers = unwrapLayers(argv)
    this.commands.push({ layers, redirects, source, inSubstitution, remote })

    for (const layer of layers) {
      const name = layer[0] === undefined ? '' : commandName(layer[0].text)
      if ((name === 'cd' || name === 'pushd') && layer[1] !== undefined) {
        this.directories.push(layer[1])
      }
      if (depth >= MAX_NESTING) {
        if (nestedPrograms(layer).length > 0) {
          this.failures.push({ source, reason: 'nested too deeply' })
        }
        continue
      }
      for (const program of nestedPrograms(layer)) {
        this.analyse(program, depth + 1, remote, inSubstitution)
      }
      const remoteProgram = sshRemoteProgram(layer)
      if (remoteProgram !== undefined) {
        this.analyse(remoteProgram, depth + 1, true, inSubstitution)
      }
      for (const exec of findExecCommands(layer)) {
        this.addCommand(exec, [], source, depth + 1, remote, inSubstitution)
      }
    }
  }

  private evaluateOptions (script: Script): EvaluateOptions {
    const { cwd, home, environment = {} } = this.options
    const variables = new Map<string, string[]>()
    for (const name of KNOWN_ENVIRONMENT) {
      const value = name === 'HOME'
        ? home
        : name === 'PWD' ? cwd : environment[name]
      if (value !== undefined && value !== '') {
        variables.set(name, [value])
      }
    }
    const base: EvaluateOptions = {
      home, variables, substitution: knownSubstitution(cwd)
    }
    const assigned = collectAssignments(script, (word) =>
      staticText(word, base))
    for (const [name, values] of assigned) {
      variables.set(name, values)
    }
    return base
  }
}

/**
 * Analyses a bash command: every command it may run (including nested
 * `sh -c`, `eval`, `find -exec`, `xargs`, `watch` and `ssh` payloads),
 * with wrappers such as `sudo`, `env` and `timeout` peeled off.
 *
 * @param source - The command text.
 * @param options - Working directory, home and known environment.
 * @returns The commands, any text that could not be parsed, and `cd`
 *   targets.
 */
function analyseShell (source: string, options: AnalyseOptions): ShellAnalysis {
  return new Analyser(options).run(source)
}

export { analyseShell, commandName, isOption }
export type {
  AnalyseOptions,
  Argument,
  CommandInstance,
  ParseFailure,
  RedirectTarget,
  ShellAnalysis
}
