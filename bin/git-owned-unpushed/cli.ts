/** Filesystem and process adapter for git-owned-unpushed. */

import type {
    AbsolutePath,
    ExitCode,
    FetchOutcome,
    GithubLogin,
    GitStep,
    LastFetch,
    OwnerSource,
    PositiveInt,
    RemoteName,
    Report,
    Repo,
    UnixSeconds,
    Worktree,
} from "./model.ts";
import { readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    buildReport,
    dependsOnRemote,
    exitCodeOf,
    FOR_EACH_REF_FORMAT,
    forEachRefPatterns,
    isExcluded,
    isReportable,
    loginFromHosts,
    NOT_A_REPO_PATTERN,
    ownedRemote,
    ownerSource,
    parseExcludeFile,
    parseForEachRef,
    parseGitVersion,
    parseRemotesOutput,
    renderFinding,
    renderSummary,
    requireAbsolutePath,
    requirePositiveInt,
    requireUnixSeconds,
    toJsonRepo,
} from "./model.ts";

const USAGE = `Usage: git-owned-unpushed [--owner LOGIN] [--fetch | --verify] [--worktrees] [--all] [--jobs N] [--json] [ROOT...]

Find local Git repositories that belong to a GitHub account and have local
work that is not pushed.

The default view keeps the branch checked out here and the branch named by
refs/remotes/<remote>/HEAD. A repo without that ref cannot name its default, so
it shows every branch pushed once instead of hiding work on a guess.

Counts read from stale remote-tracking refs are wrong, so every finding derived
from one states the age of the last fetch. Use --verify to settle them.

Options:
  --owner LOGIN GitHub account that owns the repos to check. Falls back to
                $GIT_OWNED_UNPUSHED_OWNER, then to the active login in gh's
                hosts.yml
  --fetch       Run git fetch --quiet --prune <remote> on the owned remote of
                each repo before checking. Every fetch also corrects
                refs/remotes/<remote>/HEAD
  --verify      Fetch only the repos that produced a finding, then check them
                again. Rules out stale refs at a fraction of the --fetch cost
  --worktrees   Include linked Git worktrees; each reports its checked-out branch
  --all         Show branches hidden by default: not the remote's default branch,
                no upstream, upstream gone, or checked out in another worktree
  --jobs N      Concurrent repo checks (default: available CPU parallelism)
  --json        One JSON object per reportable repo instead of text lines
  -h, --help    Show this help

When ROOT is omitted, the scan starts at $HOME.

Requires git >= 2.23. Reading gh's hosts.yml requires Bun >= 1.2.21.

Exit codes: 0 clean, 10 work to push, 20 scan incomplete, 30 cannot run, 2 usage.
A directory the scan cannot read leaves it incomplete; exclude the directory to
accept that.

Exclusions:
  $XDG_CONFIG_HOME/git-owned-unpushed/exclude, or
  ~/.config/git-owned-unpushed/exclude when XDG_CONFIG_HOME is unset, may contain
  one absolute or ~-relative path per line. Matching skips that exact path and
  any child paths without reading them. Blank lines and lines beginning with #
  are ignored.`;

const MIN_GIT_VERSION = ">=2.23.0";
const MIN_BUN_VERSION_FOR_YAML = ">=1.2.21";
const OWNER_ENV = "GIT_OWNED_UNPUSHED_OWNER";
const PRUNE_NAMES: ReadonlySet<string> = new Set([".cache", "node_modules", "target", ".venv", ".npm"]);
const PRUNE_SUFFIXES: readonly string[] = [
    "/.local/share/Trash",
    "/.local/share/nvim",
    "/.codex/.tmp",
    "/.bun/install/cache",
    "/.cargo/registry",
    "/.rustup/toolchains",
];
const FETCH_JOBS = 4;
const MILLISECONDS_PER_SECOND = 1000;
const STDERR_TAIL_CHARS = 200;
const EXIT_USAGE = 2;
const EXIT_CANNOT_RUN = 30;

class UsageError extends Error {}

