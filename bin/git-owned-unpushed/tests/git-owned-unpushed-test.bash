#!/usr/bin/env bash
set -euo pipefail

# The suite commits in throwaway repositories. A global commit.gpgsign=true would
# sign every one of them and abort the run wherever the key is absent.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="${TOOL_DIR}/git-owned-unpushed"
TEST_DIR="$(mktemp -d)"
SCAN_ROOT="${TEST_DIR}/scan"
XDG_CONFIG_HOME="${TEST_DIR}/xdg-config"

cleanup() {
  rm -rf "${TEST_DIR}"
}
trap cleanup EXIT

mkdir -p "${SCAN_ROOT}" "${XDG_CONFIG_HOME}/gh"
cat >"${XDG_CONFIG_HOME}/gh/hosts.yml" <<'EOF'
github.com:
    git_protocol: ssh
    users:
        bengous: {}
    user: bengous
EOF

export XDG_CONFIG_HOME

last_status=0
last_stdout=""
last_stderr=""

# Runs the scanner in the current shell so stdout, stderr, and exit code survive.
scan() {
  local stderr_file="${TEST_DIR}/stderr"

  last_status=0
  last_stdout="$(bun "${ENTRYPOINT}" "$@" 2>"${stderr_file}")" || last_status=$?
  last_stderr="$(cat "${stderr_file}")"
}

git_init() {
  local repo="$1"

  git -C "${repo}" init --quiet
  git -C "${repo}" config user.email "test@example.com"
  git -C "${repo}" config user.name "Test User"
  # Keeps remote.origin.url a GitHub URL for ownership while --fetch and --verify stay offline.
  git -C "${repo}" config "url.${TEST_DIR}/.insteadOf" "git@github.com:bengous/"
  git -C "${repo}" checkout -b main --quiet
  printf 'initial\n' >"${repo}/file.txt"
  git -C "${repo}" add file.txt
  git -C "${repo}" commit --quiet -m "initial"
}

make_bare_remote() {
  local remote="$1"

  git init --bare --quiet "${remote}"
  # Pins what `git remote set-head --auto` reads, whatever init.defaultBranch says here.
  git -C "${remote}" symbolic-ref HEAD refs/heads/main
}

make_owned_ahead_repo() {
  local repo="${SCAN_ROOT}/owned-ahead"
  local remote="${TEST_DIR}/owned-ahead.git"

  mkdir -p "${repo}"
  git_init "${repo}"
  make_bare_remote "${remote}"
  git -C "${repo}" remote add origin "git@github.com:bengous/owned-ahead.git"
  git -C "${repo}" remote set-url --push origin "${remote}"
  git -C "${repo}" push --quiet -u origin main
  printf 'local\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "local"
  git -C "${repo}" branch --quiet side-experiment
}

make_stale_refs_repo() {
  local repo="${SCAN_ROOT}/stale-refs"
  local remote="${TEST_DIR}/stale-refs.git"
  local base

  mkdir -p "${repo}"
  git_init "${repo}"
  make_bare_remote "${remote}"
  git -C "${repo}" remote add origin "git@github.com:bengous/stale-refs.git"
  git -C "${repo}" push --quiet -u origin main
  base="$(git -C "${repo}" rev-parse main)"
  printf 'pushed\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "pushed"
  git -C "${repo}" push --quiet origin main
  # The work reached the remote; rewinding the tracking ref leaves only this clone behind.
  git -C "${repo}" update-ref refs/remotes/origin/main "${base}"
}

make_stale_head_repo() {
  local repo="${SCAN_ROOT}/stale-head"
  local remote="${TEST_DIR}/stale-head.git"

  mkdir -p "${repo}"
  git_init "${repo}"
  make_bare_remote "${remote}"
  git -C "${repo}" remote add origin "git@github.com:bengous/stale-head.git"
  git -C "${repo}" push --quiet -u origin main
  git -C "${repo}" checkout -b feature/stale-side --quiet
  printf 'side\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "side"
  git -C "${repo}" push --quiet -u origin feature/stale-side
  printf 'more side\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "more side"
  git -C "${repo}" checkout main --quiet
  # A remote that renamed its default branch leaves this symref pointing at a ref that no longer exists.
  git -C "${repo}" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master
}

