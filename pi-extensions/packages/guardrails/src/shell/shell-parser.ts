import type {
  Assignment,
  Command,
  Heredoc,
  LiteralPart,
  Redirect,
  RedirectOperator,
  Script,
  SimpleCommand,
  Statement,
  Word,
  WordPart
} from './shell-ast.ts'

/** Thrown for any input the parser does not fully understand. */
class ShellParseError extends Error {
  readonly position: number

  constructor (message: string, position: number) {
    super(`${message} at offset ${position}`)
    this.name = 'ShellParseError'
    this.position = position
  }
}

const MAX_DEPTH = 64
const MAX_SOURCE_LENGTH = 1_000_000

const BLANKS = new Set([' ', '\t', '\r'])
const METACHARACTERS = new Set([
  ' ', '\t', '\r', '\n', ';', '&', '|', '<', '>', '(', ')'
])
const EXTGLOB_PREFIXES = new Set(['?', '*', '+', '@', '!'])
const SPECIAL_PARAMETERS = new Set(['@', '*', '#', '?', '$', '!', '-', '0'])
const REDIRECT_OPERATORS: readonly RedirectOperator[] = [
  '<<<', '<<-', '&>>', '<<', '<>', '<&', '>>', '>|', '>&', '&>', '<', '>'
]
const RESERVED_TERMINATORS = new Set([
  'then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}'
])
const ASSIGNMENT = /[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]\n]*\])?\+?=/y
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y

type Terminator = (parser: Parser) => boolean

interface MutableHeredoc {
  body: string
  expands: boolean
  operands: Word[]
}

interface PendingHeredoc {
  readonly delimiter: string
  readonly stripTabs: boolean
  readonly heredoc: MutableHeredoc
}

class WordBuilder {
  private readonly parts: WordPart[] = []
  private text = ''
  private quoted = false

  literal (value: string, quoted: boolean): void {
    if (value === '') {
      return
    }
    if (this.text !== '' && this.quoted !== quoted) {
      this.flush()
    }
    this.text += value
    this.quoted = quoted
  }

  part (part: WordPart): void {
    this.flush()
    this.parts.push(part)
  }

  isEmpty (): boolean {
    return this.text === '' && this.parts.length === 0
  }

  lastLiteralChar (): string | undefined {
    return this.text === '' ? undefined : this.text.at(-1)
  }

  build (): Word {
    this.flush()
    return { parts: [...this.parts] }
  }

  private flush (): void {
    if (this.text !== '') {
      const part: LiteralPart = {
        kind: 'literal', value: this.text, quoted: this.quoted
      }
      this.parts.push(part)
      this.text = ''
    }
  }
}

class Parser {
  private pos = 0
  private nesting = 0
  private readonly pending: PendingHeredoc[] = []

  constructor (
    private readonly src: string,
    private readonly depth: number
  ) {
    if (depth > MAX_DEPTH) {
      throw new ShellParseError('nesting too deep', 0)
    }
  }

  parseProgram (): Script {
    const script = this.parseScript(() => false)
    if (!this.atEnd()) {
      this.fail(`unexpected '${this.peek()}'`)
    }
    return script
  }

  /** Reads text where only `\`, `$` and backticks are special. */
  parseLoose (): Word {
    const word = new WordBuilder()
    while (!this.atEnd()) {
      const c = this.peek()
      if (c === '\\' && this.pos + 1 < this.src.length) {
        word.literal(this.src.charAt(this.pos + 1), true)
        this.pos += 2
      } else if (c === '$') {
        this.readDollar(word, true)
      } else if (c === '`') {
        word.part(this.readBackticks())
      } else {
        word.literal(c, false)
        this.pos += 1
      }
    }
    return word.build()
  }

  // Lists and pipelines

