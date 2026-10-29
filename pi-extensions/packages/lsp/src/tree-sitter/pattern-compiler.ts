import type { Node, Tree } from 'web-tree-sitter'

import type { TreeSitterManager } from './parser-manager.ts'

/** Matches a node of the same type: by text (leaf) or by children. */
interface LiteralPattern {
  readonly kind: 'literal'
  readonly nodeType: string
  readonly text?: string
  readonly children: readonly PatternNode[]
  readonly field?: string
}

/** `$NAME`: any single node; repeated names must match the same text. */
interface MetavarPattern {
  readonly kind: 'metavar'
  readonly name: string
  readonly field?: string
}

/** `$$$NAME` or `$$$`: zero or more consecutive sibling nodes. */
interface VariadicPattern {
  readonly kind: 'variadic'
  /** Empty for an anonymous `$$$`. */
  readonly name: string
  readonly field?: string
}

type PatternNode = LiteralPattern | MetavarPattern | VariadicPattern

interface CompiledPattern {
  readonly root: PatternNode
  /** Named metavariables, in first-use order. */
  readonly metavars: readonly string[]
  readonly languageId: string
}

interface Placeholder {
  readonly kind: 'metavar' | 'variadic'
  readonly name: string
}

interface Wrapper {
  readonly prefix: string
  readonly suffix: string
}

/** `$$$NAME`, `$$$` or `$NAME`, where NAME is upper case. */
const METAVAR_SOURCE = /\$\$\$([A-Z_][A-Z0-9_]*)?|\$([A-Z_][A-Z0-9_]*)/g

const NO_WRAP: Wrapper = { prefix: '', suffix: '' }

/** Contexts that turn a fragment into a parseable program, per language. */
function wrappersFor (languageId: string): readonly Wrapper[] {
  switch (languageId) {
    case 'python':
      return [NO_WRAP, { prefix: '(', suffix: ')' },
        { prefix: 'def _():\n  ', suffix: '\n' }]
    case 'rust':
      return [NO_WRAP, { prefix: 'fn _() { ', suffix: '; }' },
        { prefix: 'fn _() { ', suffix: ' }' }]
    case 'go':
      return [NO_WRAP, { prefix: 'package _\nfunc _() { ', suffix: ' }' }]
    case 'java':
      return [NO_WRAP, { prefix: 'class _ { void _() { ', suffix: '; } }' },
        { prefix: 'class _ { ', suffix: ' }' }]
    default:
      return [NO_WRAP, { prefix: '', suffix: ';' },
        { prefix: '(', suffix: ')' },
        { prefix: 'function _() { ', suffix: ' }' }]
  }
}

/**
 * Replaces metavariables with identifiers that are valid in every
 * supported language, so the pattern parses as ordinary code.
 */
function encodeMetavars (source: string): {
  readonly encoded: string
  readonly placeholders: ReadonlyMap<string, Placeholder>
} {
  const placeholders = new Map<string, Placeholder>()
  const encoded = source.replace(METAVAR_SOURCE,
    (match: string, variadic?: string, single?: string) => {
      const isVariadic = match.startsWith('$$$')
      const name = (isVariadic ? variadic : single) ?? ''
      const placeholder = isVariadic
        ? `__PI_VARIADIC_${name === '' ? 'ANON' : name}__`
        : `__PI_META_${name}__`
      placeholders.set(placeholder,
        { kind: isVariadic ? 'variadic' : 'metavar', name })
      return placeholder
    })
  return { encoded, placeholders }
}

function hasErrors (node: Node): boolean {
  return node.hasError || node.isMissing
}

/** Statement and grouping wrappers that a fragment unwraps through. */
const UNWRAP_TYPES = new Set([
  'expression_statement', 'parenthesized_expression', 'program', 'module',
  'source_file', 'translation_unit'
])

/**
 * The node standing for the fragment between `start` and `end`: the
 * largest node spanning exactly that range, unwrapped through statement
 * and parenthesis wrappers.
 */
