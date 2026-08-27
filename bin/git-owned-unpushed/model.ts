/** Pure model for git-owned-unpushed: brands, repo classification, focus policy, rendering. */

import { isAbsolute, normalize } from "node:path";

// ── Brands ──────────────────────────────────────────────────────────

declare const AbsolutePathBrand: unique symbol;
declare const GithubLoginBrand: unique symbol;
declare const RepoNameBrand: unique symbol;
declare const BranchNameBrand: unique symbol;
declare const RemoteNameBrand: unique symbol;
declare const PositiveIntBrand: unique symbol;
declare const UnixSecondsBrand: unique symbol;

/** Normalized absolute filesystem path without a trailing separator. */
export type AbsolutePath = string & { readonly [AbsolutePathBrand]: true };
/** GitHub account login as reported by `gh`. */
export type GithubLogin = string & { readonly [GithubLoginBrand]: true };
/** Repository name segment of a GitHub `owner/name` slug. */
export type RepoName = string & { readonly [RepoNameBrand]: true };
/** Local branch name as printed by `git for-each-ref --format=%(refname:short)`. */
export type BranchName = string & { readonly [BranchNameBrand]: true };
/** Git remote name such as `origin`. */
export type RemoteName = string & { readonly [RemoteNameBrand]: true };
/** Safe integer strictly greater than zero. */
export type PositiveInt = number & { readonly [PositiveIntBrand]: true };
/** Safe integer of seconds since the Unix epoch. */
export type UnixSeconds = number & { readonly [UnixSecondsBrand]: true };

const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const REF_NAME_FORBIDDEN = /[\s\0~^:?*[\\]|\.\.|@\{|^-|^@$|\.lock$|\/$|\.$/;
const REMOTE_NAME_FORBIDDEN = /[\s\0]/;

/** Single entry point to the `AbsolutePath` brand: every other cast is a defect. */
export function requireAbsolutePath(value: string, context: string): AbsolutePath {
    if (!isAbsolute(value)) {
        throw new Error(`${context}: expected an absolute path, got "${value}"`);
    }
    const normalized = normalize(value);
    const trimmed = normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    // SAFETY: `isAbsolute` held and the value was normalized; that is exactly what the brand denotes.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor, guarded above.
    return trimmed as AbsolutePath;
}

/** Single entry point to the `GithubLogin` brand: every other cast is a defect. */
export function requireGithubLogin(value: unknown, context: string): GithubLogin {
    if (typeof value !== "string" || !GITHUB_LOGIN_PATTERN.test(value)) {
        throw new Error(`${context}: expected a GitHub login, got "${String(value)}"`);
    }
    // SAFETY: the guard above proved `value` matches GITHUB_LOGIN_PATTERN.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor, guarded above.
    return value as GithubLogin;
}

/** Single entry point to the `RepoName` brand: every other cast is a defect. */
export function requireRepoName(value: string, context: string): RepoName {
    if (!REPO_NAME_PATTERN.test(value)) {
        throw new Error(`${context}: expected a repository name, got "${value}"`);
    }
    // SAFETY: the guard above proved `value` matches REPO_NAME_PATTERN.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor, guarded above.
    return value as RepoName;
}

/** Single entry point to the `BranchName` brand: every other cast is a defect. */
export function requireBranchName(value: string, context: string): BranchName {
    if (value.length === 0 || REF_NAME_FORBIDDEN.test(value)) {
        throw new Error(`${context}: expected a branch name, got "${value}"`);
    }
    // SAFETY: the guard above rejected every shape `git check-ref-format` rejects that this tool can meet.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor, guarded above.
    return value as BranchName;
}

/** Single entry point to the `RemoteName` brand: every other cast is a defect. */
export function requireRemoteName(value: string, context: string): RemoteName {
    if (value.length === 0 || REMOTE_NAME_FORBIDDEN.test(value)) {
        throw new Error(`${context}: expected a remote name, got "${value}"`);
    }
    // SAFETY: the guard above proved `value` is a non-empty name without whitespace or NUL.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor, guarded above.
    return value as RemoteName;
}

/** Single entry point to the `PositiveInt` brand: every other cast is a defect. */
export function requirePositiveInt(value: number, context: string): PositiveInt {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${context}: expected a positive integer, got ${String(value)}`);
    }
    // SAFETY: the guard above proved `value` is a safe integer greater than zero.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor, guarded above.
    return value as PositiveInt;
}

/** Single entry point to the `UnixSeconds` brand: every other cast is a defect. */
export function requireUnixSeconds(value: number, context: string): UnixSeconds {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${context}: expected Unix seconds, got ${String(value)}`);
    }
    // SAFETY: the guard above proved `value` is a non-negative safe integer.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor, guarded above.
    return value as UnixSeconds;
}