  private parseScript (isTerminator: Terminator): Script {
    const statements: Statement[] = []
    for (;;) {
      this.skipBlanksAndNewlines()
      if (this.atEnd() || isTerminator(this)) {
        break
      }
      const command = this.parseAndOr()
      this.skipBlanks()
      let background = false
      const c = this.peek()
      if (c === '&' && !this.startsWith('&&') && !this.startsWith('&>')) {
        this.pos += 1
        background = true
      } else if (c === ';' && !this.startsWith(';;') &&
        !this.startsWith(';&')) {
        this.pos += 1
      } else if (c === '\n') {
        this.consumeNewline()
      } else if (!this.atEnd() && !isTerminator(this)) {
        this.fail(`unexpected '${c}'`)
      }
      statements.push({ command, background })
    }
    return { statements }
  }

  private parseAndOr (): Command {
    let left = this.parsePipeline()
    for (;;) {
      this.skipBlanks()
      const operator = this.startsWith('&&')
        ? '&&'
        : this.startsWith('||') ? '||' : undefined
      if (operator === undefined) {
        return left
      }
      this.pos += 2
      this.skipBlanksAndNewlines()
      const right = this.parsePipeline()
      left = { kind: 'and-or', left, operator, right }
    }
  }

  private parsePipeline (): Command {
    this.skipBlanks()
    let negated = false
    for (;;) {
      const word = this.peekReservedWord()
      if (word === 'time') {
        this.pos += 4
        this.skipBlanks()
        if (this.peekReservedWord() === '-p') {
          this.pos += 2
        }
      } else if (word === '!') {
        this.pos += 1
        negated = !negated
      } else {
        break
      }
      this.skipBlanks()
    }

    const commands = [this.parseCommand()]
    for (;;) {
      this.skipBlanks()
      if (this.startsWith('|&')) {
        this.pos += 2
      } else if (this.peek() === '|' && !this.startsWith('||')) {
        this.pos += 1
      } else {
        break
      }
      this.skipBlanksAndNewlines()
      commands.push(this.parseCommand())
    }
    const [only] = commands
    if (commands.length === 1 && !negated && only !== undefined) {
      return only
    }
    return { kind: 'pipeline', commands, negated }
  }

  // Commands

  private parseCommand (): Command {
    return this.nested(() => {
      this.skipBlanks()
      const word = this.peekReservedWord()
      switch (word) {
        case 'if':
          return this.parseIf()
        case 'while':
        case 'until':
          return this.parseLoop(word === 'until')
        case 'for':
        case 'select':
          return this.parseFor(word.length)
        case 'case':
          return this.parseCase()
        case 'function':
          return this.parseFunctionKeyword()
        case '{':
          return this.parseGroup()
        case '[[':
          return this.parseTest()
        case 'coproc':
          this.pos += word.length
          return { kind: 'coproc', body: this.parseCommand() }
        default:
          break
      }
      if (RESERVED_TERMINATORS.has(word)) {
        this.fail(`unexpected '${word}'`)
      }
      if (this.startsWith('((')) {
        const arithmetic = this.tryArithmetic(this.pos + 2)
        if (arithmetic !== undefined) {
          this.pos = arithmetic.end
          return {
            kind: 'arithmetic-command',
            operands: [arithmetic.operand],
            redirects: this.parseRedirects()
          }
        }
      }
      if (this.peek() === '(') {
        this.pos += 1
        const body = this.parseScript((p) => p.peek() === ')')
        this.expectChar(')')
        return { kind: 'subshell', body, redirects: this.parseRedirects() }
      }
      return this.parseSimpleCommand()
    })
  }

  private parseSimpleCommand (): Command {
    const start = this.pos
    const assignments: Assignment[] = []
    const words: Word[] = []
    const redirects: Redirect[] = []

    for (;;) {
      this.skipBlanks()
      const redirect = this.tryRedirect()
      if (redirect !== undefined) {
        redirects.push(redirect)
        continue
      }
      if (this.atCommandEnd()) {
        break
      }
      if (words.length === 0) {
        const assignment = this.tryAssignment()
        if (assignment !== undefined) {
          assignments.push(assignment)
          continue
        }
      }
      if (this.peek() === '(') {
        const [name] = words
        if (words.length === 1 && assignments.length === 0 &&
          name !== undefined) {
          return this.parseFunctionBody(literalText(name))
        }
        this.fail("unexpected '('")
      }
      const word = this.readWord()
      if (word.parts.length === 0) {
        this.fail(`unexpected '${this.peek()}'`)
      }
      words.push(word)
    }

    if (words.length === 0 && assignments.length === 0 &&
      redirects.length === 0) {
      this.fail(this.atEnd() ? 'missing command' : `unexpected '${this.peek()}'`)
    }
    const source = this.src.slice(start, this.pos).trim()
    const command: SimpleCommand = {
      kind: 'simple', assignments, words, redirects, source
    }
    return command
  }

