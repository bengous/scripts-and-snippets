#!/usr/bin/env bash
set -euo pipefail

# The suite commits in throwaway repositories. A global commit.gpgsign=true would
# sign every one of them and abort the run wherever the key is absent.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZONE="$(cd "${TOOL_DIR}/../.." && pwd)"
SCRIPT="${TOOL_DIR}/git-ignore-local"
TEST_ROOT="${ZONE}/.artifacts/git-ignore-local-test-${BASHPID}"

cleanup() {
  case "${TEST_ROOT}" in
    "${ZONE}/.artifacts/git-ignore-local-test-"*) rm -rf -- "${TEST_ROOT}" ;;
    *) printf 'Refusing to remove unexpected test path: %s\n' "${TEST_ROOT}" >&2 ;;
  esac
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_equals() {
  local actual="$1"
  local expected="$2"
  local label="$3"

  [[ "${actual}" == "${expected}" ]] ||
    fail "${label}: expected '${expected}', got '${actual}'"
}

assert_contains() {
  local output="$1"
  local expected="$2"

  [[ "${output}" == *"${expected}"* ]] ||
    fail "expected output to contain '${expected}'"
}

new_repo() {
  local path="$1"

  mkdir -p "${path}"
  git -C "${path}" init --quiet
  git -C "${path}" config user.name "Git Ignore Local Test"
  git -C "${path}" config user.email "git-ignore-local-test@example.invalid"
  printf 'tracked\n' >"${path}/tracked"
  git -C "${path}" add tracked
  git -C "${path}" commit --quiet -m "test fixture"
}

mkdir -p "${TEST_ROOT}"

help_output="$("${SCRIPT}" --help)"
assert_contains "${help_output}" "Usage: git-ignore-local [--help]"

set +e
unknown_output="$("${SCRIPT}" --unknown 2>&1)"
unknown_status=$?
set -e
assert_equals "${unknown_status}" "2" "unknown argument status"
assert_contains "${unknown_output}" "unknown argument: --unknown"

outside="${TEST_ROOT}/outside"
mkdir -p "${outside}"
set +e
outside_output="$(cd "${outside}" && GIT_CEILING_DIRECTORIES="${TEST_ROOT}" "${SCRIPT}" 2>&1)"
outside_status=$?
set -e
assert_equals "${outside_status}" "1" "outside repository status"
assert_contains "${outside_output}" "not inside a Git working tree"

normal_repo="${TEST_ROOT}/normal repo"
new_repo "${normal_repo}"
mkdir -p "${normal_repo}/nested directory"
first_output="$(cd "${normal_repo}/nested directory" && "${SCRIPT}")"
assert_contains "${first_output}" "configured .gitignore.local -> .git/info/exclude"
assert_equals "$(readlink "${normal_repo}/.gitignore.local")" ".git/info/exclude" "normal link target"
[[ "${normal_repo}/.gitignore.local" -ef "${normal_repo}/.git/info/exclude" ]] ||
  fail "normal link does not resolve to info/exclude"
assert_equals "$(grep -Fxc '/.gitignore.local' "${normal_repo}/.git/info/exclude")" "1" "exclude entry count"
assert_equals "$(git -C "${normal_repo}" status --short --untracked-files=all)" "" "normal repository status"

exclude_before="$(<"${normal_repo}/.git/info/exclude")"
second_output="$(cd "${normal_repo}" && "${SCRIPT}")"
exclude_after="$(<"${normal_repo}/.git/info/exclude")"
assert_contains "${second_output}" ".gitignore.local already configured"
assert_equals "${exclude_after}" "${exclude_before}" "idempotent exclude content"

file_conflict_repo="${TEST_ROOT}/file conflict"
new_repo "${file_conflict_repo}"
printf '# baseline\n' >"${file_conflict_repo}/.git/info/exclude"
printf 'keep me\n' >"${file_conflict_repo}/.gitignore.local"
set +e
file_conflict_output="$(cd "${file_conflict_repo}" && "${SCRIPT}" 2>&1)"
file_conflict_status=$?
set -e
assert_equals "${file_conflict_status}" "1" "file conflict status"
assert_contains "${file_conflict_output}" "path exists and is not a symbolic link"
assert_equals "$(<"${file_conflict_repo}/.git/info/exclude")" "# baseline" "file conflict exclude content"
assert_equals "$(<"${file_conflict_repo}/.gitignore.local")" "keep me" "file conflict local content"

link_conflict_repo="${TEST_ROOT}/link conflict"
new_repo "${link_conflict_repo}"
printf '# baseline\n' >"${link_conflict_repo}/.git/info/exclude"
ln -s "elsewhere" "${link_conflict_repo}/.gitignore.local"
set +e
link_conflict_output="$(cd "${link_conflict_repo}" && "${SCRIPT}" 2>&1)"
link_conflict_status=$?
set -e
assert_equals "${link_conflict_status}" "1" "link conflict status"
assert_contains "${link_conflict_output}" "points to 'elsewhere', expected '.git/info/exclude'"
assert_equals "$(<"${link_conflict_repo}/.git/info/exclude")" "# baseline" "link conflict exclude content"
assert_equals "$(readlink "${link_conflict_repo}/.gitignore.local")" "elsewhere" "preserved link target"

worktree_repo="${TEST_ROOT}/worktree source"
linked_worktree="${TEST_ROOT}/linked worktree"
new_repo "${worktree_repo}"
git -C "${worktree_repo}" worktree add --quiet -b test-linked "${linked_worktree}"
mkdir -p "${linked_worktree}/nested"
worktree_output="$(cd "${linked_worktree}/nested" && "${SCRIPT}")"
worktree_exclude="$(git -C "${linked_worktree}" rev-parse --git-path info/exclude)"
assert_contains "${worktree_output}" "configured .gitignore.local -> ${worktree_exclude}"
assert_equals "$(readlink "${linked_worktree}/.gitignore.local")" "${worktree_exclude}" "worktree link target"
[[ "${linked_worktree}/.gitignore.local" -ef "${worktree_exclude}" ]] ||
  fail "worktree link does not resolve to shared info/exclude"
assert_equals "$(grep -Fxc '/.gitignore.local' "${worktree_exclude}")" "1" "worktree exclude entry count"
assert_equals "$(git -C "${linked_worktree}" status --short --untracked-files=all)" "" "linked worktree status"

printf 'git-ignore-local tests passed\n'
