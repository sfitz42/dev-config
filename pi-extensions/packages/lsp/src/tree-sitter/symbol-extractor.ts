import type { Node, Tree } from 'web-tree-sitter'

/** LSP SymbolKind values used by the tree-sitter fallback. */
const SymbolKind = {
  Module: 2,
  Namespace: 3,
  Class: 5,
  Method: 6,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  Struct: 23
} as const

type SymbolKindValue = typeof SymbolKind[keyof typeof SymbolKind]

interface SymbolInfo {
  readonly name: string
  readonly kind: SymbolKindValue
  /** 1-indexed. */
  readonly line: number
  /** 1-indexed column of the name. */
  readonly column: number
  readonly endLine: number
  readonly children?: readonly SymbolInfo[]
}

interface Declaration {
  readonly kind: SymbolKindValue
  /** Look inside for nested declarations (class members, impl items). */
  readonly nested?: boolean
}

type DeclarationMap = Readonly<Record<string, Declaration>>

const TS_JS: DeclarationMap = {
  function_declaration: { kind: SymbolKind.Function },
  generator_function_declaration: { kind: SymbolKind.Function },
  class_declaration: { kind: SymbolKind.Class, nested: true },
  abstract_class_declaration: { kind: SymbolKind.Class, nested: true },
  interface_declaration: { kind: SymbolKind.Interface, nested: true },
  enum_declaration: { kind: SymbolKind.Enum },
  type_alias_declaration: { kind: SymbolKind.Variable },
  method_definition: { kind: SymbolKind.Method },
  abstract_method_signature: { kind: SymbolKind.Method },
  public_field_definition: { kind: SymbolKind.Field },
  lexical_declaration: { kind: SymbolKind.Variable },
  variable_declaration: { kind: SymbolKind.Variable }
}

const DECLARATIONS: Readonly<Record<string, DeclarationMap>> = {
  typescript: TS_JS,
  typescriptreact: TS_JS,
  javascript: TS_JS,
  javascriptreact: TS_JS,
  python: {
    function_definition: { kind: SymbolKind.Function },
    class_definition: { kind: SymbolKind.Class, nested: true },
    decorated_definition: { kind: SymbolKind.Function }
  },
  rust: {
    function_item: { kind: SymbolKind.Function },
    struct_item: { kind: SymbolKind.Struct },
    enum_item: { kind: SymbolKind.Enum },
    impl_item: { kind: SymbolKind.Class, nested: true },
    trait_item: { kind: SymbolKind.Interface, nested: true },
    mod_item: { kind: SymbolKind.Module, nested: true },
    type_item: { kind: SymbolKind.Variable },
    const_item: { kind: SymbolKind.Constant },
    static_item: { kind: SymbolKind.Constant },
    macro_definition: { kind: SymbolKind.Function }
  },
  go: {
    function_declaration: { kind: SymbolKind.Function },
    method_declaration: { kind: SymbolKind.Method },
    type_declaration: { kind: SymbolKind.Class },
    const_declaration: { kind: SymbolKind.Constant },
    var_declaration: { kind: SymbolKind.Variable }
  },
  java: {
    class_declaration: { kind: SymbolKind.Class, nested: true },
    interface_declaration: { kind: SymbolKind.Interface, nested: true },
    enum_declaration: { kind: SymbolKind.Enum, nested: true },
    record_declaration: { kind: SymbolKind.Class, nested: true },
    annotation_type_declaration: { kind: SymbolKind.Interface },
    method_declaration: { kind: SymbolKind.Method },
    constructor_declaration: { kind: SymbolKind.Constructor },
    field_declaration: { kind: SymbolKind.Field }
  },
  c: {
    function_definition: { kind: SymbolKind.Function },
    declaration: { kind: SymbolKind.Variable },
    struct_specifier: { kind: SymbolKind.Struct },
    enum_specifier: { kind: SymbolKind.Enum }
  },
  cpp: {
    function_definition: { kind: SymbolKind.Function },
    declaration: { kind: SymbolKind.Variable },
    struct_specifier: { kind: SymbolKind.Struct },
    enum_specifier: { kind: SymbolKind.Enum },
    class_specifier: { kind: SymbolKind.Class, nested: true },
    namespace_definition: { kind: SymbolKind.Namespace, nested: true }
  },
  ruby: {
    method: { kind: SymbolKind.Method },
    singleton_method: { kind: SymbolKind.Method },
    class: { kind: SymbolKind.Class, nested: true },
    module: { kind: SymbolKind.Module, nested: true }
  }
}