  private parseFunctionBody (name: string | undefined): Command {
    if (name === undefined || !/^[^\s$`'"\\]+$/.test(name)) {
      this.fail('invalid function name')
    }
    this.expectChar('(')
    this.skipBlanks()
    this.expectChar(')')
    this.skipBlanksAndNewlines()
    return { kind: 'function', name, body: this.parseCommand() }
  }

  private parseFunctionKeyword (): Command {
    this.pos += 'function'.length
    this.skipBlanks()
    const name = literalText(this.readWord())
    if (name === undefined || name === '') {
      this.fail('invalid function name')
    }
    this.skipBlanks()
    if (this.peek() === '(') {
      this.pos += 1
      this.skipBlanks()
      this.expectChar(')')
    }
    this.skipBlanksAndNewlines()
    return { kind: 'function', name, body: this.parseCommand() }
  }

  private parseIf (): Command {
    this.pos += 2
    const branches: { condition: Script, body: Script }[] = []
    let otherwise: Script | undefined
    const until = (...words: string[]): Terminator =>
      (p) => words.includes(p.peekReservedWord())

    let condition = this.parseScript(until('then'))
    this.expectReserved('then')
    let body = this.parseScript(until('elif', 'else', 'fi'))
    branches.push({ condition, body })
    for (;;) {
      const word = this.peekReservedWord()
      if (word === 'elif') {
        this.pos += 4
        condition = this.parseScript(until('then'))
        this.expectReserved('then')
        body = this.parseScript(until('elif', 'else', 'fi'))
        branches.push({ condition, body })
      } else if (word === 'else') {
        this.pos += 4
        otherwise = this.parseScript(until('fi'))
        this.expectReserved('fi')
        break
      } else {
        this.expectReserved('fi')
        break
      }
    }
    return {
      kind: 'if', branches, otherwise, redirects: this.parseRedirects()
    }
  }

  private parseLoop (until: boolean): Command {
    // 'while' and 'until' are both five characters.
    this.pos += 5
    const condition = this.parseScript((p) => p.peekReservedWord() === 'do')
    const body = this.parseDoGroup()
    return {
      kind: 'loop', until, condition, body, redirects: this.parseRedirects()
    }
  }

  private parseDoGroup (): Script {
    this.skipBlanksAndNewlines()
    this.expectReserved('do')
    const body = this.parseScript((p) => p.peekReservedWord() === 'done')
    this.expectReserved('done')
    return body
  }

  private parseFor (keywordLength: number): Command {
    this.pos += keywordLength
    this.skipBlanks()
    if (this.startsWith('((')) {
      const arithmetic = this.tryArithmetic(this.pos + 2)
      if (arithmetic === undefined) {
        this.fail('unterminated arithmetic for')
      }
      this.pos = arithmetic.end
      this.skipBlanks()
      if (this.peek() === ';') {
        this.pos += 1
      }
      const body = this.parseDoGroup()
      return {
        kind: 'arithmetic-for',
        operands: [arithmetic.operand],
        body,
        redirects: this.parseRedirects()
      }
    }

    const variable = literalText(this.readWord())
    if (variable === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      this.fail('invalid for variable')
    }
    this.skipBlanksAndNewlines()
    let items: Word[] | undefined
    if (this.peekReservedWord() === 'in') {
      this.pos += 2
      items = []
      for (;;) {
        this.skipBlanks()
        const c = this.peek()
        if (this.atEnd() || c === ';' || c === '\n') {
          break
        }
        const word = this.readWord()
        if (word.parts.length === 0) {
          this.fail(`unexpected '${c}'`)
        }
        items.push(word)
      }
    }
    if (this.peek() === ';') {
      this.pos += 1
    }
    const body = this.parseDoGroup()
    return {
      kind: 'for', variable, items, body, redirects: this.parseRedirects()
    }
  }

  private parseCase (): Command {
    this.pos += 4
    this.skipBlanks()
    const subject = this.readWord()
    if (subject.parts.length === 0) {
      this.fail('missing case subject')
    }
    this.skipBlanksAndNewlines()
    this.expectReserved('in')
    const items: { patterns: Word[], body: Script }[] = []
    for (;;) {
      this.skipBlanksAndNewlines()
      if (this.peekReservedWord() === 'esac') {
        this.pos += 4
        break
      }
      if (this.atEnd()) {
        this.fail("missing 'esac'")
      }
      if (this.peek() === '(') {
        this.pos += 1
      }
      const patterns: Word[] = []
      for (;;) {
        this.skipBlanks()
        const pattern = this.readWord()
        if (pattern.parts.length === 0) {
          this.fail(`unexpected '${this.peek()}' in case pattern`)
        }
        patterns.push(pattern)
        this.skipBlanks()
        if (this.peek() === '|') {
          this.pos += 1
        } else {
          this.expectChar(')')
          break
        }
      }
      const body = this.parseScript((p) =>
        p.startsWith(';;') || p.startsWith(';&') ||
        p.peekReservedWord() === 'esac')
      items.push({ patterns, body })
      if (this.startsWith(';;&')) {
        this.pos += 3
      } else if (this.startsWith(';;') || this.startsWith(';&')) {
        this.pos += 2
      }
    }
    return {
      kind: 'case', subject, items, redirects: this.parseRedirects()
    }
  }

  private parseGroup (): Command {
    this.pos += 1
    const body = this.parseScript((p) => p.peekReservedWord() === '}')
    this.expectReserved('}')
    return { kind: 'group', body, redirects: this.parseRedirects() }
  }

  private parseTest (): Command {
    this.pos += 2
    const words: Word[] = []
    for (;;) {
      this.skipBlanksAndNewlines()
      if (this.atEnd()) {
        this.fail("missing ']]'")
      }
      if (this.startsWith(']]') && this.isWordEnd(this.pos + 2)) {
        this.pos += 2
        break
      }
      if (this.startsWith('&&') || this.startsWith('||')) {
        this.pos += 2
        continue
      }
      const c = this.peek()
      if (c === '(' || c === ')' || c === '<' || c === '>' || c === '!') {
        this.pos += 1
        continue
      }
      const word = this.readWord()
      if (word.parts.length === 0) {
        this.fail(`unexpected '${c}' in [[ ]]`)
      }
      words.push(word)
      if (literalText(word) === '=~') {
        this.skipBlanks()
        words.push(this.readRegexOperand())
      }
    }
    return { kind: 'test', words, redirects: this.parseRedirects() }
  }

  /** `[[ x =~ (a|b) ]]`: the regex may contain unquoted parens and pipes. */
  private readRegexOperand (): Word {
    const word = new WordBuilder()
    let parens = 0
    while (!this.atEnd()) {
      const c = this.peek()
      if (parens === 0 && (BLANKS.has(c) || c === '\n')) {
        break
      }
      if (c === '(') {
        parens += 1
      } else if (c === ')') {
        parens -= 1
      }
      if (c === '\\' || c === "'" || c === '"' || c === '$' || c === '`') {
        const sub = this.readWordChunk()
        for (const part of sub.parts) {
          word.part(part)
        }
        continue
      }
      word.literal(c, true)
      this.pos += 1
    }
    return word.build()
  }

