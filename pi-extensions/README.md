# Pi extensions

Pi extensions run inside the Pi process with your permissions, so this workspace holds only
extensions that have been audited and reimplemented here, rather than installed from npm or
GitHub.

Each package takes its **features** from an upstream extension, not its code: the upstream
source is audited, the audit and a functional spec go in the package's `AUDIT.md`, and the
package is written fresh from that spec. No upstream code, tests or file layout is copied, so
no upstream licence notice is needed. If that ever changes for a package, add a `NOTICE`.

| Package | Inspired by | Audit |
|---|---|---|
| `rewind` | arpagon/pi-rewind 0.5.0 | [AUDIT.md](packages/rewind/AUDIT.md) |
| `todo-list` | tintinweb/pi-manage-todo-list 0.4.0 | [AUDIT.md](packages/todo-list/AUDIT.md) |

## Commands

```sh
pnpm install                     # ignore-scripts is on; dependency build scripts never run
pnpm check                       # lint, typecheck, test, audit
pi -e ./packages/<name>          # try one package in Pi without installing it
```

Pi loads the TypeScript directly (jiti), so there is no build step.

## Conventions

- **Style:** [AICE JavaScript style guide](https://github.com/DEFRA/aice-team) for formatting
  and project rules (neostandard: 2 spaces, no semicolons, 80 columns, named exports at the
  bottom, Vitest tests in `tests/*.test.ts`), and Google's TypeScript style guide for types
  (strict, no `any`, no `!`, explicit return types on exports, interfaces for object shapes,
  `import type`, no wildcard imports). `eslint.config.js` enforces both.
- **Entry points:** `src/index.ts` default-exports the factory, because Pi requires it; it is
  the only default export allowed.
- **Dependencies:** exact versions only. Pi's own packages (`@earendil-works/pi-*`, `typebox`)
  are `peerDependencies: "*"` and never bundled. Other runtime deps must be widely used and
  audited; small author-owned helper libraries are reimplemented instead.
- **Build scripts:** `pnpm-workspace.yaml` denies each dependency that asks to run one.

## Adding or updating a package

1. Clone the upstream at a fixed commit into a scratch directory; never install it.
2. Audit every source file and dependency: network, processes, file writes, `eval` and dynamic
   imports, env and credential reads, install scripts, telemetry, minified or binary content,
   prompt text the model sees, sockets and daemons.
3. Write `AUDIT.md`: upstream URL and commit, findings with how they are handled, and the
   spec (tools, commands, events, settings, files, processes).
4. Implement from the spec, with tests written from the spec.
5. Run `pnpm check` and try it with `pi -e`.

To take upstream changes later, diff from the commit recorded in `AUDIT.md`, audit only the
change, update the spec and the code, and record the new commit.