// ── Domain ──────────────────────────────────────────────────────────

export type Remote = { name: RemoteName; url: string };
export type GithubSlug = { owner: GithubLogin; name: RepoName };
export type GitStep = "rev-parse" | "config" | "for-each-ref";

export type Delta =
    | { kind: "synced" }
    | { kind: "gone" }
    | { kind: "ahead"; ahead: PositiveInt }
    | { kind: "behind"; behind: PositiveInt }
    | { kind: "diverged"; ahead: PositiveInt; behind: PositiveInt };

export type Upstream = { kind: "none" } | { kind: "tracked"; remote: RemoteName; branch: BranchName; delta: Delta };

/** Where a branch is checked out, relative to the repo being classified. */
export type Checkout = { kind: "none" } | { kind: "here" } | { kind: "elsewhere"; path: AbsolutePath };

export type Branch = {
    name: BranchName;
    checkout: Checkout;
    upstream: Upstream;
    lastCommitAt: UnixSeconds;
};

export type Worktree = { kind: "main" } | { kind: "linked"; commonRoot: AbsolutePath };

export type FetchOutcome =
    | { kind: "not-requested" }
    | { kind: "ok"; remote: RemoteName }
    | { kind: "failed"; message: string };

/** When the repo last fetched, from `.git/FETCH_HEAD`; `git clone` does not write that file. */
export type LastFetch = { kind: "never" } | { kind: "at"; at: UnixSeconds };

/**
 * The remote's default branch, from `refs/remotes/<remote>/HEAD`. Only `git clone`
 * and `git remote set-head` write that ref, so a repo built by `git init` plus
 * `git remote add` has none until its first fetch. A ref left pointing at a branch
 * the remote has since renamed is `unknown` too, not a wrong `known`.
 */
export type DefaultBranch = { kind: "unknown" } | { kind: "known"; branch: BranchName };

/**
 * How much to trust the remote refs a finding was computed from: `fetched` when
 * this run refreshed them, `on-disk` when it read whatever the last fetch left.
 */
export type Freshness = { kind: "fetched" } | { kind: "on-disk"; lastFetch: LastFetch };

export type Repo =
    | { kind: "error"; root: AbsolutePath; step: GitStep; message: string }
    | { kind: "not-a-repo"; root: AbsolutePath; message: string }
    | { kind: "linked-worktree"; root: AbsolutePath; commonRoot: AbsolutePath }
    | { kind: "local-only"; root: AbsolutePath; worktree: Worktree }
    | { kind: "foreign"; root: AbsolutePath; worktree: Worktree; remotes: readonly Remote[] }
    | {
          kind: "owned";
          root: AbsolutePath;
          worktree: Worktree;
          slug: GithubSlug;
          fetch: FetchOutcome;
          lastFetch: LastFetch;
          defaultBranch: DefaultBranch;
          branches: readonly Branch[];
      };

export type FocusOptions = { all: boolean; worktrees: boolean };

/**
 * `delegated`: the branch is checked out in a linked worktree that `--worktrees`
 * reports on its own, so it is neither shown here nor counted as hidden.
 */
export type Visibility = "shown" | "hidden" | "delegated";

/** The two deltas that make a branch tracking another name worth reporting. */
export type Drift = Extract<Delta, { kind: "ahead" | "diverged" }>;

/** Shared shape of every finding read off a remote-tracking ref, hence carrying that ref's freshness. */
type RemoteFinding = {
    root: AbsolutePath;
    branch: BranchName;
    remote: RemoteName;
    upstream: BranchName;
    freshness: Freshness;
};

