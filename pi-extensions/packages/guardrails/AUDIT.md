# guardrails: audit and spec

Inspired by [aliou/pi-guardrails](https://github.com/aliou/pi-guardrails) 0.19.0, commit
`0abc1ff5dd6f1d987d72d1e38740245d88755415`, audited 2026-10-22, together with its author-owned
dependencies `@aliou/sh` 0.3.3 and `@aliou/pi-utils-settings` 0.19.1 (both read from
`npm pack` tarballs, never installed). This package is a new implementation written from the spec
below; no upstream code, tests or test tables were copied.

## Audit findings

Bypasses first. "Fixed" means a test in `tests/` reproduces the upstream behaviour and passes here.

| Severity | Finding | Handling here |
|---|---|---|
| High | **Untrusted project config switches guardrails off.** The project file `.pi/extensions/guardrails.json` is read at startup whatever Pi's project trust says, from any parent directory with a `.pi` folder. A cloned repo can set `enabled: false`, add allowed patterns or `allowedPaths: [/]`. | The project file is only read when `ctx.isProjectTrusted()`; otherwise it is ignored with a notice (`tests/config.test.ts`, `tests/extensions.test.ts`). |
| High | **The agent can switch guardrails off.** Nothing stops a `write`/`edit`/bash redirect to the guardrails config, `~/.pi/agent/settings.json` (uninstall the package) or `trust.json`. | Built-in read-only self-protection policy for those files, applied whatever the config says (`tests/policies.test.ts`). |
| High | **Allowed command patterns are substring matches on the whole command**, checked before anything else: allowing `npm test` allows `npm test; rm -rf ~`. Allowed patterns also beat auto-deny. | Allowed patterns waive a finding only for the simple command it was found in; session grants match the whole command exactly; auto-deny wins (`tests/permission-gate.test.ts`). |
| High | **Permission gate misses wrapped and nested commands**: matchers only look at `argv[0]` literally, so `/bin/rm -rf`, `command`/`env`/`nice`/`timeout`/`nohup`/`exec`/`xargs rm -rf`, `bash -c`/`sh -lc '…'`, `eval`, `find -exec rm -rf`, `watch`, `ssh host rm -rf /`, `R=rm; $R -rf`, `{rm,x} -rf` all pass. | Wrappers peeled into layers, nested shell payloads parsed recursively (depth 4), variables with static values resolved, runtime-only command names flagged (`tests/permission-gate.test.ts`). |
| High | **Policies miss most indirect reads**: `cat $(echo .env)`, `F=.env; cat $F`, `sh -c 'cat .env'`, `python3 -c "open('.env')"`, `git show HEAD:.env`, `--file=.env`, a symlink to `.env`, `cd sub && cat ../.env`. | Variables resolved, `echo`/`printf` inside substitutions treated as producing paths, nested shells parsed, arguments split into sub-tokens, symlinks resolved, `cd` targets used as extra bases (`tests/policies.test.ts`). |
| High | **Code the gate never sees** (found in review of this rewrite; upstream has the same gaps): a shell reading stdin (`curl … \| bash`, `… \| base64 -d \| sh`, `bash <<< "…"`), interpreters given inline code (`perl -e`, `node -e`, `ruby -e`, `python -c`, `php -r`, `osascript -e`, `pwsh -c`), and `find -delete`. | Each is a built-in finding, so it prompts (or is blocked without a UI). `bash -c` is still parsed and checked; `bash script.sh`, `node file.js` and `python -m` are not flagged (`tests/gate-bypass-probes.test.ts`). |
| Medium | **Unparseable commands fail open.** On a parser error the gate only checks substring patterns, so anything the parser rejects runs unprompted. | Unparseable text (top-level or nested) is itself a finding: prompted, or blocked without a UI. |
| Medium | **Substitutions the parser leaves as text are never checked**: unquoted heredoc bodies (bash runs `$(…)` there), `${x:-$(cmd)}` operands, arithmetic. | The in-house parser finds substitutions in all three (`tests/shell-parser.test.ts`). |
| Medium | **Path access trusts lexical paths**: a symlink inside the workspace leads anywhere; `$HOME/.ssh/id_rsa` resolves inside cwd as a literal `$HOME` folder; `~user/…` likewise; `cd .. && cat x` is invisible. | Symlinks resolved; known variables (`HOME`, `PWD`, `TMPDIR`, script assignments, `$(pwd)`) expanded; unknown leading expansions prompt as "location only known at runtime" (once/deny only); `cd` targets checked (`tests/path-access.test.ts`). |
| Medium | **`grep` tool reads protected files in a directory search** (any not git-ignored; also via its `glob` argument). | `glob` checked as a target; protected lines redacted from grep results via `tool_result`. |
| Medium | **Skill and Pi docs directories are writable without a prompt**, since their grants apply to every tool. | Those grants apply to read-only tools only. |
| Medium | Docker matcher misses space-separated forms (`--pid host`, `-v /:/host`, `--volume /:/…`). | Handled (`tests/permission-gate.test.ts`). |
| Low | v0 migration turns every pattern object without `regex` into a regex, silently widening hand-written allow patterns (`ls .` matches anything). | Only v0 string entries become regexes. |
| Low | Migration 011 compares versions as strings; 012 uses `??` on array lengths, so `patterns: []` hides other lists. | Numeric comparison; explicit length checks. |
| Low | Path prompt preselects "Allow once"; gate prompt allows on Enter. A stray Enter grants access. | Path prompt preselects Deny; gate needs `y`, Enter denies. |
| Low | Prompt text shows raw commands; terminal escapes in a command could restyle the prompt. | Control characters are shown as `␛`/`�`. |
| Info | `@aliou/sh` 0.3.3 is published as `"license": "UNLICENSED"`: upstream ships a dependency with no open-source licence. | Not used; replaced by `src/shell/`. |
| Info | `@aliou/pi-utils-settings` pulls a third author package (`@aliou/pi-utils-ui`); its `$schema` URL points at unpkg. | Not used; `$schema` points at this package's local `schema.json`. |
| Info | Glob expansion spawns `fd` from `PATH`. | Done in-process with `fs.globSync`; no child processes anywhere. |
| Info | Pi lets a later extension mutate `tool_call` input after guardrails has checked it, and does not re-check. | Pi design; documented, not fixable here. |
| None | No network, telemetry, `eval`/`Function`, or lifecycle scripts in upstream or its deps. | n/a |

Residual risk: recursive reads in bash (`grep -r`, `tar`, `cp -r`, `rsync` of a directory holding a
protected file) are not visible as file names and are not blocked. Guardrails reduces accidents; it is
not a sandbox.

## Spec

Four Pi extensions in one package, each with its own `tool_call` hook, sharing config files and
talking over Pi's event bus.

### Config

- Files: global `<agentDir>/extensions/guardrails.json` (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`);
  project `.pi/extensions/guardrails.json` in the nearest directory (below home) with a `.pi` folder,
  else the cwd. Session-only "memory" settings live in process, shared by the four extensions and
  keyed by Pi session id.
- Priority: defaults < global < project (trusted only) < memory. Policy rules override by `id`;
  dangerous, allowed and auto-deny pattern lists are unioned by `pattern`; `customPatterns` (highest
  scope that sets it) replaces the dangerous list and turns the built-in matchers off; allowed paths
  are unioned; other values come from the highest scope with a valid value. Values of the wrong type
  are ignored and reported.
- Schema (`schema.json`, generated by `node scripts/write-schema.ts` from `src/config/config-schema.ts`):
  `enabled`, `applyBuiltinDefaults`, `onboarding`, `features.{policies,permissionGate,pathAccess}`,
  `policies.rules[]` (`id`, `name`, `description`, `patterns`, `allowedPatterns`, `protection`
  noAccess|readOnly|none, `onlyIfExists` (default true), `respectCwd` (default true), `blockMessage`
  with `{file}`, `enabled`), `pathAccess.{mode allow|ask|block, applyTo all|write, allowedPaths
  [{kind,path}], alwaysScope local|global}`, `permissionGate.{patterns, customPatterns,
  requireConfirmation, allowedPatterns, autoDenyPatterns}`.
- Defaults: guardrails on; policies and permission gate on, path access off (mode ask, applies to
  all, `/dev/null` allowed, always-grants local); built-in rules `secret-files` (on: `.env`,
  `.env.local`, `.env.production`, `.env.prod`, `.dev.vars`, except example/sample/test variants),
  `home-ssh`, `home-config` (gh, gcloud, op, sops), `home-gpg` (off); the 14 default dangerous
  patterns (rm -rf, sudo, dd of=, mkfs., chmod -R 777, chown -R, doas, pkexec, shred, wipefs,
  blkdiscard, fdisk, parted, docker run --privileged).
- Saves write `$schema` and the format `version` (`0.19.0`). Migrations run on load and are written
  back: v0 string patterns to regex objects (with a `.v0.json` backup), removal of toolchain and
  command-explainer fields, `envFiles` to a `secret-files` policy, legacy allowed-path shapes to
  `{kind, path}`, string booleans, `/dev/null` for onboarded ask-mode configs, version stamp, and a
  notice about pattern-list merging. Upstream's unused `applyBuiltinDefaults`/`markOnboardingDone`
  migrations are not run, as upstream does not run them.

### guardrails (`src/index.ts`): file policies and commands

- `tool_call` for read, write, edit, grep, find, ls, bash, powershell: noAccess rules apply to all of
  them; readOnly rules to write, edit, bash, powershell. Strictest rule first; first match blocks
  with the rule's message.
- Targets: file tools' `path` (and `file_path`), grep's `glob`; bash: every argument and redirect
  target with sub-tokens, globs expanded, braces expanded, through nested shells and substitutions
  (`echo`/`printf`/`tr` arguments skipped unless inside a substitution); powershell: tokens.
- Matching: globs with `/` match the whole path, others the file name; regexes the whole path,
  case-insensitively. Each target is tested as cwd-relative, `~/…` and absolute, for its real path
  too. With `respectCwd`, `~`/`/`-anchored patterns are skipped when every real location is inside
  the cwd. `onlyIfExists` skips missing files unless the path holds an expansion.
- Self-protection: read-only rule for `<agentDir>/{extensions/guardrails.json,settings.json,trust.json}`
  and any `.pi/extensions/guardrails.json` or `.pi/settings.json`, whenever guardrails is enabled.
- `tool_result` for grep: lines from noAccess files replaced with
  `[redacted by guardrails: <rule>]`.
- Commands: `/guardrails:settings` (tabs Memory, Local, Global; sections Features, Policies with a
  rule editor and an add-policy wizard, Path Access, Permission Gate; changes are drafts until
  Ctrl+S; Tab switches scope; Esc closes), `/guardrails:onboarding` (welcome, defaults
  recommended|minimal, path access ask|off, recap; writes the global file; refuses if already done),
  `/guardrails:examples` (scope, file-policy presets, command presets, review; adds without
  replacing). All three need the TUI.
- On session start it asks the other extensions to announce themselves (feature discovery) and
  reports config messages (migrations, ignored project file, schema problems).

### path-access (`src/path-access/index.ts`)

- When enabled and mode is not allow; with `applyTo: write`, read, grep, find and ls pass.
- Targets: file tools' path and its real path; bash path-like arguments (with separators), redirect
  and `cd` targets, interpreter code tokens, `find` roots, `xargs`/`-exec` commands; `ssh` remote
  arguments, `echo`/`printf`/`tr` text, `cut -d`/`sort -t` values and `kubectl … --` arguments are
  not local paths; missing paths whose parent is also missing are dropped unless the command can
  create directories.
- Allowed: inside cwd, a grant (`file` exact, `directory` tree), and for read-only tools Pi's docs and
  the current skills. Block mode, or no UI, denies. Ask mode prompts: allow once, file or directory
  (parent; the path itself for ls/find) for the session or always, or deny; directory grants are not
  offered for `/` or home; runtime-only locations get once/deny. Always-grants go to `alwaysScope`
  (project grants in an untrusted project also apply for the session). RPC clients get a `select`.

### permission-gate (`src/permission-gate/index.ts`)

- bash only. Order: auto-deny (whole command or any simple command) blocks; then findings: parse
  failures, built-in matchers on every command and wrapper layer, configured patterns on the whole
  command (default keyword patterns skipped when the built-ins ran on a parsed command); allowed
  patterns waive findings per simple command; session grants waive an exact command.
- Built-ins: rm with recursive and force flags; shred; sudo; doas; pkexec; dd with `of=`; mkfs*;
  wipefs; blkdiscard; fdisk/sfdisk/cfdisk/parted/sgdisk; recursive chmod granting others write;
  recursive chown; docker/podman/nerdctl run/create with privileged, host pid/network/userns/uts/ipc,
  root mount or docker/podman socket; command names only known at runtime.
- `requireConfirmation: false` warns only. No UI blocks. The TUI prompt scrolls long commands: `y`
  allow, `a` allow for session, `n`/Enter/Esc deny, `s` deny and abort the turn.

### herdr (`src/herdr/index.ts`)

Maps prompt-opened/closed events to `herdr:blocked` `{ active, label }` on the event bus; clears on
shutdown. No configuration, no Herdr dependency.

### Events (`src/events.ts`)

`guardrails:action:blocked`, `guardrails:risk:detected`, `guardrails:prompt:opened` and
`guardrails:prompt:closed` (same `prompt.id`), deprecated `guardrails:action:prompted`,
`guardrails:feature:request`/`register`, and new `guardrails:config:changed` (settings saved; every
extension reloads).

## Deviations from upstream

All the "Handling here" entries above, plus: the onboarding command is always registered (it says
when onboarding is already done); `/dev/null` is always allowed by default rather than only after
migration; the path prompt has an `n` shortcut for Deny.
