#!/usr/bin/env bash
# The single definition of this repository's gate: its CI, the dotfiles CI and
# the dotfiles pre-push hook all call this script, so none of them can drift.
set -euo pipefail

ZONE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "${ZONE}"

step() {
  printf '\n==> %s\n' "$1"
}

# `shfmt -f` reads shebangs, so it reaches the extensionless git-ignore-local
# and leaves out git-owned-unpushed, which is a Bun script.
readarray -t shell_files < <(shfmt -f bin quality)
readarray -t bash_suites < <(find bin -type f -name '*-test.bash' | sort)

step "format"
bun run format:check

step "format, shell (${#shell_files[@]} files)"
bun run format:shell:check

step "lint"
bun run lint

step "typecheck"
bun run typecheck

step "shellcheck (${#shell_files[@]} files)"
bash -n -- "${shell_files[@]}"
shellcheck -- "${shell_files[@]}"

step "bun tests"
bun test

for suite in "${bash_suites[@]}"; do
  step "${suite}"
  bash -- "${suite}"
done

printf '\nAll checks passed.\n'
