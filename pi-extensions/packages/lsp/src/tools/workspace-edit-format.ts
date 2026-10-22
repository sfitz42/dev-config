import { displayPath } from './tool-support.ts'

import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'

interface FileEdits {
  readonly path: string
  readonly edits: readonly TextEdit[]
}

/**
 * The text edits in a workspace edit, per file. Create, rename and delete
 * operations carry no text edits and are skipped.
 *
 * @param rootDir - The project root, for relative paths.
 * @param edit - The server's workspace edit.
 */
function fileEdits (rootDir: string, edit: WorkspaceEdit): FileEdits[] {
  const files: FileEdits[] = []
  for (const change of edit.documentChanges ?? []) {
    if ('textDocument' in change && 'edits' in change) {
      files.push({
        path: displayPath(rootDir, change.textDocument.uri),
        edits: change.edits.filter((e): e is TextEdit => 'range' in e)
      })
    }
  }
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    files.push({ path: displayPath(rootDir, uri), edits })
  }
  return files
}

/**
 * A rename preview: each file, then `line:col → "newText"` per edit.
 *
 * @param rootDir - The project root.
 * @param edit - The server's workspace edit.
 */
function formatRenameEdit (
  rootDir: string,
  edit: WorkspaceEdit
): { text: string, fileCount: number, editCount: number } {
  const files = fileEdits(rootDir, edit)
  const lines = files.flatMap((file) => [
    `${file.path}:`,
    ...file.edits.map((e) => `  ${e.range.start.line + 1}:` +
      `${e.range.start.character + 1} → "${e.newText}"`)
  ])
  return {
    text: lines.join('\n'),
    fileCount: files.length,
    editCount: files.reduce((n, file) => n + file.edits.length, 0)
  }
}

const EDITS_SHOWN_PER_FILE = 5
const NEW_TEXT_LIMIT = 60

/**
 * A short summary of a code action's edits: at most five per file, with
 * new text cut to 60 characters and newlines escaped.
 *
 * @param rootDir - The project root.
 * @param edit - The action's workspace edit.
 */
function summarizeActionEdit (rootDir: string, edit: WorkspaceEdit): string[] {
  return fileEdits(rootDir, edit).flatMap((file) => {
    const shown = file.edits.slice(0, EDITS_SHOWN_PER_FILE).map((e) => {
      const { start, end } = e.range
      const text = (e.newText.length > NEW_TEXT_LIMIT
        ? `${e.newText.slice(0, NEW_TEXT_LIMIT - 3)}...`
        : e.newText).replace(/\n/g, '\\n')
      const at = `${file.path}:${start.line + 1}:${start.character + 1}`
      return start.line === end.line && start.character === end.character
        ? `     ${at} insert "${text}"`
        : `     ${at}-${end.line + 1}:${end.character + 1} → "${text}"`
    })
    const more = file.edits.length - EDITS_SHOWN_PER_FILE
    return more > 0
      ? [...shown, `     ... and ${more} more edits in ${file.path}`]
      : shown
  })
}

export { fileEdits, formatRenameEdit, summarizeActionEdit }
export type { FileEdits }