export type Finding =
    | { kind: "LOCAL_ONLY"; root: AbsolutePath }
    | { kind: "NO_UPSTREAM"; root: AbsolutePath; branch: BranchName }
    | ({ kind: "GONE" } & RemoteFinding)
    | ({ kind: "AHEAD"; ahead: PositiveInt } & RemoteFinding)
    | ({ kind: "DIVERGED"; ahead: PositiveInt; behind: PositiveInt } & RemoteFinding)
    /**
     * The branch tracks an upstream of another name, so no remote copy carries its
     * commits and `git push` under the default `push.default=simple` refuses it. It
     * is NO_UPSTREAM with a base: the counts measure drift from that base, and the
     * work is as unpushed as any branch without an upstream.
     */
    | ({ kind: "TRACKS_OTHER"; drift: Drift } & RemoteFinding)
    | { kind: "FETCH_FAIL"; root: AbsolutePath; message: string }
    | { kind: "ERROR"; root: AbsolutePath; step: GitStep; message: string };

/** Findings computed from remote-tracking refs, which `--verify` re-fetches before trusting. */
export function dependsOnRemote(finding: Finding): boolean {
    return (
        finding.kind === "GONE" ||
        finding.kind === "AHEAD" ||
        finding.kind === "DIVERGED" ||
        finding.kind === "TRACKS_OTHER"
    );
}

export type Report = {
    findings: readonly Finding[];
    hiddenBranches: number;
    hiddenRepos: number;
    notRepos: number;
    fetchedRepos: number;
};

export type ExitCode = 0 | 10 | 20;

// ── Parsers ─────────────────────────────────────────────────────────

/** A `.git` entry git refuses: a dangling worktree pointer or a foreign tool's cache marker. */
export const NOT_A_REPO_PATTERN = /not a git repository|invalid gitfile format/;

const GITHUB_URL_PREFIXES = [
    "git@github.com:",
    "ssh://git@github.com/",
    "https://github.com/",
    "http://github.com/",
] as const;

export type RemoteTarget = { kind: "github"; slug: GithubSlug } | { kind: "other" };

/** Recognizes the four GitHub remote URL forms; anything else is `other`. */
export function parseRemoteUrl(url: string): RemoteTarget {
    const prefix = GITHUB_URL_PREFIXES.find((candidate) => url.startsWith(candidate));
    if (prefix === undefined) {
        return { kind: "other" };
    }
    const path = url
        .slice(prefix.length)
        .replace(/\.git$/, "")
        .replace(/\/$/, "");
    const segments = path.split("/");
    if (segments.length !== 2) {
        return { kind: "other" };
    }
    const [owner, name] = segments;
    if (
        owner === undefined ||
        name === undefined ||
        !GITHUB_LOGIN_PATTERN.test(owner) ||
        !REPO_NAME_PATTERN.test(name)
    ) {
        return { kind: "other" };
    }
    return {
        kind: "github",
        slug: { owner: requireGithubLogin(owner, `remote ${url}`), name: requireRepoName(name, `remote ${url}`) },
    };
}

const REMOTE_CONFIG_LINE = /^remote\.(.+)\.url (.+)$/;

/** Parses `git config --get-regexp '^remote\..*\.url$'` output. */
export function parseRemotesOutput(stdout: string): Remote[] {
    return stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
            const match = REMOTE_CONFIG_LINE.exec(line);
            if (match?.[1] === undefined || match[2] === undefined) {
                throw new Error(`unexpected git config line: "${line}"`);
            }
            return { name: requireRemoteName(match[1], "git config"), url: match[2] };
        });
}

export type OwnedRemote = { name: RemoteName; slug: GithubSlug };

/** Picks the first remote that belongs to `login`; its name addresses `refs/remotes/<name>/HEAD`. */
export function ownedRemote(remotes: readonly Remote[], login: GithubLogin): OwnedRemote | undefined {
    for (const remote of remotes) {
        const target = parseRemoteUrl(remote.url);
        if (target.kind === "github" && target.slug.owner === login) {
            return { name: remote.name, slug: target.slug };
        }
    }
    return undefined;
}

const TRACK_AHEAD = /^ahead (\d+)$/;
const TRACK_BEHIND = /^behind (\d+)$/;
const TRACK_DIVERGED = /^ahead (\d+), behind (\d+)$/;

