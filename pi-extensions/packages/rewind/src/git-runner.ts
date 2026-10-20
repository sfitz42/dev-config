import { spawn } from 'node:child_process'

interface GitRunOptions {
  /** Written to git's stdin. */
  readonly input?: string
  /** Added to the inherited environment. */
  readonly env?: Readonly<Record<string, string>>
}

/** Runs git in one repository. Arguments are never parsed by a shell. */
interface GitRunner {
  readonly root: string
  run (args: readonly string[], options?: GitRunOptions): Promise<string>
}

class GitError extends Error {
  readonly args: readonly string[]
  readonly exitCode: number | null

  constructor (
    args: readonly string[],
    exitCode: number | null,
    stderr: string
  ) {
    super(stderr.trim() || `git ${args[0] ?? ''} failed (exit ${exitCode})`)
    this.name = 'GitError'
    this.args = args
    this.exitCode = exitCode
  }
}

/**
 * Creates a runner that spawns `git` with an argument array in `root`.
 *
 * Pathspecs are always literal (`GIT_LITERAL_PATHSPECS=1`), so a file
 * named `*` or `:(top)` means that file and nothing else.
 *
 * @param root - Working directory for every command.
 * @returns The runner. `run` resolves with raw stdout (not trimmed) and
 *   rejects with a {@link GitError} on a non-zero exit.
 */
function createGitRunner (root: string): GitRunner {
  return {
    root,
    run: (args, options = {}) => new Promise((resolve, reject) => {
      const child = spawn('git', [...args], {
        cwd: root,
        env: {
          ...process.env,
          GIT_LITERAL_PATHSPECS: '1',
          GIT_TERMINAL_PROMPT: '0',
          ...options.env
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString('utf8'))
        } else {
          reject(new GitError(args, code, Buffer.concat(stderr).toString()))
        }
      })
      // git may exit before reading its input; the exit code reports that.
      child.stdin.on('error', () => {})
      if (options.input === undefined) {
        child.stdin.end()
      } else {
        child.stdin.end(options.input)
      }
    })
  }
}

/**
 * Finds the repository root containing `cwd`.
 *
 * @param cwd - Any directory.
 * @returns The absolute root, or undefined outside a work tree or when git
 *   is not installed.
 */
async function findRepoRoot (cwd: string): Promise<string | undefined> {
  try {
    const out = await createGitRunner(cwd)
      .run(['rev-parse', '--show-toplevel'])
    const root = out.trim()
    return root === '' ? undefined : root
  } catch {
    return undefined
  }
}

/** Splits NUL-terminated git output into its records. */
function splitNul (output: string): string[] {
  return output.split('\0').filter((part) => part !== '')
}

export { createGitRunner, findRepoRoot, GitError, splitNul }
export type { GitRunner, GitRunOptions }