type Options = {
    owner: OwnerSource;
    fetch: boolean;
    verify: boolean;
    worktrees: boolean;
    all: boolean;
    json: boolean;
    jobs: PositiveInt;
    roots: readonly AbsolutePath[];
};

type Environment = Record<string, string | undefined>;

// ── CLI arguments ───────────────────────────────────────────────────

function requireHome(env: Environment): AbsolutePath {
    const home = env["HOME"];
    if (home === undefined || home === "") {
        throw new Error("HOME is not set");
    }
    return requireAbsolutePath(home, "HOME");
}

function usageErrorFrom(error: unknown): UsageError {
    return new UsageError(error instanceof Error ? error.message : String(error));
}

function parseJobs(raw: string | undefined): PositiveInt {
    if (raw === undefined) {
        return requirePositiveInt(availableParallelism(), "availableParallelism");
    }
    try {
        return requirePositiveInt(Number(raw), "--jobs");
    } catch (error) {
        throw usageErrorFrom(error);
    }
}

function parseOwner(flag: string | undefined, env: Environment): OwnerSource {
    try {
        return ownerSource(flag, env[OWNER_ENV]);
    } catch (error) {
        throw usageErrorFrom(error);
    }
}

function stringOption(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export function parseCliArgs(argv: readonly string[], env: Environment): Options | "help" {
    let parsed: ReturnType<typeof parseArgs>;
    try {
        parsed = parseArgs({
            args: [...argv],
            options: {
                owner: { type: "string" },
                fetch: { type: "boolean", default: false },
                verify: { type: "boolean", default: false },
                worktrees: { type: "boolean", default: false },
                all: { type: "boolean", default: false },
                json: { type: "boolean", default: false },
                jobs: { type: "string" },
                help: { type: "boolean", short: "h", default: false },
            },
            strict: true,
            allowPositionals: true,
        });
    } catch (error) {
        throw usageErrorFrom(error);
    }
    const { values, positionals } = parsed;
    if (values["help"] === true) {
        return "help";
    }
    const owner = parseOwner(stringOption(values["owner"]), env);
    const jobs = parseJobs(stringOption(values["jobs"]));
    const fetch = values["fetch"] === true;
    const verify = values["verify"] === true;
    if (fetch && verify) {
        throw new UsageError("--fetch already refreshes every owned repo; --verify cannot narrow that");
    }
    const roots =
        positionals.length === 0
            ? [requireHome(env)]
            : positionals.map((root) => requireAbsolutePath(resolve(root), "ROOT"));
    return {
        owner,
        fetch,
        verify,
        worktrees: values["worktrees"] === true,
        all: values["all"] === true,
        json: values["json"] === true,
        jobs,
        roots,
    };
}

// ── Discovery ───────────────────────────────────────────────────────

type Walk = { candidates: AbsolutePath[]; unreadable: string[] };

function isPruned(path: string, name: string): boolean {
    return PRUNE_NAMES.has(name) || PRUNE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** Collects every directory holding a `.git` entry (directory or file), never following symlinks. */
async function walkForGit(directory: AbsolutePath, excludes: readonly AbsolutePath[], walk: Walk): Promise<void> {
    if (isExcluded(directory, excludes)) {
        return;
    }
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        walk.unreadable.push(error instanceof Error ? error.message : String(error));
        return;
    }
    const subdirectories: AbsolutePath[] = [];
    for (const entry of entries) {
        if (entry.name === ".git") {
            walk.candidates.push(directory);
            continue;
        }
        if (!entry.isDirectory() || isPruned(join(directory, entry.name), entry.name)) {
            continue;
        }
        subdirectories.push(requireAbsolutePath(join(directory, entry.name), "walk"));
    }
    await Promise.all(subdirectories.map(async (subdirectory) => walkForGit(subdirectory, excludes, walk)));
}

async function requireDirectory(root: AbsolutePath): Promise<void> {
    let stats;
    try {
        stats = await stat(root);
    } catch (error) {
        throw new Error(`ROOT does not exist: ${root}`, { cause: error });
    }
    if (!stats.isDirectory()) {
        throw new Error(`ROOT is not a directory: ${root}`);
    }
}

// ── Git ─────────────────────────────────────────────────────────────

type GitRun = { exitCode: number; stdout: string; stderr: string };

async function git(cwd: string, args: readonly string[]): Promise<GitRun> {
    const child = Bun.spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    return { exitCode, stdout, stderr };
}

function stderrTail(stderr: string): string {
    const trimmed = stderr.trim();
    return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : `...${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}

async function requireGit(cwd: string, args: readonly string[]): Promise<string> {
    const run = await git(cwd, args);
    if (run.exitCode !== 0) {
        throw new Error(`git ${args[0] ?? ""} exited ${String(run.exitCode)}: ${stderrTail(run.stderr)}`);
    }
    return run.stdout;
}

async function requireGitVersion(): Promise<void> {
    if (Bun.which("git") === null) {
        throw new Error("git is required; install it from https://git-scm.com");
    }
    const version = parseGitVersion(await requireGit(".", ["--version"]));
    if (!Bun.semver.satisfies(version, MIN_GIT_VERSION)) {
        throw new Error(`git ${MIN_GIT_VERSION} is required (for-each-ref %(worktreepath)); found ${version}`);
    }
}

class Semaphore {
    private readonly waiters: Array<() => void> = [];
    private active = 0;

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((release) => {
                this.waiters.push(release);
            });
        }
        this.active += 1;
        try {
            return await task();
        } finally {
            this.active -= 1;
            this.waiters.shift()?.();
        }
    }
}

// ── Classification ──────────────────────────────────────────────────

type ScanContext = {
    options: Options;
    login: GithubLogin;
    excludes: readonly AbsolutePath[];
    seen: Set<AbsolutePath>;
    fetchSlots: Semaphore;
};

type Layout = { root: AbsolutePath; gitPath: string; commonPath: string; worktree: Worktree };

class NotARepoError extends Error {}

async function readLayout(candidate: string): Promise<Layout> {
    const run = await git(candidate, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]);
    if (run.exitCode !== 0) {
        const tail = stderrTail(run.stderr);
        if (NOT_A_REPO_PATTERN.test(tail)) {
            throw new NotARepoError(tail);
        }
        throw new Error(`git rev-parse exited ${String(run.exitCode)}: ${tail}`);
    }
    const lines = run.stdout.trimEnd().split("\n");
    const [toplevel, gitDir, commonDir] = lines;
    if (lines.length !== 3 || toplevel === undefined || gitDir === undefined || commonDir === undefined) {
        throw new Error(`unexpected rev-parse output: "${lines.join(" | ")}"`);
    }
    const root = requireAbsolutePath(toplevel, "rev-parse --show-toplevel");
    const gitPath = resolve(candidate, gitDir);
    const commonPath = resolve(candidate, commonDir);
    const worktree: Worktree =
        gitPath === commonPath
            ? { kind: "main" }
            : { kind: "linked", commonRoot: requireAbsolutePath(dirname(commonPath), "rev-parse --git-common-dir") };
    return { root, gitPath, commonPath, worktree };
}

async function mtimeSeconds(path: string): Promise<UnixSeconds | undefined> {
    try {
        const stats = await stat(path);
        return requireUnixSeconds(Math.floor(stats.mtimeMs / MILLISECONDS_PER_SECOND), `mtime of ${path}`);
    } catch {
        return undefined;
    }
}

/**
 * `git clone` writes no FETCH_HEAD, so its absence reads as `never`. The file is
 * also per-worktree while the remote-tracking refs it refreshed are shared, hence
 * both git dirs: a fetch run from a third worktree still reads as older than it was.
 */
async function readLastFetch(layout: Layout): Promise<LastFetch> {
    const stamps = await Promise.all(
        [layout.gitPath, layout.commonPath].map(async (dir) => mtimeSeconds(join(dir, "FETCH_HEAD"))),
    );
    const known = stamps.filter((stamp) => stamp !== undefined);
    return known.length === 0 ? { kind: "never" } : { kind: "at", at: known.reduce((a, b) => (a > b ? a : b)) };
}

async function readRemotes(root: AbsolutePath): Promise<ReturnType<typeof parseRemotesOutput>> {
    const run = await git(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
    // `git config --get-regexp` exits 1 when nothing matches; that is the no-remote case, not a failure.
    if (run.exitCode === 1 && run.stdout === "") {
        return [];
    }
    if (run.exitCode !== 0) {
        throw new Error(`git config exited ${String(run.exitCode)}: ${stderrTail(run.stderr)}`);
    }
    return parseRemotesOutput(run.stdout);
}

/**
 * Every fetch this tool runs is already on the network, so it settles
 * `refs/remotes/<remote>/HEAD` while it is there: `git fetch` only creates that
 * ref, it never corrects one the remote has since renamed. The ref itself is the
 * outcome, hence no branch on the exit code — the for-each-ref pass reports
 * whatever survived.
 */
async function fetchIfRequested(root: AbsolutePath, remote: RemoteName, context: ScanContext): Promise<FetchOutcome> {
    if (!context.options.fetch) {
        return { kind: "not-requested" };
    }
    return context.fetchSlots.run(async () => {
        const run = await git(root, ["fetch", "--quiet", "--prune", remote]);
        if (run.exitCode !== 0) {
            return { kind: "failed", message: stderrTail(run.stderr) };
        }
        await git(root, ["remote", "set-head", remote, "--auto"]);
        return { kind: "ok", remote };
    });
}

async function classify(candidate: string, context: ScanContext): Promise<Repo | undefined> {
    let step: GitStep = "rev-parse";
    let root = requireAbsolutePath(candidate, "candidate");
    try {
        const layout = await readLayout(candidate);
        ({ root } = layout);
        if (context.seen.has(root) || isExcluded(root, context.excludes)) {
            return undefined;
        }
        context.seen.add(root);
        if (layout.worktree.kind === "linked" && !context.options.worktrees) {
            return { kind: "linked-worktree", root, commonRoot: layout.worktree.commonRoot };
        }

        step = "config";
        const remotes = await readRemotes(root);
        if (remotes.length === 0) {
            return { kind: "local-only", root, worktree: layout.worktree };
        }
        const owner = ownedRemote(remotes, context.login);
        if (owner === undefined) {
            return { kind: "foreign", root, worktree: layout.worktree, remotes };
        }

        const fetch = await fetchIfRequested(root, owner.name, context);
        const lastFetch = await readLastFetch(layout);

        step = "for-each-ref";
        const { branches, defaultBranch } = parseForEachRef(
            await requireGit(root, [
                "for-each-ref",
                `--format=${FOR_EACH_REF_FORMAT}`,
                ...forEachRefPatterns(owner.name),
            ]),
            owner.name,
        );
        const reported =
            layout.worktree.kind === "linked" ? branches.filter((branch) => branch.checkout.kind === "here") : branches;
        return {
            kind: "owned",
            root,
            worktree: layout.worktree,
            slug: owner.slug,
            fetch,
            lastFetch,
            defaultBranch,
            branches: reported,
        };
    } catch (error) {
        if (error instanceof NotARepoError) {
            return { kind: "not-a-repo", root, message: error.message };
        }
        return { kind: "error", root, step, message: error instanceof Error ? error.message : String(error) };
    }
}

async function mapLimit<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    const queue = values.entries();
    async function worker(): Promise<void> {
        for (const [index, value] of queue) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- each worker is deliberately sequential; parallelism is the worker count.
            results[index] = await fn(value);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
    return results;
}

// ── Main ────────────────────────────────────────────────────────────

function configHome(env: Environment, home: AbsolutePath): string {
    const xdg = env["XDG_CONFIG_HOME"];
    return xdg === undefined || xdg === "" ? join(home, ".config") : xdg;
}

async function resolveLogin(owner: OwnerSource, config: string): Promise<GithubLogin> {
    if (owner.kind !== "hosts") {
        return owner.login;
    }
    if (!Bun.semver.satisfies(Bun.version, MIN_BUN_VERSION_FOR_YAML)) {
        throw new Error(
            `reading gh's hosts.yml needs Bun ${MIN_BUN_VERSION_FOR_YAML} (found ${Bun.version}); pass --owner LOGIN or set ${OWNER_ENV}`,
        );
    }
    const hostsPath = join(config, "gh", "hosts.yml");
    const hosts = Bun.file(hostsPath);
    if (!(await hosts.exists())) {
        throw new Error(
            `no GitHub login: pass --owner LOGIN, set ${OWNER_ENV}, or run "gh auth login" (${hostsPath} not found)`,
        );
    }
    return loginFromHosts(Bun.YAML.parse(await hosts.text()), hostsPath);
}