  // Redirects and assignments

  private parseRedirects (): Redirect[] {
    const redirects: Redirect[] = []
    for (;;) {
      this.skipBlanks()
      const redirect = this.tryRedirect()
      if (redirect === undefined) {
        return redirects
      }
      redirects.push(redirect)
    }
  }

  private tryRedirect (): Redirect | undefined {
    const start = this.pos
    let fd: number | undefined
    const digits = /\d+/y
    digits.lastIndex = this.pos
    const digitMatch = digits.exec(this.src)
    if (digitMatch !== null) {
      const after = this.src.charAt(this.pos + digitMatch[0].length)
      if (after === '<' || after === '>') {
        fd = Number(digitMatch[0])
        this.pos += digitMatch[0].length
      }
    } else if (this.peek() === '{') {
      const named = /\{[A-Za-z_][A-Za-z0-9_]*\}(?=[<>])/y
      named.lastIndex = this.pos
      const match = named.exec(this.src)
      if (match !== null) {
        this.pos += match[0].length
      }
    }

    const operator = REDIRECT_OPERATORS.find((op) => this.startsWith(op))
    if (operator === undefined ||
      ((operator === '<' || operator === '>') &&
        this.src.charAt(this.pos + 1) === '(' && fd === undefined &&
        start === this.pos)) {
      this.pos = start
      return undefined
    }
    this.pos += operator.length
    this.skipBlanks()

    if (operator === '<<' || operator === '<<-') {
      const delimiterWord = this.readWord()
      const delimiter = literalText(delimiterWord) ??
        heredocDelimiter(delimiterWord)
      if (delimiter === '') {
        this.fail('missing heredoc delimiter')
      }
      const heredoc: MutableHeredoc = {
        body: '',
        expands: !delimiterWord.parts.some((part) =>
          part.kind === 'literal' && part.quoted),
        operands: []
      }
      this.pending.push({
        delimiter, stripTabs: operator === '<<-', heredoc
      })
      const result: Heredoc = heredoc
      return { operator, fd, target: delimiterWord, heredoc: result }
    }

    const target = this.readWord()
    if (target.parts.length === 0) {
      this.fail(`missing target for '${operator}'`)
    }
    return { operator, fd, target, heredoc: undefined }
  }

