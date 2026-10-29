import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** A path grant: `file` matches exactly, `directory` matches its tree. */
interface AllowedPath {
  readonly kind: 'file' | 'directory'
  readonly path: string
}

/**
 * Expands a leading `~` or `~/` to the home directory.
 *
 * @param input - A path as typed.
 * @param home - Home directory; defaults to the current user's.
 * @returns The expanded path, or the input unchanged.
 */
function expandHome (input: string, home = homedir()): string {
  if (input === '~') {
    return home
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(home, input.slice(2))
  }
  return input
}

function resolveFromCwd (input: string, cwd: string, home = homedir()): string {
  return resolve(cwd, expandHome(input, home))
}

/**
 * Lexical containment: `target` is `root` or below it. Both must be
 * absolute and normalised; symlinks are not followed here, see
 * {@link realPathOf}.
 */
function isWithin (target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') &&
      !rel.startsWith('..\\'))
}

/**
 * Resolves symlinks in an absolute path. For a path that does not exist,
 * resolves its nearest existing ancestor and keeps the rest, so a write
 * through a symlinked directory is still seen at its real location.
 *
 * @param absolutePath - An absolute path.
 * @returns The real path, or undefined when nothing on it can be resolved.
 */
function realPathOf (absolutePath: string): string | undefined {
  let current = absolutePath
  const rest: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return rest.length === 0 ? real : join(real, ...rest.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return undefined
      }
      rest.push(basename(current))
      current = parent
    }
  }
}

/** The path itself and, when different, its symlink-resolved form. */
function pathForms (absolutePath: string): string[] {
  const real = realPathOf(absolutePath)
  return real === undefined || real === absolutePath
    ? [absolutePath]
    : [absolutePath, real]
}

/**
 * Formats a path for display: relative inside `cwd`, `~/...` under home,
 * absolute otherwise.
 */
function displayPath (
  absolutePath: string,
  cwd: string,
  home = homedir()
): string {
  if (isWithin(absolutePath, cwd)) {
    return relative(cwd, absolutePath) || '.'
  }
  if (isWithin(absolutePath, home)) {
    return `~${absolutePath.slice(home.length)}`.replaceAll('\\', '/')
  }
  return absolutePath
}

/**
 * Builds the stored form of a grant: `~/` for home paths, forward slashes,
 * no trailing slash.
 */
function toStorageGrant (
  absolutePath: string,
  isDirectory: boolean,
  home = homedir()
): AllowedPath {
  let path = isWithin(absolutePath, home) && absolutePath !== home
    ? `~${absolutePath.slice(home.length)}`
    : absolutePath === home ? '~' : absolutePath
  path = path.replaceAll('\\', '/').replace(/(?<=.)\/+$/, '')
  return { kind: isDirectory ? 'directory' : 'file', path }
}

/**
 * Whether a token looks like a filesystem path: it has a separator, a
 * drive prefix, or starts with `~/`, `./` or `../`. Bare names such as
 * `Makefile` are cwd-relative and cannot leave the workspace.
 */
function maybePathLike (token: string): boolean {
  return token.includes('/') || token.includes('\\') ||
    /^[A-Za-z]:[\\/]/.test(token) || token === '..' || token === '~'
}

/** Whether granting this directory would open the whole disk or home. */
function isGrantTooBroad (absolutePath: string, home = homedir()): boolean {
  const normalized = absolutePath.replace(/[\\/]+$/, '')
  return normalized === '' || /^[A-Za-z]:$/.test(normalized) ||
    normalized === home.replace(/[\\/]+$/, '')
}

export {
  displayPath,
  expandHome,
  isGrantTooBroad,
  isWithin,
  maybePathLike,
  pathForms,
  realPathOf,
  resolveFromCwd,
  toStorageGrant
}
export type { AllowedPath }