/** Parses `%(upstream:track,nobracket)`: empty, `gone`, `ahead N`, `behind N`, or `ahead N, behind M`. */
export function parseTrack(track: string): Delta {
    if (track === "") {
        return { kind: "synced" };
    }
    if (track === "gone") {
        return { kind: "gone" };
    }
    const diverged = TRACK_DIVERGED.exec(track);
    if (diverged?.[1] !== undefined && diverged[2] !== undefined) {
        return {
            kind: "diverged",
            ahead: requirePositiveInt(Number(diverged[1]), "track ahead"),
            behind: requirePositiveInt(Number(diverged[2]), "track behind"),
        };
    }
    const ahead = TRACK_AHEAD.exec(track);
    if (ahead?.[1] !== undefined) {
        return { kind: "ahead", ahead: requirePositiveInt(Number(ahead[1]), "track ahead") };
    }
    const behind = TRACK_BEHIND.exec(track);
    if (behind?.[1] !== undefined) {
        return { kind: "behind", behind: requirePositiveInt(Number(behind[1]), "track behind") };
    }
    throw new Error(`unexpected upstream track: "${track}"`);
}

export const FOR_EACH_REF_FORMAT =
    "%(refname)%00%(symref)%00%(HEAD)%00%(refname:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(worktreepath)";
const FOR_EACH_REF_FIELDS = 9;
const REMOTE_REF_PREFIX = "refs/heads/";

/** Ref patterns for one `for-each-ref` call: every local branch plus the remote's HEAD symref. */
export function forEachRefPatterns(remote: RemoteName): [string, string] {
    return [REMOTE_REF_PREFIX, `refs/remotes/${remote}/HEAD`];
}

function parseUpstream(remoteName: string, remoteRef: string, track: string, context: string): Upstream {
    if (remoteName === "" && remoteRef === "") {
        return { kind: "none" };
    }
    if (!remoteRef.startsWith(REMOTE_REF_PREFIX)) {
        throw new Error(`${context}: unexpected upstream ref "${remoteRef}"`);
    }
    return {
        kind: "tracked",
        remote: requireRemoteName(remoteName, context),
        branch: requireBranchName(remoteRef.slice(REMOTE_REF_PREFIX.length), context),
        delta: parseTrack(track),
    };
}

function parseCheckout(head: string, worktreePath: string, context: string): Checkout {
    if (head === "*") {
        return { kind: "here" };
    }
    if (worktreePath === "") {
        return { kind: "none" };
    }
    return { kind: "elsewhere", path: requireAbsolutePath(worktreePath, context) };
}

export type ForEachRef = { branches: Branch[]; defaultBranch: DefaultBranch };

type ForEachRefLine = {
    refname: string;
    symref: string;
    head: string;
    name: string;
    remoteName: string;
    remoteRef: string;
    track: string;
    committerDate: string;
    worktreePath: string;
};

function splitForEachRefLine(line: string): ForEachRefLine {
    const fields = line.split("\0");
    const [refname, symref, head, name, remoteName, remoteRef, track, committerDate, worktreePath] = fields;
    if (
        fields.length !== FOR_EACH_REF_FIELDS ||
        refname === undefined ||
        symref === undefined ||
        head === undefined ||
        name === undefined ||
        remoteName === undefined ||
        remoteRef === undefined ||
        track === undefined ||
        committerDate === undefined ||
        worktreePath === undefined
    ) {
        throw new Error(`unexpected for-each-ref line with ${String(fields.length)} fields: "${line}"`);
    }
    return { refname, symref, head, name, remoteName, remoteRef, track, committerDate, worktreePath };
}

function parseBranchLine(line: ForEachRefLine): Branch {
    const context = `branch ${line.name}`;
    return {
        name: requireBranchName(line.name, context),
        checkout: parseCheckout(line.head, line.worktreePath, context),
        upstream: parseUpstream(line.remoteName, line.remoteRef, line.track, context),
        lastCommitAt: requireUnixSeconds(Number(line.committerDate), context),
    };
}

/**
 * Parses one `git for-each-ref --format=FOR_EACH_REF_FORMAT <forEachRefPatterns>`
 * call. The remote HEAD line is absent when the ref is missing or dangling —
 * `for-each-ref` skips a symref whose target no longer exists — so both read as
 * `unknown` rather than naming a branch the remote no longer has.
 */
