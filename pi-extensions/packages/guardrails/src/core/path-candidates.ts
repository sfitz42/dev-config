import { existsSync, globSync } from 'node:fs'
import { dirname, isAbsolute, parse as parsePath, resolve } from 'node:path'

import { expandHome, isWithin, maybePathLike, pathForms } from './paths.ts'
import { analyseShell, commandName, isOption } from './shell-analysis.ts'

import type {
  AnalyseOptions,
  Argument,
  CommandInstance,
  ShellAnalysis
} from './shell-analysis.ts'

interface ClassifiedArgument {
  readonly text: string
  /** Interpreter program text: the token came from inside a code string. */
  readonly programText?: boolean
}

/** A path a bash command may touch, for the path-access check. */
type PathTarget =
  | { readonly kind: 'path', readonly absolutePath: string }
  | { readonly kind: 'unknown', readonly text: string }

/** A file a tool call may touch, for policy matching. */
interface PolicyTarget {
  /** The path as written, or an absolute path from glob/cd resolution. */
  readonly path: string
  /** True when the path still holds a runtime expansion. */
  readonly unresolved: boolean
}

interface CandidateOptions extends AnalyseOptions {
  /** Existence probe; injectable for tests. */
  readonly exists?: (path: string) => boolean
}

const MAX_GLOB_RESULTS = 200

/** POSIX utilities whose operands are always text, never files. */
const NO_FILE_OPERAND_COMMANDS = new Set(['echo', 'printf', 'tr'])

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash'])

/** Interpreters that take a program on the command line. */
const CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ['-c'],
  node: ['-e', '-p', '--eval', '--print'],
  deno: ['eval'],
  bun: ['-e', '--eval'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r'],
  lua: ['-e'],
  rscript: ['-e'],
  osascript: ['-e'],
  powershell: ['-command', '-c', '-ca'],
  pwsh: ['-command', '-c', '-ca']
}

/**
 * Commands that create missing parent directories, so a destination that
 * does not exist yet is still a real access.
 */
const PATH_CREATING_COMMANDS = new Set([
  '7z', 'cp', 'curl', 'dd', 'git', 'install', 'ln', 'mkdir', 'mktemp',
  'mv', 'rsync', 'tar', 'tee', 'touch', 'unzip', 'wget', 'zip'
])

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const REMOTE_TARGET = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/
const WILDCARD_SEGMENT = /(?:^|\/)\.\.\.(?:\/|$)/
const CODE_TOKEN = /"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s"'`<>|;&(){}[\],]+)/g
const SUB_TOKEN_SEPARATORS = /[\s=:,;'"`()<>|&{}[\]]+/

function interpreterKey (name: string): string | undefined {
  if (/^python[0-9.]*$/.test(name)) {
    return 'python'
  }
  if (/^lua[0-9.]*$/.test(name)) {
    return 'lua'
  }
  return Object.hasOwn(CODE_FLAGS, name) ? name : undefined
}

function isCodeFlag (flags: readonly string[], arg: string): boolean {
  const lower = arg.toLowerCase()
  return flags.includes(lower) ||
    // Grouped short options ending in the code flag: `python -Bc`.
    flags.some((flag) => /^-[a-z]$/.test(flag) &&
      new RegExp(`^-[A-Za-z]*${flag.slice(1)}$`).test(arg))
}

function tokensFromCode (code: string): ClassifiedArgument[] {
  const result: ClassifiedArgument[] = []
  for (const match of code.matchAll(CODE_TOKEN)) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4] ?? ''
    if (token !== '' && !token.startsWith('-')) {
      result.push({ text: token, programText: true })
    }
  }
  return result
}

function classifyFind (args: readonly string[]): ClassifiedArgument[] {
  const roots: ClassifiedArgument[] = []
  for (const arg of args) {
    if (arg.startsWith('-') || ['(', ')', '!', '\\(', '\\)'].includes(arg)) {
      break
    }
    roots.push({ text: arg })
  }
  return roots
}

function skipValues (
  args: readonly string[],
  flags: ReadonlySet<string>
): ClassifiedArgument[] {
  const result: ClassifiedArgument[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (flags.has(arg)) {
      i += 1
      continue
    }
    result.push({ text: arg })
  }
  return result
}

/**
 * Picks the arguments of a command that may name local files.
 *
 * @param name - Normalised command name.
 * @param args - Arguments after the name.
 * @returns Arguments to consider as paths.
 */
