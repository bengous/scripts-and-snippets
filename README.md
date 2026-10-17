# scripts-and-snippets

Small standalone scripts I use every day, and snippets worth keeping around.
Each one solves a single problem and has no dependency beyond the tool it wraps.

## Scripts

| Script | Needs | What it does |
| --- | --- | --- |
| [`git-ignore-local`](bin/git-ignore-local/) | bash, git | Creates `.gitignore.local` in a repo root, linked to Git's `info/exclude`, so you can ignore files locally without touching `.gitignore`. |

Each script owns one directory under `bin/`, holding its entrypoint, any module
it imports, its tests, and its own README. Follow a link above for the detail.

## Install

Clone the repo and put each script's directory on your `PATH`:

```sh
git clone https://github.com/bengous/scripts-and-snippets.git
for dir in "$PWD"/scripts-and-snippets/bin/*/; do
    PATH="${dir%/}:$PATH"
done
export PATH
```

Or symlink one entrypoint and leave its directory where it is:

```sh
ln -s "$PWD/scripts-and-snippets/bin/git-ignore-local/git-ignore-local" ~/.local/bin/
```

A script named `git-*` on your `PATH` also works as a Git subcommand:
`git ignore-local`.

## Snippets

Fragments to copy and adapt live in [`snippets/`](snippets/). They are not
meant to be installed.

## Vendoring and contributing

Copy any `bin/<script>/` directory into your own repository and change it. That
is a fine way to use this, and no attribution is required beyond the license.

I develop these scripts elsewhere and publish them here, so pull requests do not
reach the source. Open an issue instead: bug reports, a case the script gets
wrong, or a flag you want. Include the command you ran and what it printed.

## License

MIT. See [LICENSE](LICENSE).