make_owned_synced_repo() {
  local repo="${SCAN_ROOT}/owned-synced"
  local remote="${TEST_DIR}/owned-synced.git"

  mkdir -p "${repo}"
  git_init "${repo}"
  make_bare_remote "${remote}"
  git -C "${repo}" remote add origin "https://github.com/bengous/owned-synced.git"
  git -C "${repo}" remote set-url --push origin "${remote}"
  git -C "${repo}" push --quiet -u origin main
}

make_default_branch_repo() {
  local repo="${SCAN_ROOT}/default-branch"
  local remote="${TEST_DIR}/default-branch.git"

  mkdir -p "${repo}"
  git_init "${repo}"
  make_bare_remote "${remote}"
  git -C "${repo}" remote add origin "git@github.com:bengous/default-branch.git"
  git -C "${repo}" push --quiet -u origin main
  git -C "${repo}" checkout -b feature/side --quiet
  printf 'side\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "side"
  git -C "${repo}" push --quiet -u origin feature/side
  printf 'more side\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "more side"
  git -C "${repo}" checkout main --quiet
  printf 'local\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "local"
  # git clone writes this ref; a repo built by init plus remote add needs it spelled out.
  git -C "${repo}" remote set-head origin main
}

make_no_default_repo() {
  local repo="${SCAN_ROOT}/no-default"
  local remote="${TEST_DIR}/no-default.git"

  mkdir -p "${repo}"
  git_init "${repo}"
  make_bare_remote "${remote}"
  git -C "${repo}" remote add origin "git@github.com:bengous/no-default.git"
  git -C "${repo}" push --quiet -u origin main
  git -C "${repo}" checkout -b feature/orphan --quiet
  printf 'orphan\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "orphan"
  git -C "${repo}" push --quiet -u origin feature/orphan
  printf 'unpushed\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "unpushed"
  git -C "${repo}" checkout main --quiet
}

make_external_repo() {
  local repo="${SCAN_ROOT}/external"

  mkdir -p "${repo}"
  git_init "${repo}"
  git -C "${repo}" remote add origin "https://github.com/other/external.git"
}

make_local_only_repo() {
  local repo="${SCAN_ROOT}/local-only"

  mkdir -p "${repo}"
  git_init "${repo}"
}

make_archived_local_only_repo() {
  local repo="${SCAN_ROOT}/archive/local-only"

  mkdir -p "${repo}"
  git_init "${repo}"
}

make_no_upstream_repo() {
  local repo="${SCAN_ROOT}/no-upstream"

  mkdir -p "${repo}"
  git_init "${repo}"
  git -C "${repo}" remote add origin "ssh://git@github.com/bengous/no-upstream.git"
}

make_worktree_repo() {
  local repo="${SCAN_ROOT}/worktree-base"
  local wt="${SCAN_ROOT}/worktree-copy"
  local remote="${TEST_DIR}/worktree.git"

  mkdir -p "${repo}"
  git_init "${repo}"
  make_bare_remote "${remote}"
  git -C "${repo}" remote add origin "git@github.com:bengous/worktree.git"
  git -C "${repo}" remote set-url --push origin "${remote}"
  git -C "${repo}" push --quiet -u origin main
  git -C "${repo}" worktree add --quiet -b feature "${wt}" main
  git -C "${wt}" branch --quiet --set-upstream-to=origin/main feature
  printf 'worktree\n' >>"${wt}/file.txt"
  git -C "${wt}" commit --quiet -am "worktree"
}

make_dangling_worktree_entry() {
  local entry="${SCAN_ROOT}/dangling"

  mkdir -p "${entry}"
  printf 'gitdir: %s/vanished/.git/worktrees/dangling\n' "${TEST_DIR}" >"${entry}/.git"
}