  private tryAssignment (): Assignment | undefined {
    ASSIGNMENT.lastIndex = this.pos
    const match = ASSIGNMENT.exec(this.src)
    if (match === null) {
      return undefined
    }
    const name = match[0].replace(/(?:\[.*\])?\+?=$/, '')
    this.pos += match[0].length
    if (this.peek() === '(') {
      this.pos += 1
      const elements: Word[] = []
      for (;;) {
        this.skipBlanksAndNewlines()
        if (this.peek() === ')') {
          this.pos += 1
          break
        }
        if (this.atEnd()) {
          this.fail('unterminated array')
        }
        const element = this.readWord()
        if (element.parts.length === 0) {
          this.fail(`unexpected '${this.peek()}' in array`)
        }
        elements.push(element)
      }
      return { name, value: undefined, elements }
    }
    return { name, value: this.readWord(), elements: [] }
  }

  // Words

  private readWord (): Word {
    const word = new WordBuilder()
    this.readWordInto(word)
    return word.build()
  }

  /** Reads a single quoting or expansion unit into a new word. */
  private readWordChunk (): Word {
    const word = new WordBuilder()
    const c = this.peek()
    if (c === '\\') {
      this.readBackslash(word)
    } else if (c === "'") {
      this.readSingleQuoted(word)
    } else if (c === '"') {
      this.readDoubleQuoted(word)
    } else if (c === '$') {
      this.readDollar(word, false)
    } else if (c === '`') {
      word.part(this.readBackticks())
    }
    return word.build()
  }

  private readWordInto (word: WordBuilder): void {
    while (!this.atEnd()) {
      const c = this.peek()
      if ((c === '<' || c === '>') && this.src.charAt(this.pos + 1) === '(' &&
        word.isEmpty()) {
        word.part(this.readProcessSubstitution(c))
        continue
      }
      if (c === '(' && EXTGLOB_PREFIXES.has(word.lastLiteralChar() ?? '')) {
        this.readExtglob(word)
        continue
      }
      if (METACHARACTERS.has(c)) {
        return
      }
      switch (c) {
        case '\\':
          this.readBackslash(word)
          break
        case "'":
          this.readSingleQuoted(word)
          break
        case '"':
          this.readDoubleQuoted(word)
          break
        case '$':
          this.readDollar(word, false)
          break
        case '`':
          word.part(this.readBackticks())
          break
        default:
          word.literal(c, false)
          this.pos += 1
      }
    }
  }