function fragmentNode (
  tree: Tree,
  start: number,
  end: number
): Node | undefined {
  let node = tree.rootNode.namedDescendantForIndex(start, end)
  if (node === null || node.startIndex !== start || node.endIndex < end) {
    return undefined
  }
  while (node.parent !== null && node.parent.startIndex === start &&
    node.parent.endIndex <= end + 1 && !UNWRAP_TYPES.has(node.parent.type)) {
    node = node.parent
  }
  while (UNWRAP_TYPES.has(node.type) && node.namedChildCount === 1) {
    const only: Node | null = node.firstNamedChild
    if (only === null) {
      break
    }
    node = only
  }
  return node
}

function withField<T extends PatternNode> (
  pattern: T,
  field: string | undefined
): T {
  return field === undefined ? pattern : { ...pattern, field }
}

function buildPattern (
  node: Node,
  placeholders: ReadonlyMap<string, Placeholder>,
  metavars: string[],
  field: string | undefined
): PatternNode {
  // A placeholder is a leaf, or the only child of a statement wrapper
  // (`$X;`). Other single-child nodes keep their shape: `foo($A)` must
  // capture the argument, not `(x)` with its parentheses.
  const leaf = node.namedChildCount === 0
    ? node
    : node.namedChildCount === 1 && node.type === 'expression_statement'
      ? node.firstNamedChild
      : null
  const placeholder = leaf !== null && leaf.namedChildCount === 0
    ? placeholders.get(leaf.text)
    : undefined
  if (placeholder !== undefined) {
    if (placeholder.name !== '') {
      metavars.push(placeholder.name)
    }
    return withField({ kind: placeholder.kind, name: placeholder.name }, field)
  }

  if (node.namedChildCount === 0) {
    return withField({
      kind: 'literal',
      nodeType: node.type,
      text: node.text,
      children: []
    }, field)
  }

  const children: PatternNode[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child === null || child.isExtra) {
      continue
    }
    const childField = node.fieldNameForChild(i) ?? undefined
    if (child.isNamed) {
      children.push(buildPattern(child, placeholders, metavars, childField))
    } else if (childField !== undefined) {
      // Anonymous tokens in a field are operators: `a + b` must not match
      // `a - b`.
      children.push({
        kind: 'literal',
        nodeType: child.type,
        text: child.text,
        children: [],
        field: childField
      })
    }
  }
  return withField({ kind: 'literal', nodeType: node.type, children }, field)
}

/**
 * Compiles a structural pattern such as `console.log($ARG)` for one
 * language.
 *
 * @param source - The pattern, with `$NAME` and `$$$NAME` metavariables.
 * @param languageId - The language to parse it as.
 * @param treeSitter - The parser manager.
 * @returns The compiled pattern.
 * @throws When no wrapper makes the pattern parse without errors.
 */
async function compilePattern (
  source: string,
  languageId: string,
  treeSitter: TreeSitterManager
): Promise<CompiledPattern> {
  if (!treeSitter.hasGrammar(languageId)) {
    throw new Error(`No tree-sitter grammar for ${languageId}. Supported: ` +
      treeSitter.supportedLanguages().join(', '))
  }
  const { encoded, placeholders } = encodeMetavars(source.trim())
  for (const wrapper of wrappersFor(languageId)) {
    const program = wrapper.prefix + encoded + wrapper.suffix
    const tree = await treeSitter.parseAs(undefined, program, languageId)
    if (tree === undefined) {
      continue
    }
    try {
      if (hasErrors(tree.rootNode)) {
        continue
      }
      const start = wrapper.prefix.length
      const node = fragmentNode(tree, start, start + encoded.length)
      if (node === undefined) {
        continue
      }
      const metavars: string[] = []
      const root = buildPattern(node, placeholders, metavars, undefined)
      return { root, metavars: [...new Set(metavars)], languageId }
    } finally {
      tree.delete()
    }
  }
  throw new Error(`Failed to parse the pattern as ${languageId}. It may ` +
    'have a syntax error or not be a complete code fragment.')
}

export { compilePattern, encodeMetavars, METAVAR_SOURCE }
export type {
  CompiledPattern,
  LiteralPattern,
  MetavarPattern,
  PatternNode,
  VariadicPattern
}