export function parseForEachRef(stdout: string, remote: RemoteName): ForEachRef {
    const [branchPrefix, remoteHead] = forEachRefPatterns(remote);
    const remotePrefix = `refs/remotes/${remote}/`;
    const branches: Branch[] = [];
    let defaultBranch: DefaultBranch = { kind: "unknown" };
    for (const raw of stdout.split("\n").filter((line) => line.length > 0)) {
        const line = splitForEachRefLine(raw);
        if (line.refname === remoteHead) {
            if (!line.symref.startsWith(remotePrefix)) {
                throw new Error(`${remoteHead} points outside ${remotePrefix}: "${line.symref}"`);
            }
            defaultBranch = {
                kind: "known",
                branch: requireBranchName(line.symref.slice(remotePrefix.length), remoteHead),
            };
        } else if (line.refname.startsWith(branchPrefix)) {
            branches.push(parseBranchLine(line));
        } else {
            throw new Error(`unexpected ref in for-each-ref output: "${line.refname}"`);
        }
    }
    return { branches, defaultBranch };
}

const GIT_VERSION_PATTERN = /^git version (\d+\.\d+\.\d+)/;

/** Extracts `X.Y.Z` from `git --version`, tolerating vendor suffixes such as `(Apple Git-154)`. */
export function parseGitVersion(stdout: string): string {
    const match = GIT_VERSION_PATTERN.exec(stdout);
    if (match?.[1] === undefined) {
        throw new Error(`unexpected git --version output: "${stdout.trim()}"`);
    }
    return match[1];
}

/** Where the GitHub login comes from: explicit flag, environment, or gh's hosts.yml as the last resort. */
export type OwnerSource =
    | { kind: "flag"; login: GithubLogin }
    | { kind: "env"; login: GithubLogin }
    | { kind: "hosts" };

export function ownerSource(flag?: string, env?: string): OwnerSource {
    if (flag !== undefined) {
        return { kind: "flag", login: requireGithubLogin(flag, "--owner") };
    }
    if (env !== undefined && env !== "") {
        return { kind: "env", login: requireGithubLogin(env, "GIT_OWNED_UNPUSHED_OWNER") };
    }
    return { kind: "hosts" };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the active login for `github.com` from a parsed `gh` hosts.yml. */
export function loginFromHosts(parsed: unknown, context: string): GithubLogin {
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed["github.com"])) {
        throw new Error(`${context}: no github.com host; run "gh auth login"`);
    }
    return requireGithubLogin(parsed["github.com"]["user"], `${context}: github.com.user`);
}

/** Parses the exclude file: one absolute or `~`-relative path per line, `#` comments allowed. */
export function parseExcludeFile(text: string, home: AbsolutePath): AbsolutePath[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .map((line) => {
            const expanded = line === "~" ? home : line.startsWith("~/") ? `${home}/${line.slice(2)}` : line;
            return requireAbsolutePath(expanded, "exclude file");
        });
}

export function isExcluded(root: AbsolutePath, prefixes: readonly AbsolutePath[]): boolean {
    return prefixes.some((prefix) => prefix === "/" || root === prefix || root.startsWith(`${prefix}/`));
}

// ── Focus policy ────────────────────────────────────────────────────

/**
 * Default view: the branch checked out here and the remote's default branch.
 * Side branches, deleted upstreams, and branches living in another worktree are
 * the profile of agent or exploration work; `--all` reveals them.
 *
 * A repo with no `refs/remotes/<remote>/HEAD` cannot name its default branch, so
 * it falls back to the wider rule — every branch pushed once — rather than hide
 * work it has no evidence to hide.
 */
export function visibility(branch: Branch, defaultBranch: DefaultBranch, options: FocusOptions): Visibility {
    if (branch.checkout.kind === "here") {
        return "shown";
    }
    if (branch.checkout.kind === "elsewhere") {
        if (options.worktrees) {
            return "delegated";
        }
        return options.all ? "shown" : "hidden";
    }
    if (branch.upstream.kind === "none" || branch.upstream.delta.kind === "gone") {
        return options.all ? "shown" : "hidden";
    }
    if (defaultBranch.kind === "known" && branch.name !== defaultBranch.branch) {
        return options.all ? "shown" : "hidden";
    }
    return "shown";
}

type OwnedRepo = Extract<Repo, { kind: "owned" }>;

/**
 * Refs this run fetched are trustworthy, but a fetch refreshes one remote only:
 * a branch tracking any other remote still reads refs of the last fetch's age.
 */