function classifyArguments (
  name: string,
  args: readonly string[]
): ClassifiedArgument[] {
  if (NO_FILE_OPERAND_COMMANDS.has(name) || name === 'ssh') {
    return []
  }
  if (name === 'find' || name === 'gfind') {
    return classifyFind(args)
  }
  if (name === 'cut') {
    return skipValues(args, new Set(['-d', '--delimiter']))
  }
  if (name === 'sort') {
    return skipValues(args, new Set(['-t', '--field-separator']))
  }
  if (name === 'kubectl') {
    const end = args.indexOf('--')
    return (end === -1 ? args : args.slice(0, end)).map((text) => ({ text }))
  }
  if (SHELLS.has(name)) {
    // The `-c` program is analysed as shell; only script operands remain.
    const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))
    if (flag === -1) {
      return args.map((text) => ({ text }))
    }
    const program = args.findIndex((arg, i) => i > flag && !isOption(arg))
    return args
      .filter((_arg, i) => i !== program)
      .map((text) => ({ text }))
  }
  const interpreter = interpreterKey(name)
  if (interpreter !== undefined) {
    const flags = CODE_FLAGS[interpreter] ?? []
    const result: ClassifiedArgument[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? ''
      if (isCodeFlag(flags, arg)) {
        result.push(...tokensFromCode(args[i + 1] ?? ''))
        i += 1
      } else {
        result.push({ text: arg })
      }
    }
    return result
  }
  return args.map((text) => ({ text }))
}

/** True for shapes that cannot be local paths: URLs, `host:path`, `./...`. */
function hasNonPathShape (token: string): boolean {
  return URL_SCHEME.test(token) || REMOTE_TARGET.test(token) ||
    WILDCARD_SEGMENT.test(token)
}

/**
 * A missing path whose parent is also missing is almost certainly an
 * identifier (`ctx7 docs /websites/x`), not a file. Top-level entries stay
 * plausible because their parent (the root) always exists.
 */
function isImplausibleLocalPath (
  absolutePath: string,
  exists: (path: string) => boolean
): boolean {
  if (exists(absolutePath)) {
    return false
  }
  const parent = dirname(absolutePath)
  if (parent === absolutePath || dirname(parent) === parent) {
    return false
  }
  return !exists(parent)
}

function createsPaths (instance: CommandInstance): boolean {
  return instance.layers.some((layer) => {
    const [first, ...rest] = layer
    if (first !== undefined &&
      PATH_CREATING_COMMANDS.has(commandName(first.text))) {
      return true
    }
    return rest.some((arg) => !arg.text.includes('/') &&
      PATH_CREATING_COMMANDS.has(arg.text.toLowerCase()) &&
      arg.text.toLowerCase() !== 'install')
  }) || instance.layers.some((layer) =>
    interpreterKey(commandName(layer[0]?.text ?? '')) !== undefined)
}

/** Splits text on characters that cannot be part of a path argument. */
function subTokens (text: string): string[] {
  return text.split(SUB_TOKEN_SEPARATORS).filter((token) => token !== '')
}

function expandGlob (pattern: string, cwd: string): string[] {
  if (pattern.includes('**')) {
    return []
  }
  try {
    return globSync(pattern, { cwd })
      .slice(0, MAX_GLOB_RESULTS)
      .map((match) => resolve(cwd, match))
  } catch {
    return []
  }
}

/** Every directory a relative path may be relative to. */
function baseDirectories (
  analysis: ShellAnalysis,
  options: CandidateOptions
): string[] {
  const dirs = new Set([options.cwd])
  for (const directory of analysis.directories) {
    if (!directory.unresolvedPrefix) {
      dirs.add(resolve(options.cwd, expandHome(directory.text, options.home)))
    }
  }
  return [...dirs]
}

/** argv of each layer, minus the part that the next layer runs. */
function layerArguments (instance: CommandInstance): {
  name: string
  args: Argument[]
}[] {
  return instance.layers.map((layer, index) => {
    const next = instance.layers[index + 1]
    const own = next === undefined
      ? layer.slice(1)
      : layer.slice(1, layer.length - next.length)
    return { name: commandName(layer[0]?.text ?? ''), args: own }
  })
}

/**
 * Absolute paths (and unknown locations) a bash command may touch, for
 * the outside-workspace check.
 *
 * @param command - The bash command text.
 * @param options - Working directory, home, environment and probes.
 * @returns De-duplicated targets.
 */