# Lives outside SCAN_ROOT: the owned remote is not `origin`, so a bare `git fetch` would hit the wrong one.
make_two_remotes_repo() {
  local repo="${TEST_DIR}/two-remotes"
  local owned="${TEST_DIR}/two-remotes.git"
  local foreign="${TEST_DIR}/two-remotes-foreign.git"
  local base

  mkdir -p "${repo}"
  git_init "${repo}"
  make_bare_remote "${owned}"
  make_bare_remote "${foreign}"
  git -C "${repo}" remote add origin "${foreign}"
  git -C "${repo}" remote add github "git@github.com:bengous/two-remotes.git"
  git -C "${repo}" push --quiet -u github main
  base="$(git -C "${repo}" rev-parse main)"
  printf 'pushed\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "pushed"
  git -C "${repo}" push --quiet github main
  git -C "${repo}" update-ref refs/remotes/github/main "${base}"
  git -C "${repo}" checkout -b mirror --quiet
  git -C "${repo}" push --quiet -u origin mirror
  printf 'mirror\n' >>"${repo}/file.txt"
  git -C "${repo}" commit --quiet -am "mirror"
  # HEAD on a branch without upstream is the case where git's own fetch default falls back to origin.
  git -C "${repo}" checkout -b scratch --quiet
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local name="$3"

  if [[ "${haystack}" != *"${needle}"* ]]; then
    printf 'FAIL %s: expected "%s" in output:\n%s\n' "${name}" "${needle}" "${haystack}" >&2
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local name="$3"

  if [[ "${haystack}" == *"${needle}"* ]]; then
    printf 'FAIL %s: did not expect "%s" in output:\n%s\n' "${name}" "${needle}" "${haystack}" >&2
    exit 1
  fi
}

assert_status() {
  local expected="$1"
  local name="$2"

  if [[ "${last_status}" -ne "${expected}" ]]; then
    printf 'FAIL %s: expected exit %s, got %s\nstderr:\n%s\n' "${name}" "${expected}" "${last_status}" "${last_stderr}" >&2
    exit 1
  fi
}

make_owned_ahead_repo
make_stale_refs_repo
make_default_branch_repo
make_no_default_repo
make_stale_head_repo
make_owned_synced_repo
make_external_repo
make_local_only_repo
make_archived_local_only_repo
make_no_upstream_repo
make_worktree_repo
make_dangling_worktree_entry
make_two_remotes_repo

scan "${SCAN_ROOT}"
output="${last_stdout}"
assert_status 10 "findings exit 10"
assert_contains "${output}" "AHEAD        ${SCAN_ROOT}/owned-ahead branch=main ahead=1 upstream=origin/main last-fetch=never" "owned ahead dates its refs"
assert_contains "${output}" "AHEAD        ${SCAN_ROOT}/stale-refs branch=main ahead=1 upstream=origin/main last-fetch=never" "stale tracking ref reads as ahead"
assert_contains "${output}" "LOCAL_ONLY   ${SCAN_ROOT}/local-only" "local only"
assert_contains "${output}" "LOCAL_ONLY   ${SCAN_ROOT}/archive/local-only" "archived local only without exclude"
assert_contains "${output}" "NO_UPSTREAM  ${SCAN_ROOT}/no-upstream branch=main" "no upstream on HEAD"
assert_contains "${output}" "AHEAD        ${SCAN_ROOT}/default-branch branch=main ahead=1" "default branch shown"
assert_not_contains "${output}" "branch=feature/side" "pushed branch that is not the default hidden by default"
assert_contains "${output}" "AHEAD        ${SCAN_ROOT}/no-default branch=feature/orphan ahead=1" "no origin/HEAD falls back to every pushed branch"
assert_not_contains "${output}" "side-experiment" "unpushed side branch hidden by default"
assert_not_contains "${output}" "${SCAN_ROOT}/worktree-copy" "worktree hidden by default"
assert_not_contains "${output}" "${SCAN_ROOT}/worktree-base branch=feature " "branch living in a worktree hidden by default"
assert_not_contains "${output}" "${SCAN_ROOT}/external" "external ignored"
assert_not_contains "${output}" "${SCAN_ROOT}/owned-synced" "synced ignored"
assert_not_contains "${output}" "${SCAN_ROOT}/dangling" "dangling .git entry is not a finding"
assert_contains "${last_stderr}" "3 branches hidden in 3 repos (--all to show)" "hidden summary"
assert_contains "${last_stderr}" "1 .git entries are not repositories" "dangling summary"

assert_contains "${output}" "AHEAD        ${SCAN_ROOT}/stale-head branch=feature/stale-side ahead=1" "dangling origin/HEAD reads as unknown and keeps the wider rule"

