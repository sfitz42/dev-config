import type { Node } from 'web-tree-sitter'

import type { LiteralPattern, PatternNode } from './pattern-compiler.ts'

type Captures = Record<string, string>

interface StructuralMatch {
  readonly node: Node
  readonly captures: Readonly<Captures>
}

interface Child {
  readonly node: Node
  readonly field: string | undefined
}

/** Named children plus anonymous children that sit in a field. */
function childrenOf (node: Node): Child[] {
  const children: Child[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    const field = node.fieldNameForChild(i) ?? undefined
    if (child !== null && (child.isNamed || field !== undefined)) {
      children.push({ node: child, field })
    }
  }
  return children
}

/** Binds a capture, or checks it against an earlier binding. */
function bind (captures: Captures, name: string, text: string): boolean {
  if (name === '') {
    return true
  }
  if (Object.hasOwn(captures, name)) {
    return captures[name] === text
  }
  captures[name] = text
  return true
}

/** The source between the first and last node, separators included. */
function spanText (source: string, nodes: readonly Node[]): string {
  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  return first === undefined || last === undefined
    ? ''
    : source.slice(first.startIndex, last.endIndex)
}

function matchSequence (
  targets: readonly Node[],
  patterns: readonly PatternNode[],
  source: string,
  captures: Captures
): boolean {
  const [pattern, ...rest] = patterns
  if (pattern === undefined) {
    // Every positional child must be accounted for: `foo($A)` must not
    // match `foo(a, b)`, or a rewrite would drop `b`.
    return targets.length === 0
  }
  if (pattern.kind === 'variadic') {
    // A trailing variadic takes everything left; otherwise try the
    // shortest run first.
    const first = rest.length === 0 ? targets.length : 0
    for (let take = first; take <= targets.length; take++) {
      const attempt = { ...captures }
      const text = spanText(source, targets.slice(0, take))
      if (bind(attempt, pattern.name, text) &&
        matchSequence(targets.slice(take), rest, source, attempt)) {
        Object.assign(captures, attempt)
        return true
      }
    }
    return false
  }
  const [target, ...others] = targets
  if (target === undefined) {
    return false
  }
  const attempt = { ...captures }
  if (matchNode(target, pattern, source, attempt) &&
    matchSequence(others, rest, source, attempt)) {
    Object.assign(captures, attempt)
    return true
  }
  return false
}

function matchLiteral (
  target: Node,
  pattern: LiteralPattern,
  source: string,
  captures: Captures
): boolean {
  if (target.type !== pattern.nodeType) {
    return false
  }
  if (pattern.text !== undefined) {
    return target.text === pattern.text
  }
  // Pattern children with a field match the target's child in that field;
  // fields the pattern does not mention are ignored. Children without a
  // field match the pattern's positional children in order, exactly.
  const children = childrenOf(target)
  const positional: PatternNode[] = []
  for (const child of pattern.children) {
    if (child.field === undefined) {
      positional.push(child)
      continue
    }
    if (child.kind === 'variadic') {
      const nodes = children.filter((c) => c.field === child.field)
        .map((c) => c.node)
      if (!bind(captures, child.name, spanText(source, nodes))) {
        return false
      }
    } else {
      const inField = children.find((c) => c.field === child.field)
      if (inField === undefined ||
        !matchNode(inField.node, child, source, captures)) {
        return false
      }
    }
  }
  const unfielded = children
    .filter((c) => c.field === undefined && c.node.isNamed &&
      !c.node.isExtra)
    .map((c) => c.node)
  return matchSequence(unfielded, positional, source, captures)
}

function matchNode (
  target: Node,
  pattern: PatternNode,
  source: string,
  captures: Captures
): boolean {
  switch (pattern.kind) {
    case 'metavar':
      return bind(captures, pattern.name, target.text)
    case 'variadic':
      return bind(captures, pattern.name, target.text)
    case 'literal':
      return matchLiteral(target, pattern, source, captures)
  }
}

/**
 * Finds non-overlapping matches, outermost first, walking depth-first.
 *
 * @param root - The tree to search.
 * @param pattern - The compiled pattern root.
 * @param source - The text the tree was parsed from.
 * @returns Matches in source order with their captures.
 */
function findMatches (
  root: Node,
  pattern: PatternNode,
  source: string
): StructuralMatch[] {
  const matches: StructuralMatch[] = []
  const visit = (node: Node): void => {
    const captures: Captures = {}
    if (matchNode(node, pattern, source, captures)) {
      matches.push({ node, captures })
      return
    }
    for (const child of node.namedChildren) {
      visit(child)
    }
  }
  visit(root)
  return matches
}

export { findMatches }
export type { StructuralMatch }