function freshnessOf(repo: OwnedRepo, remote: RemoteName): Freshness {
    return repo.fetch.kind === "ok" && repo.fetch.remote === remote
        ? { kind: "fetched" }
        : { kind: "on-disk", lastFetch: repo.lastFetch };
}

function branchFinding(repo: OwnedRepo, branch: Branch): Finding | undefined {
    const { upstream } = branch;
    if (upstream.kind === "none") {
        return { kind: "NO_UPSTREAM", root: repo.root, branch: branch.name };
    }
    const base = {
        root: repo.root,
        branch: branch.name,
        remote: upstream.remote,
        upstream: upstream.branch,
        freshness: freshnessOf(repo, upstream.remote),
    };
    const tracksOther = branch.name !== upstream.branch;
    switch (upstream.delta.kind) {
        case "synced":
        case "behind":
            return undefined;
        case "gone":
            return { kind: "GONE", ...base };
        case "ahead":
            return tracksOther
                ? { kind: "TRACKS_OTHER", ...base, drift: upstream.delta }
                : { kind: "AHEAD", ...base, ahead: upstream.delta.ahead };
        case "diverged":
            return tracksOther
                ? { kind: "TRACKS_OTHER", ...base, drift: upstream.delta }
                : { kind: "DIVERGED", ...base, ahead: upstream.delta.ahead, behind: upstream.delta.behind };
        default:
            return unreachable(upstream.delta);
    }
}

type RepoFindings = { findings: Finding[]; hidden: number };