async function readExcludes(config: string, home: AbsolutePath): Promise<AbsolutePath[]> {
    const exclude = Bun.file(join(config, "git-owned-unpushed", "exclude"));
    return (await exclude.exists()) ? parseExcludeFile(await exclude.text(), home) : [];
}

/**
 * Second pass of `--verify`: only repos whose findings came off a remote-tracking
 * ref are worth the network, so those get fetched and classified again in place.
 */
async function verifyRemoteFindings(
    repos: readonly Repo[],
    report: Report,
    context: ScanContext,
): Promise<readonly Repo[]> {
    const suspect = new Set(report.findings.filter(dependsOnRemote).map((finding) => finding.root));
    if (suspect.size === 0) {
        return repos;
    }
    const fetching: ScanContext = { ...context, options: { ...context.options, fetch: true }, seen: new Set() };
    const rechecked = await mapLimit([...suspect], context.options.jobs, async (root) => classify(root, fetching));
    const byRoot = new Map(
        rechecked.filter((repo): repo is Repo => repo !== undefined).map((repo) => [repo.root, repo]),
    );
    return repos.map((repo) => byRoot.get(repo.root) ?? repo);
}

async function main(argv: readonly string[], env: Environment): Promise<ExitCode> {
    const options = parseCliArgs(argv, env);
    if (options === "help") {
        console.log(USAGE);
        return 0;
    }
    await requireGitVersion();
    const home = requireHome(env);
    const config = configHome(env, home);
    const [login, excludes] = await Promise.all([resolveLogin(options.owner, config), readExcludes(config, home)]);
    await Promise.all(options.roots.map(requireDirectory));

    const walk: Walk = { candidates: [], unreadable: [] };
    await Promise.all(options.roots.map(async (root) => walkForGit(root, excludes, walk)));

    const context: ScanContext = { options, login, excludes, seen: new Set(), fetchSlots: new Semaphore(FETCH_JOBS) };
    const scanned = (
        await mapLimit(walk.candidates, options.jobs, async (candidate) => classify(candidate, context))
    ).filter((repo): repo is Repo => repo !== undefined);

    const focus = { all: options.all, worktrees: options.worktrees };
    const repos = options.verify ? await verifyRemoteFindings(scanned, buildReport(scanned, focus), context) : scanned;
    const report = buildReport(repos, focus);
    const now = requireUnixSeconds(Math.floor(Date.now() / MILLISECONDS_PER_SECOND), "clock");
    if (options.json) {
        for (const repo of repos.filter((entry) => isReportable(entry, focus))) {
            console.log(JSON.stringify(toJsonRepo(repo, focus)));
        }
    } else {
        for (const finding of report.findings) {
            console.log(renderFinding(finding, now));
        }
    }
    for (const message of walk.unreadable) {
        console.error(`unreadable: ${message}`);
    }
    console.error(renderSummary(repos.length, report, walk.unreadable.length));
    return exitCodeOf(report, walk.unreadable.length);
}

export async function runCli(argv: readonly string[], env: Environment): Promise<void> {
    try {
        process.exitCode = await main(argv, env);
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(error.message);
            console.error(USAGE);
            process.exitCode = EXIT_USAGE;
        } else {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = EXIT_CANNOT_RUN;
        }
    }
}