  private readBackslash (word: WordBuilder): void {
    const next = this.src.charAt(this.pos + 1)
    this.pos += 2
    if (next !== '\n') {
      word.literal(next, true)
    }
  }

  private readSingleQuoted (word: WordBuilder): void {
    const end = this.src.indexOf("'", this.pos + 1)
    if (end === -1) {
      this.fail('unterminated single quote')
    }
    word.literal(this.src.slice(this.pos + 1, end), true)
    this.pos = end + 1
  }

  private readDoubleQuoted (word: WordBuilder): void {
    const start = this.pos
    this.pos += 1
    for (;;) {
      if (this.atEnd()) {
        this.pos = start
        this.fail('unterminated double quote')
      }
      const c = this.peek()
      if (c === '"') {
        this.pos += 1
        return
      }
      if (c === '\\') {
        const next = this.src.charAt(this.pos + 1)
        if (next === '\n') {
          this.pos += 2
        } else if ('$`"\\'.includes(next)) {
          word.literal(next, true)
          this.pos += 2
        } else {
          word.literal('\\', true)
          this.pos += 1
        }
      } else if (c === '$') {
        this.readDollar(word, true)
      } else if (c === '`') {
        word.part(this.readBackticks())
      } else {
        word.literal(c, true)
        this.pos += 1
      }
    }
  }