/** Node types treated as declarations by hover's fallback. */
const DECLARATION_TYPES = new Set([
  ...Object.values(DECLARATIONS).flatMap((map) => Object.keys(map)),
  'variable_declarator',
  'function_item',
  'type_spec'
])

/** Wrappers whose children are still top-level declarations. */
const TRANSPARENT = new Set(['export_statement', 'ambient_declaration'])

function firstChildOfType (
  node: Node,
  types: readonly string[]
): Node | undefined {
  return node.namedChildren.find((child) => types.includes(child.type))
}

/** The node that holds a declaration's name. */
function nameNode (node: Node): Node | undefined {
  const named = node.childForFieldName('name')
  if (named !== null) {
    return named
  }
  switch (node.type) {
    case 'lexical_declaration':
    case 'variable_declaration':
    case 'field_declaration': {
      return firstChildOfType(node, ['variable_declarator'])
        ?.childForFieldName('name') ?? undefined
    }
    case 'decorated_definition': {
      return firstChildOfType(node,
        ['function_definition', 'class_definition'])
        ?.childForFieldName('name') ?? undefined
    }
    case 'type_declaration':
      return firstChildOfType(node, ['type_spec'])
        ?.childForFieldName('name') ?? undefined
    case 'const_declaration':
    case 'var_declaration':
      return firstChildOfType(node, ['const_spec', 'var_spec'])
        ?.childForFieldName('name') ?? undefined
    case 'declaration': {
      const declarator = firstChildOfType(node,
        ['init_declarator', 'function_declarator'])
      return declarator?.childForFieldName('declarator') ??
        declarator?.childForFieldName('name') ?? undefined
    }
    default:
      return undefined
  }
}

function declarationName (
  node: Node
): { text: string, column: number } | undefined {
  if (node.type === 'impl_item') {
    const type = node.childForFieldName('type')
    return type === null
      ? undefined
      : { text: `impl ${type.text}`, column: type.startPosition.column + 1 }
  }
  const name = nameNode(node)
  if (name !== undefined) {
    return { text: name.text, column: name.startPosition.column + 1 }
  }
  const first = node.firstNamedChild
  return first !== null && first.text.length < 60 && !first.text.includes('\n')
    ? { text: first.text, column: first.startPosition.column + 1 }
    : undefined
}

function collect (
  node: Node,
  map: DeclarationMap,
  nested: boolean
): SymbolInfo[] {
  const symbols: SymbolInfo[] = []
  for (const child of node.namedChildren) {
    const declaration = map[child.type]
    if (declaration !== undefined) {
      const name = declarationName(child)
      if (name !== undefined) {
        const children = declaration.nested === true
          ? collect(child, map, true)
          : []
        symbols.push({
          name: name.text,
          kind: declaration.kind,
          line: child.startPosition.row + 1,
          column: name.column,
          endLine: child.endPosition.row + 1,
          ...(children.length > 0 ? { children } : {})
        })
      }
    } else if (TRANSPARENT.has(child.type) ||
      (nested && child.namedChildCount > 0)) {
      // Export wrappers at the top level; bodies (class_body, block, ...)
      // inside a declaration that nests.
      symbols.push(...collect(child, map, nested))
    }
  }
  return symbols
}

function collectGeneric (tree: Tree): SymbolInfo[] {
  const symbols: SymbolInfo[] = []
  for (const child of tree.rootNode.namedChildren) {
    const isFunction = /function|method/.test(child.type)
    const isClass = /class|struct/.test(child.type)
    const name = child.childForFieldName('name')
    if ((isFunction || isClass) && name !== null) {
      symbols.push({
        name: name.text,
        kind: isFunction ? SymbolKind.Function : SymbolKind.Class,
        line: child.startPosition.row + 1,
        column: name.startPosition.column + 1,
        endLine: child.endPosition.row + 1
      })
    }
  }
  return symbols
}

