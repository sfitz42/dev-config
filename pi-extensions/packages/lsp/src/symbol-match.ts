/** A named position a symbol query can resolve to (1-indexed). */
interface SymbolCandidate {
  readonly name: string
  readonly line: number
  readonly character: number
  readonly parent?: string
}

interface SymbolMatch {
  readonly name: string
  readonly line: number
  readonly character: number
}

function matchByPriority (
  candidates: readonly SymbolCandidate[],
  query: string
): SymbolMatch | undefined {
  const lower = query.toLowerCase()
  const found = candidates.find((c) => c.name === query) ??
    candidates.find((c) => c.name.toLowerCase() === lower) ??
    candidates.find((c) => c.name.toLowerCase().includes(lower))
  if (found === undefined) {
    return undefined
  }
  return { name: found.name, line: found.line, character: found.character }
}

/**
 * Finds the symbol a query names. Tries an exact match, then a
 * case-insensitive match, then a substring match. `Parent.child` queries
 * first look among children of `Parent`, then fall back to `child`
 * anywhere.
 *
 * @param candidates - Symbols in document order, parents before children.
 * @param query - A symbol name, optionally dot-qualified.
 * @returns The best match, or undefined.
 */
function matchSymbol (
  candidates: readonly SymbolCandidate[],
  query: string
): SymbolMatch | undefined {
  const dot = query.lastIndexOf('.')
  if (dot <= 0) {
    return matchByPriority(candidates, query)
  }
  const parent = query.slice(0, dot).toLowerCase()
  const name = query.slice(dot + 1)
  const scoped = candidates.filter((c) => c.parent?.toLowerCase() === parent)
  return matchByPriority(scoped, name) ?? matchByPriority(candidates, name)
}

export { matchSymbol }
export type { SymbolCandidate, SymbolMatch }
