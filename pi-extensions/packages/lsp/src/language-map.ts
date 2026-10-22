const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.rs': 'rust',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.lua': 'lua',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.swift': 'swift',
  '.zig': 'zig',
  '.json': 'json',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.vue': 'vue',
  '.php': 'php'
}

/**
 * Maps a file path to its LSP language id by extension.
 *
 * @param filePath - Any path; only the final extension is used.
 * @returns The language id, or undefined for unknown extensions.
 */
function languageIdForPath (filePath: string): string | undefined {
  const match = /\.[^./\\]+$/.exec(filePath)
  if (match === null) {
    return undefined
  }
  return EXTENSION_LANGUAGES[match[0].toLowerCase()]
}

export { EXTENSION_LANGUAGES, languageIdForPath }