  private readAnsiC (word: WordBuilder): void {
    this.pos += 2
    let value = ''
    for (;;) {
      if (this.atEnd()) {
        this.fail("unterminated $'...'")
      }
      const c = this.peek()
      if (c === "'") {
        this.pos += 1
        break
      }
      if (c !== '\\') {
        value += c
        this.pos += 1
        continue
      }
      const next = this.src.charAt(this.pos + 1)
      const simple: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        a: '\x07',
        b: '\b',
        e: '\x1b',
        E: '\x1b',
        f: '\f',
        v: '\v',
        '\\': '\\',
        "'": "'",
        '"': '"',
        '?': '?'
      }
      const mapped = simple[next]
      if (mapped !== undefined) {
        value += mapped
        this.pos += 2
        continue
      }
      const hex = /x([0-9A-Fa-f]{1,2})/y
      hex.lastIndex = this.pos + 1
      const hexMatch = hex.exec(this.src)
      const octal = /[0-7]{1,3}/y
      octal.lastIndex = this.pos + 1
      const octalMatch = octal.exec(this.src)
      if (hexMatch?.[1] !== undefined) {
        value += String.fromCharCode(parseInt(hexMatch[1], 16))
        this.pos += 1 + hexMatch[0].length
      } else if (octalMatch !== null) {
        value += String.fromCharCode(parseInt(octalMatch[0], 8))
        this.pos += 1 + octalMatch[0].length
      } else {
        value += `\\${next}`
        this.pos += 2
      }
    }
    word.literal(value, true)
  }

  private readDollar (word: WordBuilder, inDoubleQuotes: boolean): void {
    const next = this.src.charAt(this.pos + 1)
    if (next === '(') {
      if (this.src.charAt(this.pos + 2) === '(') {
        const arithmetic = this.tryArithmetic(this.pos + 3)
        if (arithmetic !== undefined) {
          this.pos = arithmetic.end
          word.part({ kind: 'arithmetic', operands: [arithmetic.operand] })
          return
        }
      }
      this.pos += 2
      const script = this.parseScript((p) => p.peek() === ')')
      this.expectChar(')')
      word.part({ kind: 'command-substitution', script })
      return
    }
    if (next === '{') {
      this.readBracedParameter(word)
      return
    }
    IDENTIFIER.lastIndex = this.pos + 1
    const identifier = IDENTIFIER.exec(this.src)
    if (identifier !== null) {
      this.pos += 1 + identifier[0].length
      word.part({
        kind: 'parameter',
        name: identifier[0],
        hasOperator: false,
        operands: []
      })
      return
    }
    if (/[0-9]/.test(next) || SPECIAL_PARAMETERS.has(next)) {
      this.pos += 2
      word.part({
        kind: 'parameter', name: next, hasOperator: false, operands: []
      })
      return
    }
    if (next === "'" && !inDoubleQuotes) {
      this.readAnsiC(word)
      return
    }
    if (next === '"' && !inDoubleQuotes) {
      this.pos += 1
      this.readDoubleQuoted(word)
      return
    }
    word.literal('$', inDoubleQuotes)
    this.pos += 1
  }

  private readBracedParameter (word: WordBuilder): void {
    const start = this.pos
    const end = this.findClosingBrace(this.pos + 2)
    if (end === undefined) {
      this.pos = start
      this.fail('unterminated ${')
    }
    const body = this.src.slice(this.pos + 2, end)
    this.pos = end + 1
    const match = /^([!#]?)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])?/
      .exec(body)
    const prefix = match?.[1] ?? ''
    const name = match?.[2] ?? ''
    const rest = body.slice((match?.[0] ?? '').length)
    const operands = rest === ''
      ? []
      : [new Parser(rest, this.depth + 1).parseLoose()]
    word.part({
      kind: 'parameter',
      name,
      hasOperator: prefix !== '' || rest !== '',
      operands
    })
  }

  /** Finds the `}` closing a `${`, skipping quotes and nested expansions. */
  private findClosingBrace (from: number): number | undefined {
    let depth = 0
    for (let i = from; i < this.src.length; i++) {
      const c = this.src.charAt(i)
      if (c === '\\') {
        i += 1
      } else if (c === "'") {
        const close = this.src.indexOf("'", i + 1)
        if (close === -1) {
          return undefined
        }
        i = close
      } else if (c === '{') {
        depth += 1
      } else if (c === '}') {
        if (depth === 0) {
          return i
        }
        depth -= 1
      }
    }
    return undefined
  }

  /**
   * Scans an arithmetic expression starting after `((` or `$((`.
   * Returns undefined when the parens do not close as `))`, in which case
   * bash reads the text as a nested subshell instead.
   */
  private tryArithmetic (
    from: number
  ): { end: number, operand: Word } | undefined {
    let depth = 0
    for (let i = from; i < this.src.length; i++) {
      const c = this.src.charAt(i)
      if (c === '(') {
        depth += 1
      } else if (c === ')') {
        if (depth > 0) {
          depth -= 1
        } else if (this.src.charAt(i + 1) === ')') {
          const text = this.src.slice(from, i)
          const operand = new Parser(text, this.depth + 1).parseLoose()
          return { end: i + 2, operand }
        } else {
          return undefined
        }
      }
    }
    return undefined
  }

  private readBackticks (): WordPart {
    const start = this.pos
    this.pos += 1
    let inner = ''
    for (;;) {
      if (this.atEnd()) {
        this.pos = start
        this.fail('unterminated backtick')
      }
      const c = this.peek()
      if (c === '`') {
        this.pos += 1
        break
      }
      if (c === '\\' && '$`\\'.includes(this.src.charAt(this.pos + 1))) {
        inner += this.src.charAt(this.pos + 1)
        this.pos += 2
        continue
      }
      inner += c
      this.pos += 1
    }
    const script = new Parser(inner, this.depth + 1).parseProgram()
    return { kind: 'command-substitution', script }
  }

  private readProcessSubstitution (direction: '<' | '>'): WordPart {
    this.pos += 2
    const script = this.parseScript((p) => p.peek() === ')')
    this.expectChar(')')
    return { kind: 'process-substitution', direction, script }
  }

  /** `@(a|b)`, `!(x)`: bash extglob groups, kept as literal pattern text. */
  private readExtglob (word: WordBuilder): void {
    let depth = 0
    while (!this.atEnd()) {
      const c = this.peek()
      if (c === '\\') {
        this.readBackslash(word)
        continue
      }
      if (c === "'" || c === '"' || c === '$' || c === '`') {
        for (const part of this.readWordChunk().parts) {
          word.part(part)
        }
        continue
      }
      word.literal(c, false)
      this.pos += 1
      if (c === '(') {
        depth += 1
      } else if (c === ')') {
        depth -= 1
        if (depth === 0) {
          return
        }
      }
    }
    this.fail('unterminated extglob')
  }

  // Low-level scanning

  private nested<T> (fn: () => T): T {
    this.nesting += 1
    if (this.depth + this.nesting > MAX_DEPTH) {
      this.fail('nesting too deep')
    }
    try {
      return fn()
    } finally {
      this.nesting -= 1
    }
  }

  private skipBlanks (): void {
    while (!this.atEnd()) {
      const c = this.peek()
      if (BLANKS.has(c)) {
        this.pos += 1
      } else if (c === '\\' && this.src.charAt(this.pos + 1) === '\n') {
        this.pos += 2
      } else if (c === '#') {
        const newline = this.src.indexOf('\n', this.pos)
        this.pos = newline === -1 ? this.src.length : newline
      } else {
        return
      }
    }
  }

  private skipBlanksAndNewlines (): void {
    for (;;) {
      this.skipBlanks()
      if (this.peek() !== '\n') {
        return
      }
      this.consumeNewline()
    }
  }

  private consumeNewline (): void {
    this.pos += 1
    while (this.pending.length > 0) {
      const next = this.pending.shift()
      if (next !== undefined) {
        this.readHeredocBody(next)
      }
    }
  }

  private readHeredocBody (pending: PendingHeredoc): void {
    let body = ''
    while (!this.atEnd()) {
      const newline = this.src.indexOf('\n', this.pos)
      const lineEnd = newline === -1 ? this.src.length : newline
      const line = this.src.slice(this.pos, lineEnd)
      this.pos = newline === -1 ? this.src.length : newline + 1
      const compared = pending.stripTabs ? line.replace(/^\t+/, '') : line
      if (compared === pending.delimiter) {
        break
      }
      body += `${line}\n`
    }
    pending.heredoc.body = body
    if (pending.heredoc.expands) {
      pending.heredoc.operands = [
        new Parser(body, this.depth + 1).parseLoose()
      ]
    }
  }

  private atCommandEnd (): boolean {
    if (this.atEnd()) {
      return true
    }
    const c = this.peek()
    return c === '\n' || c === ';' || c === '&' || c === '|' || c === ')'
  }

  /** The next word if it is plain unquoted text, else ''. */
  peekReservedWord (): string {
    let end = this.pos
    while (end < this.src.length) {
      const c = this.src.charAt(end)
      if (METACHARACTERS.has(c)) {
        break
      }
      if ("'\"\\$`".includes(c)) {
        return ''
      }
      end += 1
    }
    return this.src.slice(this.pos, end)
  }

  private expectReserved (word: string): void {
    this.skipBlanksAndNewlines()
    if (this.peekReservedWord() !== word) {
      this.fail(`expected '${word}'`)
    }
    this.pos += word.length
  }

  private expectChar (c: string): void {
    if (this.peek() !== c) {
      this.fail(this.atEnd() ? `missing '${c}'` : `expected '${c}'`)
    }
    this.pos += 1
  }

  private isWordEnd (index: number): boolean {
    return index >= this.src.length ||
      METACHARACTERS.has(this.src.charAt(index))
  }

  startsWith (text: string): boolean {
    return this.src.startsWith(text, this.pos)
  }

  peek (): string {
    return this.src.charAt(this.pos)
  }

  private atEnd (): boolean {
    return this.pos >= this.src.length
  }

  private fail (message: string): never {
    throw new ShellParseError(message, this.pos)
  }
}

/** The word's text if it is entirely literal, else undefined. */
function literalText (word: Word): string | undefined {
  let text = ''
  for (const part of word.parts) {
    if (part.kind !== 'literal') {
      return undefined
    }
    text += part.value
  }
  return text
}

function heredocDelimiter (word: Word): string {
  return word.parts
    .map((part) => part.kind === 'literal' ? part.value : '')
    .join('')
}

/**
 * Parses a bash command line.
 *
 * @param source - The command as the bash tool would receive it.
 * @returns The syntax tree.
 * @throws {ShellParseError} For anything the parser does not understand.
 */
function parseShell (source: string): Script {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new ShellParseError('command too long', MAX_SOURCE_LENGTH)
  }
  try {
    return new Parser(source, 0).parseProgram()
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ShellParseError('nesting too deep', 0)
    }
    throw error
  }
}

export { literalText, parseShell, ShellParseError }
