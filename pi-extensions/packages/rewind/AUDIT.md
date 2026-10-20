# rewind: audit and spec

Inspired by [arpagon/pi-rewind](https://github.com/arpagon/pi-rewind) 0.5.0, commit
`91611ad87992fb7b635a41ba68f67916ff6e6ae3`, audited 2026-10-20.
This package is a new implementation written from the spec below; no upstream code or tests
were copied.

## Audit findings

Upstream has no runtime dependencies, network access, telemetry, `eval` or install scripts. It
runs `git` via `spawn` (no shell) and writes under `refs/pi-checkpoints/` and a temp directory.
It was written against the older `@mariozechner/pi-coding-agent` API.

| Severity | Finding | Handling here |
|---|---|---|
| High | Git commands are built as one string and re-split by a home-made quote parser. Paths are wrapped in `"…"`, so a file name containing `"` splits into other paths, and `git clean -f` / `git add` act on the wrong files. `ls-files` output is split on newlines, so names containing a newline break too. | Git always gets an argument array. All path output is read with `-z`. Paths go to `git update-index -z --stdin` (exact paths). Untracked files are removed with `rm` only after checking they resolve inside the repo. |
| High | `git add` takes pathspecs, so an untracked file named `*` or `:(top)…` glob-matches other files. | No pathspecs are used for adding; `GIT_LITERAL_PATHSPECS=1` is set for every git call. |
| High | Restore runs `git reset --hard <checkpoint HEAD>`, which moves the branch and silently drops commits made since the checkpoint. | HEAD and branch refs are never moved; only the worktree and staged index are restored. The confirm prompt says when HEAD has moved. |
| Medium | Restore continues even when the safety (before-restore) snapshot fails, then deletes untracked files with no way back. | No safety checkpoint, no restore. |
| Medium | On every startup it deletes all checkpoints from every other session, so a second Pi session in the same repo wipes the first one's checkpoints. | Other sessions' checkpoints are pruned only once older than 7 days; each session keeps its newest 50. |
| Medium | Pi 1.3.0 replaces the extension runtime on fork. Upstream's `session_start` fork branch only updates the session id on its (now empty) state, so rewind stays off after `/fork`. | Every `session_start` fully initialises. |
| Low | Metadata is stored as `key value` lines and read with the first regex match. The description (from the user's prompt) comes before the tree SHAs, so a prompt containing `\nworktree-tree <sha>` overrides the tree that gets restored. | Metadata is JSON, validated field by field on load; the header must name the ref's own id. |
| Low | The ref name includes the session id without validation (`isSafeId` exists but is unused). | Ids are sanitised and validated before any ref is written or deleted. |
| Low | The diff preview compares the checkpoint with `HEAD`, not with the current files. | Preview diffs a fresh snapshot of the current files against the checkpoint. |
| Low | In `/rewind`, "Undo last rewind" restores, pushes a new safety checkpoint, then pops that new one, leaving the old entry on the stack. | Undo restores the newest safety checkpoint and then deletes it. The undo stack is rebuilt from refs, so it survives `/reload`. |
| Low | The `escape escape` shortcut is not a valid Pi 1.3.0 key id, so the quick rewind never fires. Pi's built-in double-Escape opens `/tree` instead. | No shortcut is registered. Double-Escape → `/tree` → this package's restore prompt gives the same quick rewind. |
| Low | The conversation restore in `/rewind` calls `navigateTree`, which fires `session_before_tree`, so the user is asked a second time. | That prompt is suppressed during the package's own navigation. |
| Info | Snapshots copy untracked, non-ignored files (under 10 MiB) into the repository's object store. Refs under `refs/pi-checkpoints/` are not pushed by default, and objects become unreachable when refs are pruned (git gc removes them later). Anything secret should be gitignored. | Documented here. `.env` is also among the skipped names. |
| Info | Git runs in the repository, so repository-level git config (e.g. `core.fsmonitor`) applies, as it does for any git command there. No hooks run: `commit-tree`, `update-ref` and `read-tree` do not trigger hooks. | Unchanged. |

## Spec

**Repository.** On every `session_start`, find the git work tree containing the cwd. Outside
one, the extension is inactive and the status is cleared. Otherwise load existing checkpoints,
take a **resume** checkpoint (`Session start`), show the status, and prune in the background.

**Snapshots** never touch the real index, HEAD or files. A temporary index is seeded from the
current index tree; every changed tracked path and every eligible untracked file is applied
to it, and its tree is written. Untracked files are left out when gitignored, under a
directory named `node_modules`, `.venv`, `venv`, `env`, `.env`, `dist`, `build`,
`.pytest_cache`, `.mypy_cache`, `.cache`, `.tox` or `__pycache__`, larger than 10 MiB, or in a
directory holding 200 or more of them directly. Each snapshot records branch (null when
detached), HEAD (null before the first commit), index tree, worktree tree, untracked files
present, and skipped files and directories.

**Checkpoints** are stored as parentless commits of the worktree tree, with JSON metadata in
the message, at `refs/pi-checkpoints/<trigger>-<session>-<time>-<n>`. Triggers: `resume`,
`turn`, `before-restore`. A checkpoint is skipped when the worktree and index trees equal the
session's latest one. All git work for a session runs one operation at a time.

**Turn checkpoints.** A turn that ran `write`, `edit` or `bash` gets a checkpoint at
`turn_end`, described as `"<prompt, 60 chars>" → write → a.ts, bash: <command, 50 chars>`
(or `Turn n`). Failures never interrupt the agent.

**Restore** (files): refused when the current branch differs from the checkpoint's. Saves a
`before-restore` checkpoint first and aborts if that fails. Then sets worktree and index to
the checkpoint's worktree tree, deletes untracked, non-gitignored files created since (except
under ignored names, skipped files and skipped directories), and sets the index back to the
checkpoint's index tree. HEAD never moves.

**Undo** restores the newest `before-restore` checkpoint of the session, then deletes it.

**`/rewind`**: a picker of up to 25 checkpoints, newest first, labelled
`#n [HH:MM:SS] [branch] description` (`⚠️ branch` when it differs), with `↩ Undo last rewind`
on top when available. Picking a checkpoint from another branch is refused. Otherwise, when
files differ or HEAD has moved, a confirm shows the `diff-tree --stat` (2000 chars) and a HEAD
note. Then choose: all (files + conversation), files only, conversation only, or cancel.
Conversation restore moves the session tree to the newest entry at or before the checkpoint's
time, with a summary of the abandoned branch.

**`/fork`** (`session_before_fork`, UI only): offers conversation only, all, code only
(`skipConversationRestore`), undo (cancels the fork), cancel. Uses the newest checkpoint at or
before the fork entry, or the oldest. A failed file restore cancels the fork.

**`/tree`** (`session_before_tree`, UI only; Pi's double-Escape by default): offers keep
files, restore files to that point, undo (cancels navigation), cancel navigation.

**Status** (`rewind`): `◆ n checkpoints` while active.

**Pruning** after each turn checkpoint and at session start: per session keep the newest 50
(not counting `before-restore`); delete other sessions' checkpoints older than 7 days.

**Shutdown** waits for queued git work.
