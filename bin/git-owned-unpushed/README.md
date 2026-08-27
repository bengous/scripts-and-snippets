# git-owned-unpushed

Find local Git repositories that belong to your GitHub account and still hold
work you never pushed.

Needs [bun](https://bun.com) and git ≥ 2.23.

```sh
git-owned-unpushed                      # scan $HOME
git-owned-unpushed --owner octocat      # or set $GIT_OWNED_UNPUSHED_OWNER; falls back to gh's hosts.yml
git-owned-unpushed --all ~/code         # include branches hidden by the default view
git-owned-unpushed --verify             # fetch the repos that reported something, then re-check
git-owned-unpushed --help               # every flag, with the exclusion file format
```

## What it reports

The default view keeps the branch you have checked out and the branch the remote
calls default. Side branches, deleted upstreams, and branches living in another
worktree are counted, not listed, until you pass `--all`.

Counts come from remote-tracking refs, which go stale. Every line derived from
one states the age of the last fetch, and `--verify` settles them without
fetching the whole machine.

## Notes

Exit codes: `0` clean, `10` work to push, `20` the scan is incomplete, `30`
cannot run, `2` usage. `--json` prints one object per repo instead.

The entrypoint imports `cli.ts` and `model.ts` from this directory, so keep them
together. Reading `gh`'s `hosts.yml` needs Bun ≥ 1.2.21; `--owner` and
`$GIT_OWNED_UNPUSHED_OWNER` work without it.
