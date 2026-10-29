import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Directories never walked (dependencies, build output, tool caches). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'build', 'dist', 'target', 'out', '.next',
  '__pycache__', '.tox', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
  'vendor', '.gradle', '.idea', '.vscode', '.bemol', 'env', 'coverage',
  '.nyc_output', '.cache'
])

/** Larger files are not parsed. */
const MAX_FILE_BYTES = 500 * 1024

/** At most this many files per walk. */
const MAX_WALK_FILES = 5000

interface WalkOptions {
  /** Keep a file? Called with its name. */
  readonly include: (fileName: string) => boolean
  readonly maxFiles?: number
}

/**
 * Lists source files under a directory, skipping hidden and generated
 * directories, symlinked directories and files over the size limit.
 *
 * @param root - The directory to walk.
 * @param options - Which files to keep and how many.
 * @returns Absolute file paths, depth-first.
 */
async function walkFiles (
  root: string,
  options: WalkOptions
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? MAX_WALK_FILES
  const found: string[] = []
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) {
        return
      }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await visit(path)
        }
      } else if (entry.isFile() && options.include(entry.name)) {
        const size = await stat(path).then((s) => s.size, () => Infinity)
        if (size <= MAX_FILE_BYTES) {
          found.push(path)
        }
      }
    }
  }
  await visit(root)
  return found
}

export { MAX_FILE_BYTES, MAX_WALK_FILES, SKIP_DIRS, walkFiles }
export type { WalkOptions }