/**
 * Extracts declarations from a tree, nesting class and module members.
 *
 * @param tree - The parsed file.
 * @param languageId - Selects the declaration node types.
 * @returns Symbols in source order.
 */
function extractSymbols (tree: Tree, languageId: string): SymbolInfo[] {
  const map = DECLARATIONS[languageId]
  return map === undefined
    ? collectGeneric(tree)
    : collect(tree.rootNode, map, false)
}

/**
 * Flattens a symbol tree, parents before children.
 *
 * @param symbols - Nested symbols.
 * @returns Every symbol with its parent's name.
 */
function flattenSymbols (
  symbols: readonly SymbolInfo[],
  parent?: string
): Array<SymbolInfo & { readonly parent?: string }> {
  return symbols.flatMap((symbol) => [
    { ...symbol, ...(parent === undefined ? {} : { parent }) },
    ...flattenSymbols(symbol.children ?? [], symbol.name)
  ])
}

/**
 * Finds declarations with an exact name.
 *
 * @param tree - The parsed file.
 * @param name - The symbol name.
 * @param languageId - The file's language.
 * @returns Matching declarations, outermost first.
 */
function findDefinitions (
  tree: Tree,
  name: string,
  languageId: string
): SymbolInfo[] {
  return flattenSymbols(extractSymbols(tree, languageId))
    .filter((symbol) => symbol.name === name)
}

interface SyntaxIssue {
  /** 0-indexed. */
  readonly line: number
  readonly character: number
  readonly message: string
}

/**
 * Collects ERROR and MISSING nodes as syntax errors.
 *
 * @param tree - The parsed file.
 * @returns Errors in source order.
 */
function syntaxErrors (tree: Tree): SyntaxIssue[] {
  const errors: SyntaxIssue[] = []
  const visit = (node: Node): void => {
    const position = {
      line: node.startPosition.row,
      character: node.startPosition.column
    }
    if (node.isError) {
      const text = node.text.length > 50
        ? `${node.text.slice(0, 50)}...`
        : node.text
      errors.push({ ...position, message: `Syntax error: unexpected "${text}"` })
    } else if (node.isMissing) {
      errors.push({ ...position, message: `Missing ${node.type}` })
    } else if (node.hasError) {
      for (const child of node.children) {
        visit(child)
      }
    }
  }
  visit(tree.rootNode)
  return errors
}

/**
 * The smallest named node at a position.
 *
 * @param tree - The parsed file.
 * @param line - 0-indexed row.
 * @param character - 0-indexed column.
 */
function nodeAt (
  tree: Tree,
  line: number,
  character: number
): Node | undefined {
  return tree.rootNode.namedDescendantForPosition(
    { row: line, column: character }) ?? undefined
}

/**
 * The nearest declaration enclosing a position.
 *
 * @param tree - The parsed file.
 * @param line - 0-indexed row.
 * @param character - 0-indexed column.
 */
function enclosingDeclaration (
  tree: Tree,
  line: number,
  character: number
): Node | undefined {
  let node: Node | null = nodeAt(tree, line, character) ?? null
  while (node !== null) {
    if (DECLARATION_TYPES.has(node.type)) {
      return node
    }
    node = node.parent
  }
  return undefined
}

/**
 * A declaration's first line, without a trailing `{` or `:`.
 *
 * @param node - A declaration node.
 */
function signatureText (node: Node): string {
  const [first = ''] = node.text.split('\n')
  return first.replace(/\s*[{:]\s*$/, '').trim()
}

export {
  enclosingDeclaration,
  extractSymbols,
  findDefinitions,
  flattenSymbols,
  nodeAt,
  signatureText,
  SymbolKind,
  syntaxErrors
}
export type { SymbolInfo, SymbolKindValue, SyntaxIssue }
