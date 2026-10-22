import type { ServerConfig } from '../project-config.ts'

const TYPESCRIPT_SERVER: ServerConfig = {
  command: 'typescript-language-server',
  args: ['--stdio']
}

/**
 * Built-in servers, found on PATH. Nothing is downloaded or installed;
 * a missing server just reports that it could not start.
 */
const DEFAULT_SERVERS: Readonly<Record<string, ServerConfig>> = {
  typescript: TYPESCRIPT_SERVER,
  javascript: TYPESCRIPT_SERVER,
  typescriptreact: TYPESCRIPT_SERVER,
  javascriptreact: TYPESCRIPT_SERVER,
  rust: { command: 'rust-analyzer', args: [] },
  python: { command: 'pyright-langserver', args: ['--stdio'] },
  go: { command: 'gopls', args: ['serve'] },
  java: { command: 'jdtls', args: [] }
}

/**
 * A hint of how long a server usually takes to become ready.
 *
 * @param languageId - The language.
 * @returns One sentence for "still starting" messages.
 */
function expectedStartTime (languageId: string): string {
  switch (languageId) {
    case 'java':
      return 'This typically takes 1-5 minutes for Java (project indexing).'
    case 'rust':
      return 'This typically takes 30s-2min for Rust (cargo metadata + ' +
        'indexing).'
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact':
      return 'This typically takes 10-30s for TypeScript/JavaScript.'
    case 'python':
      return 'This typically takes 10-30s for Python.'
    case 'go':
      return 'This typically takes 10-30s for Go.'
    default:
      return 'This may take a few seconds to a minute.'
  }
}

export { DEFAULT_SERVERS, expectedStartTime }
