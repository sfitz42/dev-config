import type { Script, Word, WordPart } from './shell-ast.ts'

/** Every static value seen for each shell variable. */
type Variables = ReadonlyMap<string, readonly string[]>

interface WordValue {
  /** The word with known expansions applied and unknown ones as `$NAME`. */
  readonly text: string
  /** True when some part depends on runtime state (`$X`, `$(...)`, `~u`). */
  readonly unresolved: boolean
  /** True when the unresolved part is at the start of the word. */
  readonly unresolvedPrefix: boolean
  /** True when unquoted text contains glob characters. */
  readonly hasGlob: boolean
}

interface EvaluateOptions {
  readonly variables?: Variables
  readonly home?: string
  /** Static output of a command substitution (`$(pwd)`), if known. */
  readonly substitution?: (script: Script) => string | undefined
}

const MAX_BRACE_RESULTS = 64
const MAX_VARIANTS = 16

function partPlaceholder (part: WordPart): string {
  switch (part.kind) {
    case 'literal':
      return part.value
    case 'parameter':
      return part.hasOperator ? `\${${part.name}}` : `$${part.name}`
    case 'command-substitution':
      return '$(...)'
    case 'process-substitution':
      return `${part.direction}(...)`
    case 'arithmetic':
      return '$((...))'
  }
}

function knownParameter (
  part: WordPart,
  variables: Variables | undefined
): readonly string[] | undefined {
  if (part.kind !== 'parameter' || part.hasOperator) {
    return undefined
  }
  const values = variables?.get(part.name)
  return values === undefined || values.length === 0 ? undefined : values
}

/**
 * Evaluates a word as far as is statically possible. A variable assigned
 * more than one static value yields one result per value (at most 16).
 *
 * @param word - The parsed word.
 * @param options - Known variable values and the home directory.
 * @returns Each possible text and whether parts are unknown until runtime.
 */
function evaluateWord (
  word: Word,
  options: EvaluateOptions = {}
): WordValue[] {
  let texts = ['']
  let unresolved = false
  let unresolvedPrefix = false
  let hasGlob = false
  const append = (suffixes: readonly string[]): void => {
    texts = texts
      .flatMap((text) => suffixes.map((suffix) => text + suffix))
      .slice(0, MAX_VARIANTS)
  }

  word.parts.forEach((part, index) => {
    if (part.kind === 'literal') {
      let value = part.value
      if (index === 0 && !part.quoted && value.startsWith('~')) {
        const tilde = expandTilde(value, options.home)
        if (tilde === undefined) {
          unresolved = true
          unresolvedPrefix = true
        } else {
          value = tilde
        }
      }
      if (!part.quoted && /[*?[]/.test(value)) {
        hasGlob = true
      }
      append([value])
      return
    }
    const known = knownParameter(part, options.variables)
    if (known !== undefined) {
      append(known)
      return
    }
    const output = part.kind === 'command-substitution'
      ? options.substitution?.(part.script)
      : undefined
    if (output !== undefined) {
      append([output])
      return
    }
    unresolved = true
    if (index === 0) {
      unresolvedPrefix = true
    }
    append([partPlaceholder(part)])
  })

  return texts.map((text) => ({
    text, unresolved, unresolvedPrefix, hasGlob
  }))
}

/** The word's single static text, or undefined if it depends on runtime. */
function staticText (
  word: Word,
  options: EvaluateOptions = {}
): string | undefined {
  const [value, ...others] = evaluateWord(word, options)
  return value === undefined || value.unresolved || others.length > 0
    ? undefined
    : value.text
}

/** `~` and `~/x` expand to home; `~user` is unknown. */
function expandTilde (
  value: string,
  home: string | undefined
): string | undefined {
  const slash = value.indexOf('/')
  const prefix = slash === -1 ? value : value.slice(0, slash)
  if (prefix !== '~' || home === undefined) {
    return undefined
  }
  return home + value.slice(1)
}

/**
 * Expands `{a,b}` and `{1..3}` the way bash would, keeping the input too.
 *
 * @param text - Word text; quoting is not tracked, so results may include
 *   expansions bash would not make. Extra candidates are the safe direction.
 * @returns The original text followed by every expansion, at most 64.
 */
function expandBraces (text: string): string[] {
  const results = new Set<string>([text])
  const queue = [text]
  while (queue.length > 0 && results.size < MAX_BRACE_RESULTS) {
    const current = queue.shift()
    if (current === undefined) {
      break
    }
    for (const expanded of expandFirstBrace(current)) {
      if (!results.has(expanded)) {
        results.add(expanded)
        queue.push(expanded)
      }
    }
  }
  return [...results].slice(0, MAX_BRACE_RESULTS)
}

function expandFirstBrace (text: string): string[] {
  for (let open = text.indexOf('{'); open !== -1;
    open = text.indexOf('{', open + 1)) {
    let depth = 0
    const commas: number[] = []
    for (let i = open; i < text.length; i++) {
      const c = text.charAt(i)
      if (c === '{') {
        depth += 1
      } else if (c === '}') {
        depth -= 1
        if (depth === 0) {
          const body = text.slice(open + 1, i)
          const before = text.slice(0, open)
          const after = text.slice(i + 1)
          if (commas.length > 0) {
            const options: string[] = []
            let start = open + 1
            for (const comma of [...commas, i]) {
              options.push(text.slice(start, comma))
              start = comma + 1
            }
            return options.map((option) => before + option + after)
          }
          const range = expandRange(body)
          if (range !== undefined) {
            return range.map((item) => before + item + after)
          }
          break
        }
      } else if (c === ',' && depth === 1) {
        commas.push(i)
      }
    }
  }
  return []
}

function expandRange (body: string): string[] | undefined {
  const numeric = /^(-?\d+)\.\.(-?\d+)$/.exec(body)
  if (numeric?.[1] !== undefined && numeric[2] !== undefined) {
    const from = Number(numeric[1])
    const to = Number(numeric[2])
    if (Math.abs(to - from) > MAX_BRACE_RESULTS) {
      return undefined
    }
    const step = from <= to ? 1 : -1
    const items: string[] = []
    for (let n = from; n !== to + step; n += step) {
      items.push(String(n))
    }
    return items
  }
  const letters = /^([A-Za-z])\.\.([A-Za-z])$/.exec(body)
  if (letters?.[1] !== undefined && letters[2] !== undefined) {
    const from = letters[1].charCodeAt(0)
    const to = letters[2].charCodeAt(0)
    const step = from <= to ? 1 : -1
    const items: string[] = []
    for (let n = from; n !== to + step; n += step) {
      items.push(String.fromCharCode(n))
    }
    return items
  }
  return undefined
}

export { evaluateWord, expandBraces, staticText }
export type { EvaluateOptions, Variables, WordValue }
