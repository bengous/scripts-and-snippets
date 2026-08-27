# git-ignore-local

Ignore files in one clone without touching `.gitignore`.

Needs bash and git.

```sh
cd ~/some/repo
git-ignore-local            # or: git ignore-local
git-ignore-local --help
```

## What it does

Git already keeps a private ignore list per clone, `.git/info/exclude`. It is
never committed and never shared, but it sits somewhere you never look. This
command links it to `.gitignore.local` in the repository root and adds
`/.gitignore.local` to it, so the link ignores itself.

From then on you edit `.gitignore.local` like any other file. Nothing you write
there reaches `.gitignore`, and `git status` stays clean.

## Notes

Run it from any directory inside the working tree; the link lands at the root.

Git shares one exclude file across every worktree of a repository, so what you
ignore in one worktree is ignored in all of them.

Running it twice changes nothing and says so. If `.gitignore.local` already
exists and is not the link it expects, it stops rather than overwrite it.

Exit codes: `0` done, `1` cannot run, `2` usage.
