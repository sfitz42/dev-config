/** Untracked files larger than this are left out of snapshots (10 MiB). */
const MAX_UNTRACKED_FILE_BYTES = 10 * 1024 * 1024

/** A directory with this many untracked files is left out of snapshots. */
const MAX_UNTRACKED_DIR_FILES = 200

/** Any path with one of these components is never snapshotted or removed. */
const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.venv',
  'venv',
  'env',
  '.env',
  'dist',
  'build',
  '.pytest_cache',
  '.mypy_cache',
  '.cache',
  '.tox',
  '__pycache__'
])

interface StatusEntries {
  /** Tracked paths with any change, including both sides of a rename. */
  readonly changedTracked: readonly string[]
  /** Untracked, non-ignored paths. */
  readonly untracked: readonly string[]
}

function isIgnoredPath (path: string): boolean {
  return path.split('/').some((part) => IGNORED_DIR_NAMES.has(part))
}

function isWithin (path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

function isWithinAny (path: string, dirs: Iterable<string>): boolean {
  for (const dir of dirs) {
    if (isWithin(path, dir)) {
      return true
    }
  }
  return false
}

/** Returns the text after the `count`-th space, or undefined. */
function afterSpaces (record: string, count: number): string | undefined {
  let index = -1
  for (let seen = 0; seen < count; seen += 1) {
    index = record.indexOf(' ', index + 1)
    if (index === -1) {
      return undefined
    }
  }
  const rest = record.slice(index + 1)
  return rest === '' ? undefined : rest
}

/**
 * Parses `git status --porcelain=2 -z --untracked-files=all`.
 *
 * With `-z`, paths are raw (never quoted) and NUL-separated, so names
 * containing spaces, quotes or newlines come through intact.
 *
 * @param records - The output split on NUL.
 * @returns Changed tracked paths and untracked paths.
 */
function parsePorcelainV2 (records: readonly string[]): StatusEntries {
  const changedTracked: string[] = []
  const untracked: string[] = []
  // Ordinary, rename/copy and unmerged records keep the path after a fixed
  // number of fields.
  const pathField: Readonly<Record<string, number>> = { 1: 8, 2: 9, u: 10 }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    const kind = record[0] ?? ''
    if (kind === '?') {
      untracked.push(record.slice(2))
      continue
    }
    const field = pathField[kind]
    if (field === undefined) {
      continue
    }
    const path = afterSpaces(record, field)
    if (path !== undefined) {
      changedTracked.push(path)
    }
    if (kind === '2') {
      // A rename is followed by its original path as its own record.
      index += 1
      const original = records[index]
      if (original !== undefined && original !== '') {
        changedTracked.push(original)
      }
    }
  }
  return { changedTracked, untracked }
}

/**
 * Finds directories holding at least `threshold` of the given files
 * directly (bucketed by each file's parent directory).
 *
 * @param files - Repository-relative file paths.
 * @param threshold - Minimum file count.
 * @returns The crowded directories, most files first. The root is never
 *   returned.
 */
function findCrowdedDirs (
  files: readonly string[],
  threshold: number = MAX_UNTRACKED_DIR_FILES
): string[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const slash = file.lastIndexOf('/')
    if (slash === -1) {
      continue
    }
    const dir = file.slice(0, slash)
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dir]) => dir)
}

export {
  findCrowdedDirs,
  IGNORED_DIR_NAMES,
  isIgnoredPath,
  isWithin,
  isWithinAny,
  MAX_UNTRACKED_DIR_FILES,
  MAX_UNTRACKED_FILE_BYTES,
  parsePorcelainV2
}
export type { StatusEntries }