function bashPathTargets (
  command: string,
  options: CandidateOptions
): PathTarget[] {
  const exists = options.exists ?? existsSync
  const analysis = analyseShell(command, options)
  const bases = baseDirectories(analysis, options)
  const seen = new Set<string>()
  const targets: PathTarget[] = []

  const addPath = (absolutePath: string): void => {
    if (parsePath(absolutePath).root === absolutePath) {
      return
    }
    for (const form of pathForms(absolutePath)) {
      if (!seen.has(form)) {
        seen.add(form)
        targets.push({ kind: 'path', absolutePath: form })
      }
    }
  }
  const addUnknown = (text: string): void => {
    const key = `?${text}`
    if (!seen.has(key)) {
      seen.add(key)
      targets.push({ kind: 'unknown', text })
    }
  }
  const add = (
    argument: Pick<Argument, 'text' | 'unresolvedPrefix' | 'hasGlob'>,
    force: boolean,
    plausible: boolean
  ): void => {
    const { text } = argument
    if (text === '' || (!force && text.startsWith('-'))) {
      return
    }
    if (!force && (!maybePathLike(text) || hasNonPathShape(text))) {
      return
    }
    if (argument.unresolvedPrefix) {
      addUnknown(text)
      return
    }
    const expanded = expandHome(text, options.home)
    const roots = isAbsolute(expanded) ? [options.cwd] : bases
    for (const base of roots) {
      const absolute = resolve(base, expanded)
      const matches = argument.hasGlob ? expandGlob(expanded, base) : []
      for (const candidate of [absolute, ...matches]) {
        if (!force && !plausible && !isWithin(candidate, options.cwd) &&
          isImplausibleLocalPath(candidate, exists)) {
          continue
        }
        addPath(candidate)
      }
    }
  }

  for (const failure of analysis.failures) {
    for (const token of tokensFromCode(failure.source)) {
      add({ text: token.text, unresolvedPrefix: false, hasGlob: false },
        false, true)
    }
  }
  for (const directory of analysis.directories) {
    add(directory, true, true)
  }
  for (const instance of analysis.commands) {
    if (instance.remote) {
      continue
    }
    for (const redirect of instance.redirects) {
      add(redirect.target, true, true)
    }
    const plausible = createsPaths(instance)
    for (const { name, args } of layerArguments(instance)) {
      const classified = classifyArguments(name, args.map((arg) => arg.text))
      for (const item of classified) {
        const source = args.find((arg) => arg.text === item.text)
        add({
          text: item.text,
          unresolvedPrefix: item.programText !== true &&
            (source?.unresolvedPrefix ?? false),
          hasGlob: source?.hasGlob ?? false
        }, false, plausible || item.programText === true)
      }
    }
  }
  return targets
}

/**
 * Files a bash command may read or write, for policy matching. Deliberately
 * broad: every argument, its sub-tokens (`--file=.env`, `HEAD:.env`,
 * interpreter code), glob matches and redirect targets, including output
 * of `echo`/`printf` used inside a substitution.
 *
 * @param command - The bash command text.
 * @param options - Working directory, home and environment.
 * @returns Targets as written plus resolved forms.
 */
function bashPolicyTargets (
  command: string,
  options: CandidateOptions
): PolicyTarget[] {
  const analysis = analyseShell(command, options)
  const bases = baseDirectories(analysis, options)
  const targets = new Map<string, boolean>()

  const add = (text: string, unresolved: boolean, hasGlob: boolean): void => {
    const tokens = new Set([text, ...subTokens(text)])
    for (const token of tokens) {
      if (token === '' || token === '-' || token === '--') {
        continue
      }
      // A path that holds an expansion is kept even if resolved elsewhere.
      targets.set(token, (targets.get(token) ?? false) || unresolved)
      const expanded = expandHome(token, options.home)
      for (const base of bases) {
        if (base !== options.cwd && !isAbsolute(expanded)) {
          targets.set(resolve(base, expanded), unresolved)
        }
        if (hasGlob) {
          for (const match of expandGlob(expanded, base)) {
            targets.set(match, false)
          }
        }
      }
    }
  }

  for (const failure of analysis.failures) {
    for (const token of tokensFromCode(failure.source)) {
      add(token.text, false, /[*?[]/.test(token.text))
    }
  }
  for (const instance of analysis.commands) {
    if (instance.remote) {
      continue
    }
    for (const redirect of instance.redirects) {
      add(redirect.target.text, redirect.target.unresolved,
        redirect.target.hasGlob)
    }
    for (const { name, args } of layerArguments(instance)) {
      if (NO_FILE_OPERAND_COMMANDS.has(name) && !instance.inSubstitution) {
        continue
      }
      for (const arg of args) {
        add(arg.text, arg.unresolved, arg.hasGlob)
      }
    }
  }
  return [...targets].map(([path, unresolved]) => ({ path, unresolved }))
}

/**
 * Policy targets for text that is not bash (PowerShell): every token and
 * sub-token, unparsed.
 */
function tokenPolicyTargets (text: string): PolicyTarget[] {
  const tokens = new Set<string>()
  for (const token of tokensFromCode(text)) {
    tokens.add(token.text)
    for (const sub of subTokens(token.text)) {
      tokens.add(sub)
    }
  }
  return [...tokens].map((path) => ({ path, unresolved: false }))
}

export {
  bashPathTargets,
  bashPolicyTargets,
  classifyArguments,
  hasNonPathShape,
  isImplausibleLocalPath,
  subTokens,
  tokenPolicyTargets,
  tokensFromCode
}
export type { CandidateOptions, PathTarget, PolicyTarget }
