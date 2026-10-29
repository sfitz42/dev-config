/**
 * Syntax tree for the subset of bash that guardrails analyses.
 *
 * The tree only has to be good enough to find every command that may run and
 * every word that may name a file. Anything the parser cannot represent is a
 * parse error, and callers treat a parse error as "unknown, assume the worst".
 */

interface LiteralPart {
  readonly kind: 'literal'
  readonly value: string
  /** Quoted text is never subject to globbing, tilde or brace expansion. */
  readonly quoted: boolean
}

interface ParameterPart {
  readonly kind: 'parameter'
  /** Variable name (`HOME`, `1`, `@`); empty for `${!prefix*}` forms. */
  readonly name: string
  /** True for `${...}` forms that do more than read the variable. */
  readonly hasOperator: boolean
  /** Words inside the braces (`${x:-$(cmd)}`), for substitution walking. */
  readonly operands: readonly Word[]
}

interface CommandSubstitutionPart {
  readonly kind: 'command-substitution'
  readonly script: Script
}

interface ProcessSubstitutionPart {
  readonly kind: 'process-substitution'
  readonly direction: '<' | '>'
  readonly script: Script
}

interface ArithmeticPart {
  readonly kind: 'arithmetic'
  /** Substitutions found inside the expression. */
  readonly operands: readonly Word[]
}

type WordPart =
  | LiteralPart
  | ParameterPart
  | CommandSubstitutionPart
  | ProcessSubstitutionPart
  | ArithmeticPart

interface Word {
  readonly parts: readonly WordPart[]
}

interface Assignment {
  readonly name: string
  readonly value: Word | undefined
  /** Elements of `name=(a b c)`. */
  readonly elements: readonly Word[]
}

type RedirectOperator =
  | '<' | '>' | '>>' | '>|' | '<>' | '&>' | '&>>' | '>&' | '<&'
  | '<<' | '<<-' | '<<<'

interface Redirect {
  readonly operator: RedirectOperator
  /** Explicit file descriptor (`2>file`), if any. */
  readonly fd: number | undefined
  readonly target: Word
  /** For `<<` and `<<-`: the body and whether expansions run in it. */
  readonly heredoc: Heredoc | undefined
}

interface Heredoc {
  readonly body: string
  readonly expands: boolean
  /** Substitutions inside an expanding body; bash runs these. */
  readonly operands: readonly Word[]
}

interface SimpleCommand {
  readonly kind: 'simple'
  readonly assignments: readonly Assignment[]
  readonly words: readonly Word[]
  readonly redirects: readonly Redirect[]
  /** Source text of the command, for display and pattern matching. */
  readonly source: string
}

interface Pipeline {
  readonly kind: 'pipeline'
  readonly commands: readonly Command[]
  readonly negated: boolean
}

interface AndOr {
  readonly kind: 'and-or'
  readonly left: Command
  readonly operator: '&&' | '||'
  readonly right: Command
}

interface Subshell {
  readonly kind: 'subshell'
  readonly body: Script
  readonly redirects: readonly Redirect[]
}

interface Group {
  readonly kind: 'group'
  readonly body: Script
  readonly redirects: readonly Redirect[]
}

interface IfClause {
  readonly kind: 'if'
  readonly branches: readonly { condition: Script, body: Script }[]
  readonly otherwise: Script | undefined
  readonly redirects: readonly Redirect[]
}

interface LoopClause {
  readonly kind: 'loop'
  readonly until: boolean
  readonly condition: Script
  readonly body: Script
  readonly redirects: readonly Redirect[]
}

interface ForClause {
  readonly kind: 'for'
  readonly variable: string
  /** Undefined for `for x; do`, which iterates over "$@". */
  readonly items: readonly Word[] | undefined
  readonly body: Script
  readonly redirects: readonly Redirect[]
}

interface ArithmeticForClause {
  readonly kind: 'arithmetic-for'
  readonly operands: readonly Word[]
  readonly body: Script
  readonly redirects: readonly Redirect[]
}

interface CaseClause {
  readonly kind: 'case'
  readonly subject: Word
  readonly items: readonly { patterns: readonly Word[], body: Script }[]
  readonly redirects: readonly Redirect[]
}

interface FunctionDefinition {
  readonly kind: 'function'
  readonly name: string
  readonly body: Command
}

interface TestClause {
  readonly kind: 'test'
  readonly words: readonly Word[]
  readonly redirects: readonly Redirect[]
}

interface ArithmeticCommand {
  readonly kind: 'arithmetic-command'
  readonly operands: readonly Word[]
  readonly redirects: readonly Redirect[]
}

interface CoprocClause {
  readonly kind: 'coproc'
  readonly body: Command
}

type Command =
  | SimpleCommand
  | Pipeline
  | AndOr
  | Subshell
  | Group
  | IfClause
  | LoopClause
  | ForClause
  | ArithmeticForClause
  | CaseClause
  | FunctionDefinition
  | TestClause
  | ArithmeticCommand
  | CoprocClause

interface Statement {
  readonly command: Command
  readonly background: boolean
}

interface Script {
  readonly statements: readonly Statement[]
}

export type {
  AndOr,
  ArithmeticCommand,
  ArithmeticForClause,
  ArithmeticPart,
  Assignment,
  CaseClause,
  Command,
  CommandSubstitutionPart,
  CoprocClause,
  ForClause,
  FunctionDefinition,
  Group,
  Heredoc,
  IfClause,
  LiteralPart,
  LoopClause,
  ParameterPart,
  Pipeline,
  ProcessSubstitutionPart,
  Redirect,
  RedirectOperator,
  Script,
  SimpleCommand,
  Statement,
  Subshell,
  TestClause,
  Word,
  WordPart
}