scan --fetch "${SCAN_ROOT}/stale-head"
assert_status 0 "--fetch on stale-head exit 0"
assert_contains "${last_stderr}" "1 repos fetched" "--fetch fetched stale-head"
assert_not_contains "${last_stdout}" "branch=feature/stale-side" "--fetch corrected origin/HEAD, so the side branch is hidden"
assert_contains "${last_stderr}" "1 branches hidden in 1 repos" "--fetch counts the side branch as hidden"
stale_head_target="$(git -C "${SCAN_ROOT}/stale-head" symbolic-ref refs/remotes/origin/HEAD)"
if [[ "${stale_head_target}" != "refs/remotes/origin/main" ]]; then
  printf 'FAIL --fetch corrects origin/HEAD: expected refs/remotes/origin/main, got %s\n' "${stale_head_target}" >&2
  exit 1
fi

scan --all "${SCAN_ROOT}"
with_all="${last_stdout}"
assert_status 10 "--all exit 10"
assert_contains "${with_all}" "NO_UPSTREAM  ${SCAN_ROOT}/owned-ahead branch=side-experiment" "--all reveals side branch"
assert_contains "${with_all}" "AHEAD        ${SCAN_ROOT}/default-branch branch=feature/side ahead=1" "--all reveals the non-default branch"
assert_contains "${with_all}" "TRACKS_OTHER ${SCAN_ROOT}/worktree-base branch=feature ahead=1 upstream=origin/main" "--all reveals worktree branch from base"
assert_not_contains "${last_stderr}" "hidden" "--all hides nothing"

scan --worktrees "${SCAN_ROOT}"
with_worktrees="${last_stdout}"
assert_status 10 "--worktrees exit 10"
assert_contains "${with_worktrees}" "TRACKS_OTHER ${SCAN_ROOT}/worktree-copy branch=feature ahead=1 upstream=origin/main" "worktree flag"
assert_not_contains "${with_worktrees}" "${SCAN_ROOT}/worktree-base branch=feature" "base delegates the worktree branch"

scan --json "${SCAN_ROOT}"
as_json="${last_stdout}"
assert_status 10 "--json exit 10"
assert_contains "${as_json}" "\"root\":\"${SCAN_ROOT}/owned-ahead\"" "json repo"
assert_contains "${as_json}" '"name":"side-experiment","checkout":{"kind":"none"},"upstream":{"kind":"none"}' "json branch"
assert_contains "${as_json}" '"visibility":"hidden"' "json visibility"
assert_not_contains "${as_json}" "${SCAN_ROOT}/owned-synced" "json skips clean repos"

scan --verify "${SCAN_ROOT}"
verified="${last_stdout}"
assert_status 10 "--verify exit 10"
assert_not_contains "${verified}" "${SCAN_ROOT}/stale-refs" "--verify clears the stale ahead"
assert_contains "${verified}" "AHEAD        ${SCAN_ROOT}/owned-ahead branch=main ahead=1 upstream=origin/main" "--verify keeps genuine unpushed work"
assert_not_contains "${verified}" "last-fetch=" "--verify drops the age it just settled"
assert_not_contains "${verified}" "branch=feature/orphan" "--verify learns origin/HEAD and hides the non-default branch"
assert_contains "${last_stderr}" "4 repos fetched" "--verify fetches only repos with a remote finding"

scan --fetch --verify "${SCAN_ROOT}"
assert_status 2 "--fetch with --verify exit 2"
assert_contains "${last_stderr}" "--verify cannot narrow that" "--fetch with --verify message"

scan --fetch --all "${TEST_DIR}/two-remotes"
assert_status 10 "--fetch with a non-origin owned remote exit 10"
assert_contains "${last_stderr}" "1 repos fetched" "--fetch fetched the owned remote"
assert_not_contains "${last_stdout}" "branch=main" "--fetch refreshed github, not origin, so the rewound main reads synced"
assert_contains "${last_stdout}" "AHEAD        ${TEST_DIR}/two-remotes branch=mirror ahead=1 upstream=origin/mirror last-fetch=0d" "a branch on another remote keeps the age of its refs"
assert_contains "${last_stdout}" "NO_UPSTREAM  ${TEST_DIR}/two-remotes branch=scratch" "the checked-out branch stays reported"

mkdir -p "${XDG_CONFIG_HOME}/git-owned-unpushed"
cat >"${XDG_CONFIG_HOME}/git-owned-unpushed/exclude" <<EOF
  # Comments and blank lines are ignored.