function repoFindings(repo: Repo, options: FocusOptions): RepoFindings {
    switch (repo.kind) {
        case "error":
            return {
                findings: [{ kind: "ERROR", root: repo.root, step: repo.step, message: repo.message }],
                hidden: 0,
            };
        case "not-a-repo":
        case "linked-worktree":
        case "foreign":
            return { findings: [], hidden: 0 };
        case "local-only":
            return { findings: [{ kind: "LOCAL_ONLY", root: repo.root }], hidden: 0 };
        case "owned": {
            const findings: Finding[] = [];
            let hidden = 0;
            if (repo.fetch.kind === "failed") {
                findings.push({ kind: "FETCH_FAIL", root: repo.root, message: repo.fetch.message });
            }
            for (const branch of repo.branches) {
                const finding = branchFinding(repo, branch);
                if (finding === undefined) {
                    continue;
                }
                switch (visibility(branch, repo.defaultBranch, options)) {
                    case "shown":
                        findings.push(finding);
                        break;
                    case "hidden":
                        hidden += 1;
                        break;
                    case "delegated":
                        break;
                }
            }
            return { findings, hidden };
        }
        default:
            return unreachable(repo);
    }
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function branchOf(finding: Finding): string {
    return "branch" in finding ? finding.branch : "";
}

export function buildReport(repos: readonly Repo[], options: FocusOptions): Report {
    const findings: Finding[] = [];
    let hiddenBranches = 0;
    let hiddenRepos = 0;
    let notRepos = 0;
    let fetchedRepos = 0;
    for (const repo of repos) {
        const result = repoFindings(repo, options);
        findings.push(...result.findings);
        hiddenBranches += result.hidden;
        hiddenRepos += result.hidden > 0 ? 1 : 0;
        notRepos += repo.kind === "not-a-repo" ? 1 : 0;
        fetchedRepos += repo.kind === "owned" && repo.fetch.kind === "ok" ? 1 : 0;
    }
    const sorted = findings.toSorted(
        (a, b) =>
            compareStrings(a.root, b.root) ||
            compareStrings(branchOf(a), branchOf(b)) ||
            compareStrings(a.kind, b.kind),
    );
    return { findings: sorted, hiddenBranches, hiddenRepos, notRepos, fetchedRepos };
}

/**
 * 10 for work to push, 20 when the scan itself is incomplete; mirrors the `dots`
 * status protocol. Keyed on every finding kind so a new kind cannot ship without
 * deciding its exit code. A directory the walk could not read is incomplete too,
 * whatever the findings say.
 */
const SEVERITY = {
    LOCAL_ONLY: 10,
    NO_UPSTREAM: 10,
    TRACKS_OTHER: 10,
    GONE: 10,
    AHEAD: 10,
    DIVERGED: 10,
    FETCH_FAIL: 20,
    ERROR: 20,
} as const satisfies Record<Finding["kind"], ExitCode>;

export function exitCodeOf(report: Report, unreadableDirs: number): ExitCode {
    let code: ExitCode = unreadableDirs > 0 ? 20 : 0;
    for (const finding of report.findings) {
        code = SEVERITY[finding.kind] > code ? SEVERITY[finding.kind] : code;
    }
    return code;
}

// ── Rendering ───────────────────────────────────────────────────────

const STATUS_WIDTH = 12;
const SECONDS_PER_DAY = 86_400;

/** Silent once this run fetched the repo; otherwise it states how old the refs behind the counts are. */
function renderFreshness(freshness: Freshness, now: UnixSeconds): string {
    if (freshness.kind === "fetched") {
        return "";
    }
    if (freshness.lastFetch.kind === "never") {
        return " last-fetch=never";
    }
    const days = Math.max(0, Math.floor((now - freshness.lastFetch.at) / SECONDS_PER_DAY));
    return ` last-fetch=${String(days)}d`;
}

export function renderFinding(finding: Finding, now: UnixSeconds): string {
    const status = finding.kind.padEnd(STATUS_WIDTH);
    switch (finding.kind) {
        case "LOCAL_ONLY":
            return `${status} ${finding.root}`;
        case "NO_UPSTREAM":
            return `${status} ${finding.root} branch=${finding.branch}`;
        case "GONE":
            return `${status} ${finding.root} branch=${finding.branch} upstream=${finding.remote}/${finding.upstream}${renderFreshness(finding.freshness, now)}`;
        case "AHEAD":
            return `${status} ${finding.root} branch=${finding.branch} ahead=${String(finding.ahead)} upstream=${finding.remote}/${finding.upstream}${renderFreshness(finding.freshness, now)}`;
        case "DIVERGED":
            return `${status} ${finding.root} branch=${finding.branch} ahead=${String(finding.ahead)} behind=${String(finding.behind)} upstream=${finding.remote}/${finding.upstream}${renderFreshness(finding.freshness, now)}`;
        case "TRACKS_OTHER": {
            const behind = finding.drift.kind === "diverged" ? ` behind=${String(finding.drift.behind)}` : "";
            return `${status} ${finding.root} branch=${finding.branch} ahead=${String(finding.drift.ahead)}${behind} upstream=${finding.remote}/${finding.upstream}${renderFreshness(finding.freshness, now)}`;
        }
        case "FETCH_FAIL":
            return `${status} ${finding.root} message=${finding.message}`;
        case "ERROR":
            return `${status} ${finding.root} step=${finding.step} message=${finding.message}`;
        default:
            return unreachable(finding);
    }
}

export function renderSummary(repoCount: number, report: Report, unreadableDirs: number): string {
    const parts = [`${String(repoCount)} repos`, `${String(report.findings.length)} findings`];
    if (report.hiddenBranches > 0) {
        parts.push(
            `${String(report.hiddenBranches)} branches hidden in ${String(report.hiddenRepos)} repos (--all to show)`,
        );
    }
    if (report.fetchedRepos > 0) {
        parts.push(`${String(report.fetchedRepos)} repos fetched`);
    }
    if (report.notRepos > 0) {
        parts.push(`${String(report.notRepos)} .git entries are not repositories`);
    }
    if (unreadableDirs > 0) {
        parts.push(`${String(unreadableDirs)} directories unreadable`);
    }
    return parts.join(", ");
}

export type JsonBranch = Branch & { visibility: Visibility };
export type JsonRepo =
    | Exclude<Repo, { kind: "owned" }>
    | (Omit<Extract<Repo, { kind: "owned" }>, "branches"> & { branches: readonly JsonBranch[] });

/** JSON view of a repo: the same focus policy as the text view, made explicit per branch. */
export function toJsonRepo(repo: Repo, options: FocusOptions): JsonRepo {
    if (repo.kind !== "owned") {
        return repo;
    }
    return {
        ...repo,
        branches: repo.branches.map((branch) => ({
            ...branch,
            visibility: visibility(branch, repo.defaultBranch, options),
        })),
    };
}

/** A repo earns a JSON line when the text view would show or count something for it. */
export function isReportable(repo: Repo, options: FocusOptions): boolean {
    const result = repoFindings(repo, options);
    return result.findings.length > 0 || result.hidden > 0;
}

function unreachable(value: never): never {
    throw new Error(`Unreachable variant: ${JSON.stringify(value)}`);
}
