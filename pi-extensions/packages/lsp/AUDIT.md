# lsp: audit and spec

Inspired by [samfoy/pi-lsp-extension](https://github.com/samfoy/pi-lsp-extension) 1.4.0,
commit `ca0b3b8e53da5b814bf851bca0be47e7b413b122`, audited 2026-10-22.
This package is a new implementation written from the spec below; no upstream code or tests
were copied.

What was read: all of `src/`, `test/` (including its fake server fixture), `specs/`,
`README.md`, `CHANGELOG.md` and `package.json`. `dist/` is the esbuild bundle of `src/`; it was
checked for network and `eval` use (none) and registers the same tools. `bemol-extension/` is a
separate, unpublished extension that detects Amazon Brazil workspaces, runs `bemol`, and
registers a workspace provider over `pi.events`; it is not part of the published package and
was not ported (the provider hook it uses is).

## Audit findings

| Severity | Finding | Handling here |
|---|---|---|
| High | `.pi-lsp.json` in any project can name server commands, env, `autoStart` and a Lombok `-javaagent` jar. Opening Pi in a cloned repo runs them (on session start with `autoStart`, or on the first tool call). Pi's project trust does not cover this file, and a folder without `.pi` resources counts as trusted. | Program-running settings are used only after the user approves this exact file for this project (prompt, remembered by SHA-256 in `<agentDir>/pi-lsp-approvals.json`, 0600). Untrusted projects and sessions without UI are never approved. The prompt runs in the background so it cannot stall startup. Verified in Pi: a declined config does not run its command. |
| Medium | Shared-daemon sockets are created with default permissions in the provider's state dir; any local user who can reach the directory can connect and drive the language server (open files, run server commands). Any session can also send `shutdown`/`exit` through the daemon and stop the server for everyone. | The daemon refuses a socket directory that is not owned by the user or allows group/world access, creates it 0700, and makes the socket and pid file 0600. Clients check the same before connecting. The daemon answers `initialize`, `shutdown` and `exit` itself and never forwards them. |
| Medium | `/lsp-restart` kills whatever pid is in the daemon's pid file (`SIGTERM`); a stale or planted pid file kills an unrelated process. | Daemons are stopped by a request over their own socket; pids are never signalled. |
| Medium | The factory installs a process-wide `uncaughtException` handler (to swallow EPIPE) and installs another on every reload. | No global handlers. Writes after a server exits are absorbed by a stdin error handler and by catching the notification promise. |
| Medium | `code_rewrite` writes files outside Pi's file mutation queue, re-reading files after the search, so a concurrent edit could shift offsets. Its `path` can point outside the project. | Each file is re-read and re-matched inside `withFileMutationQueue`; apply mode only writes files whose real path is inside the project root. The tool runs sequentially. |
| Medium | Positional pattern matching ignores extra trailing children, so `foo($A)` matches `foo(a, b)` and rewriting it to `bar($A)` silently drops `b`. A pattern node whose only child is a metavariable collapses into it, so `foo($$$ARGS)` captures `(a, b)` with its parentheses and the rewrite gives `bar((a, b))`. Operators are not compared, so `$X + $Y` matches `a - b`. | Unfielded children must match exactly; fields the pattern does not mention (return types and so on) are still ignored. Only statement wrappers collapse. Operator tokens in fields are compared. Variadic captures keep the original separators. |
| Medium | `tree-sitter-wasms` ships prebuilt grammar wasm from a third party. | Replaced by the official grammar packages' own wasm (see Dependencies). |
| Low | Tools report a file as clean, or answer about stale content, when the server has never been sent the file. | Position tools and diagnostics open the file first; diagnostics wait briefly for the first publish. |
| Low | The completions tool's per-file lock is released before the completion request and revert it is meant to protect, and the temporary `didChange` can go to a document that was never opened. `query` positions are off by one. | The temporary dot, request and revert all run under a per-document lock that file sync also takes; the document is opened first. Positions are consistent. |
| Low | The tree cache compares length plus the first and last 4 KB, so an edit in the middle of a file can return a stale tree. | The cache compares the full content. Indexing and searches parse without caching and free their trees. |
| Low | Requests have no timeout; a hung server hangs the tool. | 60 s request timeout. |
| Low | Struct symbols use LSP kind 22 (EnumMember). | Kind 23. |
| Low | Shutting down while a server is still starting leaves it running (listed as a known issue upstream). | A server that finishes starting after shutdown is stopped. |
| Low | `lsp_code_actions` is registered twice. A daemon accepts requests before its server is initialized and drops the replies; daemon clients have no server capabilities. | Registered once. The daemon answers "still initializing" until ready, then serves each client the server's `initialize` result. |
| Info | No network access, telemetry, `eval` or dynamic code loading. Servers are spawned without a shell, from PATH; nothing is downloaded. `PI_LSP_DEBUG` and `LOMBOK_JAR` are the only environment variables read. | Same; `PI_LSP_DEBUG` logging was not ported. |

## Dependencies

| Package | Version | Why |
|---|---|---|
| `vscode-languageserver-protocol` | 3.18.4 | Microsoft; LSP types and the JSON-RPC connection (pulls `vscode-jsonrpc` 9.0.3). |
| `web-tree-sitter` | 0.27.1 | tree-sitter org; wasm parser runtime. |
| `tree-sitter-{typescript, javascript, python, rust, go, java, c, cpp, ruby, scala, bash, json, html, css}` | pinned in `package.json` | tree-sitter org grammars; only their bundled `.wasm` is used. |
| `@tree-sitter-grammars/tree-sitter-lua` | 0.4.1 | tree-sitter-grammars org; Lua wasm. |

The grammar packages have a `node-gyp-build` install script (for native bindings this package
does not use); `ignore-scripts` keeps it from running. Their optional `tree-sitter` peer is not
installed.

Not available from an official source, so these languages lose the tree-sitter fallback
(their language servers still work): **Swift** (the only package ships no wasm and depends on
`tree-sitter-cli`, which downloads binaries) and **Kotlin** (the tree-sitter-grammars package
ships wasm but lists `npm-check-updates` as a runtime dependency).

## Spec

### Servers

Built-in servers, looked up on PATH and never installed: `typescript-language-server --stdio`
for TypeScript and JavaScript (plain and React), `rust-analyzer`, `pyright-langserver --stdio`,
`gopls serve`, `jdtls`. Languages come from file extensions (`.ts .mts .cts .tsx .js .mjs .cjs
.jsx .rs .py .go .java .c .h .cpp .cc .hpp .cs .rb .kt .kts .scala .ex .exs .lua .sh .bash .zsh
.swift .zig .json .html .htm .css .vue .php`); more servers come from `.pi-lsp.json` or
`/lsp-config`.

Servers start lazily: the first tool call for a language starts its server in the background
and reports "starting" with a typical wait (Java 1-5 min, Rust 30 s-2 min, others 10-30 s).
Tools fall back to tree-sitter while a server is not running. A crashed server is restarted
up to 3 times per session with backoff from 1 s, doubling to at most 30 s. The client sends
`initialize` with hover (plain/markdown), definition, references, hierarchical document
symbols, rename, diagnostics with related information, completion (no snippets), code actions,
workspace folders, workspace symbols and `workspace/configuration`, which is answered from the
server's `settings`.

**Java:** a Lombok jar is found from `/lsp-lombok` or `lombokJar`, then `LOMBOK_JAR`, then a
Brazil workspace's `env/Lombok-*/runtime/lib/lombok-*.jar` or
`env/gradle-cache-2/org/projectlombok/lombok/<v>/lombok-<v>.jar`. With a jar, jdtls gets
`--jvm-arg=-javaagent:<jar>`. Unless the server config sets `initializationOptions`, jdtls gets
`java.import.exclusions` (jdtls defaults plus `.bemol` and `.gradle`) and the agent as
`java.jdt.ls.vmargs`. After start, `java/buildWorkspace` is requested. Before this session
launches jdtls itself, a workspace whose `.metadata/.log` ends with the resource-tree crash
signature has its `*.snap`/`*.tree` snapshots removed (the index is kept) and the log rotated
(3 kept), only when the metadata directories resolve inside the jdtls data dir
(`<cache>/jdtls/jdtls-<sha1(basename(cwd))>`), never through symlinks.

### Workspace providers and shared daemons

Another extension can emit a workspace provider on `lsp:register-workspace-provider` (or leave
it on the event bus as `lsp:workspace-provider` before this extension loads). A provider has a
type, an optional workspace root, an optional state directory, workspace folders, a one-time
`ensureReady`, status text and `shutdown`; malformed providers are ignored.

With a state directory, each language runs as a shared daemon: a detached `node lsp-daemon.ts
<socket> <command> [args]` listening on `<stateDir>/sockets/lsp-<language>.sock`, which several
sessions use. The daemon initializes the server once, answers each client's `initialize` with
that result, routes requests by rewritten ids, broadcasts notifications, answers
`workspace/configuration` itself, forwards other server requests to the first client, and exits
5 minutes after its last client leaves or when its server exits. Sessions wait up to 10 s for a
new daemon to listen and retry for up to 5 minutes while it initializes, then fall back to a
direct server.

### File sync

Pi `read` results open the file on an already running server; `write` and `edit` results send
the new content (starting the server if needed), invalidate the tree-sitter cache and re-index
the file. At most 100 documents stay open; the least recently used is closed.

After a successful `write` or `edit`, when the file's server is already running, its errors
(at most 10, then "... and N more") are appended to the tool result after a 1.5 s settle, unless
`autoInjectDiagnostics` is `false` or a list without that language.

### Tools

Paths may start with `@`. Positions are 1-indexed. Position tools take `path`, `line`,
`character`, or `query`: a symbol name (`Class.method` allowed) matched exactly, then
case-insensitively, then as a substring, from the server's document symbols or tree-sitter. A
resolved query prefixes the answer with `Resolved "q" → name at l:c [source]`; an unknown one
lists up to 20 available symbols.

| Tool | Parameters | Result |
|---|---|---|
| `lsp_diagnostics` | `path` (or `"*"`) | One file: `path:l:c severity: message (code) [source]`, errors first, with counts. `"*"`: every running server's cached diagnostics, by severity then file. Fallback: tree-sitter syntax errors. Prompt guidelines tell the model to check after edits. |
| `lsp_hover` | position | Hover text (markup as is, code fenced). Fallback: the enclosing declaration's first line. |
| `lsp_definition` | position | `Definition: path:l:c` or a list. Fallback: same-file declarations, then the workspace index (exact name, 10 max). |
| `lsp_references` | position, `includeDeclaration` (default true) | `N reference(s) found:` and locations. |
| `lsp_symbols` | `path` or `query` | File symbols, indented by nesting, or workspace symbols from the first running server; fallbacks are tree-sitter and the workspace index. |
| `lsp_rename` | position, `newName` | Preview only: edits per file and a note to apply them with edit/write. |
| `lsp_code_actions` | position, `endLine`, `endCharacter`, `kind` | Actions sorted preferred first, then quickfix, refactor, source; each with up to 5 edits per file or its command. Overlapping diagnostics are sent. Nothing is executed. |
| `lsp_completions` | position, `limit` (20), `trigger` (`auto`/`none`) | `N of M completions`: kind, label, details, a short doc line; resolved when supported (2 s each). With `auto`, after an identifier or `)`/`]`, a `.` is inserted temporarily (never on disk) to list members. |
| `code_overview` | `path`, `depth` (3) | Directory tree (200 entries, hidden and dependency dirs skipped), dependency manifests, symbols from up to 10 entry-point files, workspace index stats. |
| `ast_search` | `pattern`, `language`, `path`, `max_results` (50) | Matches with location, text and captures. |
| `code_rewrite` | `pattern`, `replacement`, `language`, `path`, `dry_run` (default true) | Dry run: before/after per match. Apply: rewrites up to 500 matches, inside the project only, then syncs the files. Replacements may only use captured names. |

**Patterns:** code in the target language with `$NAME` (one node; repeats must match the same
text) and `$$$NAME` or `$$$` (zero or more siblings). The pattern is parsed as is, or inside
language-specific wrappers (statement, parenthesised expression, function body). Node types,
leaf text and operator tokens must match; children in fields the pattern mentions match by
field, other fields are ignored, unfielded children match in order and all of them. Matches do
not overlap. In replacements, references are filled from captures, and a `;` ending the
matched node is kept.

**Tree-sitter languages:** TypeScript, TSX, JavaScript, Python, Rust, Go, Java, C, C++, Ruby,
Scala, Lua, Bash, JSON, HTML, CSS. Symbols are extracted per language (functions, classes and
members, interfaces, enums, type aliases, variables, Rust impls/traits/modules, Go types, Java
fields and constructors, Ruby modules); others get a generic function/class scan. The workspace
index walks up to 5000 files under 500 KB, skipping hidden, dependency and build directories.

**Rendering:** every tool has a one-line call view and a result summary; `lsp_diagnostics`
expands to 30 lines, `ast_search` groups matches by file with captures (20 collapsed), and
`code_rewrite` shows a red/green diff by file (10 collapsed).

### Commands and status

- `/lsp`: each configured server, running or not, with diagnostics count and `[shared]`.
- `/lsp-restart <language>`: restarts the server and its shared daemon; lists running servers
  without an argument.
- `/lsp-config <language> <command> [args]`: sets a server for this session.
- `/lsp-lombok [path]`: shows or sets the Lombok jar.

The footer (`lsp`) shows workspace setup, starting, ready, failed, restarting, and after each
tool the running languages with their diagnostics count, or `LSP: idle`.

### `.pi-lsp.json`

Loaded at session start: `autoStart` (languages to start at once), `lombokJar` (path or
`"auto"`), `autoInjectDiagnostics` (`true`, `false` or language list) and `servers` (per language:
`command`, `args`, `env`, `initializationOptions`, `settings`). Invalid fields are dropped with a
warning. `servers`, `autoStart` and `lombokJar` need approval, as described under the findings.

## Deviations from upstream

- Tree-sitter covers the same languages except Swift and Kotlin (see Dependencies). The
  `PI_LSP_DEBUG` logger is gone.
- Pi loads `src/` directly; there is no `dist/` bundle. The daemon runs as TypeScript through
  Node's type stripping (Node 22.18+), which Node refuses inside `node_modules`, so install this
  package from its local path.
- Behaviour changes listed in the findings: config approval, daemon hardening and protocol,
  stricter pattern matching, rewrite scope and queueing, files opened before queries, request
  timeouts.
