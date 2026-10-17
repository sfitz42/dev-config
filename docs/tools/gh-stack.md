# gh + gh-stack

**Last reviewed: 2026-10-16.** Config: `config/gh/config.yml` (linked). Authentication
(`hosts.yml`) is never tracked.

**Platform:** any Unix (macOS and Linux).

## gh

Settings kept: HTTPS for git operations and one alias, `gh co` = `gh pr checkout`.

## gh-stack

The `github/gh-stack` extension (v0.2.1 when reviewed) manages **stacked pull requests**: a chain of
PRs where each builds on the previous one, so a large change is reviewed in small pieces.

```sh
gh extension install github/gh-stack     # done by scripts/dotfiles packages
gh stack init                            # start a stack on the default branch
gh stack add <branch>                    # add a branch on top
gh stack push                            # push the stack's branches
gh stack submit                          # create/update the PRs
gh stack sync                            # sync with the remote
gh stack rebase                          # rebase the stack
gh stack checkout <number|PR|branch>     # jump to a stack
gh stack view                            # show the stack
gh stack up | down | top | bottom        # move around it
```

Docs: <https://gh.io/stacks>. Commonly used here: `push`, `rebase`, `sync`, `checkout`, with
`gh pr create --draft` for one-off PRs.

> [!WARNING]
> **Gotchas**
>
> - Check `gh stack rebase --help` before running it on a stack others have reviewed.
> - The extension is pre-1.0; check `gh stack --help` after upgrades.
