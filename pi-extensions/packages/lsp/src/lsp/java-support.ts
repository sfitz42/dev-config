import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

/**
 * jdtls's own default import exclusions, then generated directories.
 * `build/` and `bin/` are left out: jdtls matches these globs against
 * absolute paths, so they would hide every project under such a directory.
 */
const JAVA_IMPORT_EXCLUSIONS: readonly string[] = [
  '**/node_modules/**',
  '**/.metadata/**',
  '**/archetype-resources/**',
  '**/META-INF/maven/**',
  '**/.bemol/**',
  '**/.gradle/**'
]

const LOG_TAIL_BYTES = 32 * 1024
const ROTATED_LOG_PREFIX = '.log.pi-lsp-recovered-'
const ROTATED_LOGS_KEPT = 3
const CRASH_SIGNATURE = new RegExp(
  'ObjectNotFoundException|Could not (?:read|restore) workspace tree|' +
  'Exception in org\\.eclipse\\.core\\.resources\\.ResourcesPlugin\\.start'
)

type Notify = (message: string, level: 'info' | 'warning') => void

/**
 * The jdtls workspace data directory, located the way jdtls's launcher
 * does: `<cache dir>/jdtls/jdtls-<sha1(basename(cwd))>`.
 *
 * @param cwd - The workspace directory.
 * @param platform - The OS, for the cache directory.
 * @param env - Environment variables, for HOME and APPDATA.
 * @returns The absolute data directory path.
 */
function jdtlsDataDir (
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  let cacheRoot = tmpdir()
  if (platform === 'win32' && env.APPDATA !== undefined) {
    cacheRoot = env.APPDATA
  } else if (platform === 'darwin' && env.HOME !== undefined) {
    cacheRoot = join(env.HOME, 'Library', 'Caches')
  } else if ((platform === 'linux' || env.TERMUX_VERSION !== undefined) &&
    env.HOME !== undefined) {
    cacheRoot = join(env.HOME, '.cache')
  }
  const hash = createHash('sha1').update(basename(cwd)).digest('hex')
  return join(cacheRoot, 'jdtls', `jdtls-${hash}`)
}

function listDir (dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function lombokInEnvDir (envDir: string): string | undefined {
  // env/Lombok-<version>/runtime/lib/lombok-*.jar
  for (const dir of listDir(envDir).filter((d) => d.startsWith('Lombok-'))) {
    const libDir = join(envDir, dir, 'runtime', 'lib')
    const jar = listDir(libDir)
      .find((f) => f.startsWith('lombok-') && f.endsWith('.jar'))
    if (jar !== undefined) {
      return join(libDir, jar)
    }
  }
  // env/gradle-cache-2/org/projectlombok/lombok/<v>/lombok-<v>.jar
  const gradleDir = join(envDir, 'gradle-cache-2', 'org', 'projectlombok',
    'lombok')
  for (const version of listDir(gradleDir)) {
    const jar = join(gradleDir, version, `lombok-${version}.jar`)
    if (existsSync(jar)) {
      return jar
    }
  }
  return undefined
}

interface LombokSearch {
  /** Set by `/lsp-lombok` or `lombokJar` in the project config. */
  readonly explicitPath?: string
  /** The `LOMBOK_JAR` environment variable. */
  readonly envPath?: string
  readonly rootDir: string
  readonly workspaceRoot?: string
}

/**
 * Finds a Lombok jar: an explicit path, then `LOMBOK_JAR`, then the
 * workspace's `env/` directory (Brazil workspaces).
 *
 * @param search - Where to look.
 * @returns The jar path, or undefined.
 */
function findLombokJar (search: LombokSearch): string | undefined {
  if (search.explicitPath !== undefined && existsSync(search.explicitPath)) {
    return search.explicitPath
  }
  if (search.envPath !== undefined && search.envPath !== '') {
    const fromEnv = resolve(search.rootDir, search.envPath)
    if (existsSync(fromEnv)) {
      return fromEnv
    }
  }
  const roots = [search.workspaceRoot, search.rootDir]
    .filter((r): r is string => r !== undefined)
  for (const root of new Set(roots)) {
    const jar = lombokInEnvDir(join(root, 'env'))
    if (jar !== undefined) {
      return jar
    }
  }
  return undefined
}

/**
 * Default `initializationOptions` for jdtls.
 *
 * @param lombokJar - The Lombok agent jar, if any.
 * @returns Options with import exclusions and the Lombok VM argument.
 */
function javaInitializationOptions (
  lombokJar: string | undefined
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    'java.import.exclusions': JAVA_IMPORT_EXCLUSIONS
  }
  if (lombokJar !== undefined) {
    settings['java.jdt.ls.vmargs'] = `-javaagent:${lombokJar}`
  }
  return { settings }
}

