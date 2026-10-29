import type {
  Assignment,
  Command,
  Redirect,
  Script,
  SimpleCommand,
  Word
} from './shell-ast.ts'

interface CommandVisit {
  /** The simple command, or undefined for a compound command's redirects. */
  readonly command: SimpleCommand | undefined
  readonly redirects: readonly Redirect[]
  /** True inside `$(...)`, backticks or `<(...)`: output feeds a word. */
  readonly inSubstitution: boolean
}

type CommandVisitor = (visit: CommandVisit) => void

/**
 * Visits every simple command bash may run, in source order, including
 * commands inside substitutions anywhere in a word: arguments, assignments,
 * redirect targets, expanding heredoc bodies, `${x:-$(cmd)}` operands,
 * arithmetic, test clauses, `for` lists and `case` patterns.
 *
 * Function bodies are visited where they are defined, since a later call
 * may run them.
 *
 * @param script - The parsed script.
 * @param visitor - Called once per simple command, and once per compound
 *   command that carries its own redirects.
 */
function walkCommands (script: Script, visitor: CommandVisitor): void {
  walkScript(script, visitor, false)
}

function walkScript (
  script: Script,
  visitor: CommandVisitor,
  inSubstitution: boolean
): void {
  for (const statement of script.statements) {
    walkCommand(statement.command, visitor, inSubstitution)
  }
}

function walkCommand (
  command: Command,
  visitor: CommandVisitor,
  inSubstitution: boolean
): void {
  const words = (items: readonly Word[]): void => {
    for (const word of items) {
      walkWord(word, visitor)
    }
  }
  const redirects = (items: readonly Redirect[]): void => {
    if (items.length > 0) {
      visitor({ command: undefined, redirects: items, inSubstitution })
    }
    walkRedirects(items, visitor)
  }
  const script = (body: Script): void => {
    walkScript(body, visitor, inSubstitution)
  }

  switch (command.kind) {
    case 'simple':
      visitor({ command, redirects: command.redirects, inSubstitution })
      walkAssignments(command.assignments, visitor)
      words(command.words)
      walkRedirects(command.redirects, visitor)
      return
    case 'pipeline':
      for (const item of command.commands) {
        walkCommand(item, visitor, inSubstitution)
      }
      return
    case 'and-or':
      walkCommand(command.left, visitor, inSubstitution)
      walkCommand(command.right, visitor, inSubstitution)
      return
    case 'subshell':
    case 'group':
      redirects(command.redirects)
      script(command.body)
      return
    case 'if':
      redirects(command.redirects)
      for (const branch of command.branches) {
        script(branch.condition)
        script(branch.body)
      }
      if (command.otherwise !== undefined) {
        script(command.otherwise)
      }
      return
    case 'loop':
      redirects(command.redirects)
      script(command.condition)
      script(command.body)
      return
    case 'for':
      redirects(command.redirects)
      words(command.items ?? [])
      script(command.body)
      return
    case 'arithmetic-for':
      redirects(command.redirects)
      words(command.operands)
      script(command.body)
      return
    case 'case':
      redirects(command.redirects)
      walkWord(command.subject, visitor)
      for (const item of command.items) {
        words(item.patterns)
        script(item.body)
      }
      return
    case 'function':
      walkCommand(command.body, visitor, inSubstitution)
      return
    case 'test':
      redirects(command.redirects)
      words(command.words)
      return
    case 'arithmetic-command':
      redirects(command.redirects)
      words(command.operands)
      return
    case 'coproc':
      walkCommand(command.body, visitor, inSubstitution)
  }
}

function walkAssignments (
  assignments: readonly Assignment[],
  visitor: CommandVisitor
): void {
  for (const assignment of assignments) {
    if (assignment.value !== undefined) {
      walkWord(assignment.value, visitor)
    }
    for (const element of assignment.elements) {
      walkWord(element, visitor)
    }
  }
}

function walkRedirects (
  redirects: readonly Redirect[],
  visitor: CommandVisitor
): void {
  for (const redirect of redirects) {
    if (redirect.heredoc === undefined) {
      walkWord(redirect.target, visitor)
    } else {
      for (const operand of redirect.heredoc.operands) {
        walkWord(operand, visitor)
      }
    }
  }
}

function walkWord (word: Word, visitor: CommandVisitor): void {
  for (const part of word.parts) {
    switch (part.kind) {
      case 'command-substitution':
      case 'process-substitution':
        walkScript(part.script, visitor, true)
        break
      case 'parameter':
      case 'arithmetic':
        for (const operand of part.operands) {
          walkWord(operand, visitor)
        }
        break
      case 'literal':
        break
    }
  }
}

/**
 * Collects variables assigned a fully known value anywhere in the script,
 * in source order (`X=1`, `export X=1`, `declare X=1`, `local X=1`).
 * Control flow is ignored, so a name assigned twice keeps every value seen.
 *
 * @param script - The parsed script.
 * @param literal - Evaluates a word to text, or undefined if not static.
 * @returns Each name with all of its static values.
 */
function collectAssignments (
  script: Script,
  literal: (word: Word) => string | undefined
): Map<string, string[]> {
  const values = new Map<string, string[]>()
  const record = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      return
    }
    values.set(name, [...(values.get(name) ?? []), value])
  }
  const declarations = new Set([
    'export', 'declare', 'typeset', 'local', 'readonly'
  ])

  walkCommands(script, ({ command }) => {
    if (command === undefined) {
      return
    }
    for (const assignment of command.assignments) {
      if (assignment.value !== undefined) {
        record(assignment.name, literal(assignment.value))
      }
    }
    const [name, ...args] = command.words.map(literal)
    if (name === undefined || !declarations.has(name)) {
      return
    }
    for (const arg of args) {
      const match = arg === undefined
        ? null
        : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg)
      if (match?.[1] !== undefined && match[2] !== undefined) {
        // Bash expands a leading `~` in `export NAME=~/x`, like `NAME=~/x`.
        record(match[1], literal({
          parts: [{ kind: 'literal', value: match[2], quoted: false }]
        }))
      }
    }
  })
  return values
}

export { collectAssignments, walkCommands }
export type { CommandVisit, CommandVisitor }