${SCAN_ROOT}/archive
EOF

scan "${SCAN_ROOT}"
with_exclude="${last_stdout}"
assert_not_contains "${with_exclude}" "${SCAN_ROOT}/archive/local-only" "excluded archived local only"
assert_contains "${with_exclude}" "LOCAL_ONLY   ${SCAN_ROOT}/local-only" "non-excluded local only still visible"
assert_contains "${with_exclude}" "AHEAD        ${SCAN_ROOT}/owned-ahead" "non-excluded ahead still visible"

printf '/\n' >"${XDG_CONFIG_HOME}/git-owned-unpushed/exclude"
scan "${SCAN_ROOT}"
with_root_exclude="${last_stdout}"
assert_status 0 "root exclude exit 0"
if [[ -n "${with_root_exclude}" ]]; then
  printf 'FAIL root exclude: expected empty output, got:\n%s\n' "${with_root_exclude}" >&2
  exit 1
fi

SEALED_ROOT="${TEST_DIR}/sealed-root"
mkdir -p "${SEALED_ROOT}/sealed"
chmod 000 "${SEALED_ROOT}/sealed"
printf '/nowhere\n' >"${XDG_CONFIG_HOME}/git-owned-unpushed/exclude"
scan "${SEALED_ROOT}"
assert_status 20 "unreadable directory exit 20"
assert_contains "${last_stderr}" "unreadable: " "unreadable directory reported on stderr"
assert_contains "${last_stderr}" "${SEALED_ROOT}/sealed" "unreadable directory named on stderr"
assert_contains "${last_stderr}" "1 directories unreadable" "unreadable summary"
printf '%s\n' "${SEALED_ROOT}/sealed" >"${XDG_CONFIG_HOME}/git-owned-unpushed/exclude"
scan "${SEALED_ROOT}"
assert_status 0 "excluded unreadable directory exit 0"
assert_not_contains "${last_stderr}" "unreadable" "exclusion skips the directory before reading it"
chmod 755 "${SEALED_ROOT}/sealed"

scan --jobs 0 "${SCAN_ROOT}"
assert_status 2 "usage error exit 2"

scan --owner "bad login" "${SCAN_ROOT}"
assert_status 2 "invalid --owner exit 2"
assert_contains "${last_stderr}" "--owner: expected a GitHub login" "invalid --owner message"

printf '/\n' >"${XDG_CONFIG_HOME}/git-owned-unpushed/exclude"
rm "${XDG_CONFIG_HOME}/git-owned-unpushed/exclude"
scan --owner other "${SCAN_ROOT}"
assert_status 10 "--owner exit 10"
assert_not_contains "${last_stdout}" "${SCAN_ROOT}/owned-ahead" "--owner other makes owned repos foreign"
assert_contains "${last_stdout}" "LOCAL_ONLY   ${SCAN_ROOT}/local-only" "--owner keeps local-only findings"

GIT_OWNED_UNPUSHED_OWNER=other scan "${SCAN_ROOT}"
assert_not_contains "${last_stdout}" "${SCAN_ROOT}/owned-ahead" "env owner makes owned repos foreign"

GIT_OWNED_UNPUSHED_OWNER=other scan --owner bengous "${SCAN_ROOT}"
assert_contains "${last_stdout}" "AHEAD        ${SCAN_ROOT}/owned-ahead" "flag wins over env owner"

OLD_GIT="${TEST_DIR}/old-git"
mkdir -p "${OLD_GIT}"
printf '#!/usr/bin/env bash\nprintf "git version 2.20.0\\n"\n' >"${OLD_GIT}/git"
chmod +x "${OLD_GIT}/git"
PATH="${OLD_GIT}:${PATH}" scan "${SCAN_ROOT}"
assert_status 30 "old git exit 30"
assert_contains "${last_stderr}" "git >=2.23.0 is required" "old git message"
assert_contains "${last_stderr}" "found 2.20.0" "old git reports the found version"

rm "${XDG_CONFIG_HOME}/gh/hosts.yml"
scan "${SCAN_ROOT}"
assert_status 30 "missing gh login exit 30"
assert_contains "${last_stderr}" "pass --owner LOGIN, set GIT_OWNED_UNPUSHED_OWNER, or run \"gh auth login\"" "missing gh login message"

printf 'git-owned-unpushed tests passed\n'