function readTail (path: string): string | undefined {
  try {
    // Regular files only: opening a FIFO would block the launch.
    if (!lstatSync(path).isFile()) {
      return undefined
    }
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, LOG_TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function isRealDir (path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true
}

function isRealFile (path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true
}

function snapshotDirs (resourcesDir: string): string[] {
  const projectsDir = join(resourcesDir, '.projects')
  const projects = isRealDir(projectsDir)
    ? listDir(projectsDir).map((p) => join(projectsDir, p)).filter(isRealDir)
    : []
  const rootDir = join(resourcesDir, '.root')
  return [resourcesDir, ...(isRealDir(rootDir) ? [rootDir] : []), ...projects]
}

function rotateLog (metaDir: string, logPath: string): boolean {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let rotated = true
  try {
    renameSync(logPath, join(metaDir, ROTATED_LOG_PREFIX + stamp))
  } catch {
    rotated = false
  }
  const old = listDir(metaDir)
    .filter((f) => f.startsWith(ROTATED_LOG_PREFIX) &&
      isRealFile(join(metaDir, f)))
    .sort()
    .slice(0, -ROTATED_LOGS_KEPT)
  for (const file of old) {
    try {
      unlinkSync(join(metaDir, file))
    } catch {}
  }
  return rotated
}

/**
 * Repairs a jdtls workspace whose saved resource tree is stale. When the
 * jdtls log ends with the known crash signature, deletes only the
 * resource-tree snapshots (`*.snap`, `*.tree`), keeps the JDT index, and
 * rotates the log so the same crash is not repaired twice. Nothing is
 * touched unless the metadata directories resolve inside the data dir,
 * and symlinks are never followed or deleted.
 *
 * @param dataDir - The jdtls data directory.
 * @param notify - Receives a message when a repair happens.
 * @returns The number of snapshot files deleted.
 */
function recoverCorruptJavaWorkspace (dataDir: string, notify: Notify): number {
  const metaDir = join(dataDir, '.metadata')
  const logPath = join(metaDir, '.log')
  const resourcesDir = join(metaDir, '.plugins', 'org.eclipse.core.resources')
  try {
    const root = realpathSync(dataDir) + sep
    const inside = [metaDir, resourcesDir]
      .every((dir) => realpathSync(dir).startsWith(root))
    if (!inside) {
      return 0
    }
  } catch {
    return 0
  }

  const log = readTail(logPath)
  if (log === undefined || !CRASH_SIGNATURE.test(log)) {
    return 0
  }

  let deleted = 0
  for (const dir of snapshotDirs(resourcesDir)) {
    for (const entry of listDir(dir)) {
      const path = join(dir, entry)
      if (/\.(snap|tree)$/.test(entry) && isRealFile(path)) {
        try {
          unlinkSync(path)
          deleted += 1
        } catch {}
      }
    }
  }
  if (deleted === 0) {
    return 0
  }

  const message = `[jdtls] Repaired a corrupt workspace: deleted ${deleted} ` +
    'snapshot file(s). The next build takes a moment.'
  if (rotateLog(metaDir, logPath)) {
    notify(message, 'info')
  } else {
    notify(`${message} The jdtls log (${logPath}) could not be renamed, ` +
      'so this repair may repeat.', 'warning')
  }
  return deleted
}

export {
  findLombokJar,
  JAVA_IMPORT_EXCLUSIONS,
  javaInitializationOptions,
  jdtlsDataDir,
  recoverCorruptJavaWorkspace
}
export type { LombokSearch }
