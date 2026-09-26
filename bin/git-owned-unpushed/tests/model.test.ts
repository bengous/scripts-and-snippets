import type { Branch, DefaultBranch, Delta, Finding, Repo } from "../model.ts";
import { describe, expect, test } from "bun:test";
import {
    buildReport,
    dependsOnRemote,
    exitCodeOf,
    isExcluded,
    isReportable,
    loginFromHosts,
    ownedRemote,
    ownerSource,
    parseExcludeFile,
    parseForEachRef,
    parseGitVersion,
    parseRemotesOutput,
    parseRemoteUrl,
    parseTrack,
    renderFinding,
    renderSummary,
    requireAbsolutePath,
    requireBranchName,
    requireGithubLogin,
    requirePositiveInt,
    requireRemoteName,
    requireRepoName,
    requireUnixSeconds,
    toJsonRepo,
    visibility,
} from "../model.ts";

const HOME = requireAbsolutePath("/home/tester", "test");
const ROOT = requireAbsolutePath("/home/tester/Work/app", "test");
const LOGIN = requireGithubLogin("bengous", "test");
const SLUG = { owner: LOGIN, name: requireRepoName("app", "test") };
const ORIGIN = requireRemoteName("origin", "test");
const NOW = requireUnixSeconds(1_787_828_220, "test");
const FOCUS = { all: false, worktrees: false };

function branch(name: string, overrides: Partial<Branch> = {}): Branch {
    return {
        name: requireBranchName(name, "test"),
        checkout: { kind: "none" },
        upstream: { kind: "none" },
        lastCommitAt: NOW,
        ...overrides,
    };
}

function tracked(name: string, delta: Delta): Branch {
    return branch(name, {
        upstream: { kind: "tracked", remote: ORIGIN, branch: requireBranchName(name, "test"), delta },
    });
}

function crossTracked(name: string, upstream: string, delta: Delta): Branch {
    return branch(name, {
        checkout: { kind: "here" },
        upstream: { kind: "tracked", remote: ORIGIN, branch: requireBranchName(upstream, "t"), delta },
    });
}

function owned(branches: readonly Branch[], overrides: Partial<Extract<Repo, { kind: "owned" }>> = {}): Repo {
    return {
        kind: "owned",
        root: ROOT,
        worktree: { kind: "main" },
        slug: SLUG,
        fetch: { kind: "not-requested" },
        lastFetch: { kind: "at", at: NOW },
        defaultBranch: { kind: "unknown" },
        branches,
        ...overrides,
    };
}

function render(report: { findings: readonly Finding[] }): string[] {
    return report.findings.map((finding) => renderFinding(finding, NOW));
}

describe("brands", () => {
    test("requireAbsolutePath normalizes and strips the trailing slash", () => {
        expect<string>(requireAbsolutePath("/home/tester/Work//app/", "t")).toBe("/home/tester/Work/app");
        expect<string>(requireAbsolutePath("/", "t")).toBe("/");
        expect(() => requireAbsolutePath("Work/app", "t")).toThrow("expected an absolute path");
    });

    test("requirePositiveInt rejects zero, fractions, and NaN", () => {
        expect<number>(requirePositiveInt(0x37cf, "t")).toBe(14287);
        for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => requirePositiveInt(bad, "t")).toThrow("expected a positive integer");
        }
    });

    test("requireBranchName rejects what git check-ref-format rejects", () => {
        expect<string>(requireBranchName("feature/sweep-slicing-lesson", "t")).toBe("feature/sweep-slicing-lesson");
        for (const bad of ["", "-lead", "a..b", "a b", "x.lock", "trail/", "@", "a@{b}", "tilde~1", "star*"]) {
            expect(() => requireBranchName(bad, "t")).toThrow("expected a branch name");
        }
    });

    test("requireGithubLogin follows GitHub login rules", () => {
        expect<string>(requireGithubLogin("b3n-gous", "t")).toBe("b3n-gous");
        for (const bad of ["", "-lead", "trail-", "with space", "a".repeat(40), 42]) {
            expect(() => requireGithubLogin(bad, "t")).toThrow("expected a GitHub login");
        }
    });
});

describe("parseRemoteUrl", () => {
    test("recognizes the four GitHub URL forms with and without .git", () => {
        for (const url of [
            "git@github.com:bengous/app.git",
            "ssh://git@github.com/bengous/app",
            "https://github.com/bengous/app.git",
            "http://github.com/bengous/app/",
        ]) {
            expect(parseRemoteUrl(url)).toEqual({ kind: "github", slug: SLUG });
        }
    });

    test("treats every other shape as another host", () => {
        for (const url of [
            "git@gitlab.com:bengous/app.git",
            "https://github.com/bengous",
            "https://github.com/bengous/app/extra",
            "https://github.com/-bad/app",
            "/srv/git/app.git",
        ]) {
            expect(parseRemoteUrl(url)).toEqual({ kind: "other" });
        }
    });
});

describe("parseRemotesOutput and ownedRemote", () => {
    const output =
        "remote.origin.url git@github.com:bengous/app.git\nremote.up.stream.url https://github.com/other/app\n";

    test("keeps every remote, including names with dots", () => {
        expect(parseRemotesOutput(output)).toEqual([
            { name: ORIGIN, url: "git@github.com:bengous/app.git" },
            { name: requireRemoteName("up.stream", "t"), url: "https://github.com/other/app" },
        ]);
        expect(parseRemotesOutput("")).toEqual([]);
        expect(() => parseRemotesOutput("garbage")).toThrow("unexpected git config line");
    });

    test("ownedRemote picks the first remote of the login, naming it for refs/remotes lookups", () => {
        expect(ownedRemote(parseRemotesOutput(output), LOGIN)).toEqual({ name: ORIGIN, slug: SLUG });
        expect(ownedRemote(parseRemotesOutput(output), requireGithubLogin("nobody", "t"))).toBeUndefined();
    });
});

describe("parseTrack", () => {
    test("maps every git track shape to a delta", () => {
        expect(parseTrack("")).toEqual({ kind: "synced" });
        expect(parseTrack("gone")).toEqual({ kind: "gone" });
        expect(parseTrack("ahead 2")).toEqual({ kind: "ahead", ahead: requirePositiveInt(2, "t") });
        expect(parseTrack("behind 3")).toEqual({ kind: "behind", behind: requirePositiveInt(3, "t") });
        expect(parseTrack("ahead 1, behind 3")).toEqual({
            kind: "diverged",
            ahead: requirePositiveInt(1, "t"),
            behind: requirePositiveInt(3, "t"),
        });
        expect(() => parseTrack("ahead 0")).toThrow("expected a positive integer");
        expect(() => parseTrack("weird")).toThrow("unexpected upstream track");
    });
});

function line(fields: readonly string[]): string {
    return fields.join("\0");
}

describe("parseForEachRef", () => {
    const output = [
        line(["refs/heads/feature/x", "", " ", "feature/x", "", "", "", "1787788748", ""]),
        line([
            "refs/heads/main",
            "",
            "*",
            "main",
            "origin",
            "refs/heads/main",
            "ahead 2",
            "1787828220",
            "/home/tester/Work/app",
        ]),
        line([
            "refs/heads/agent/y",
            "",
            " ",
            "agent/y",
            "origin",
            "refs/heads/agent/y",
            "gone",
            "1786958228",
            "/home/tester/Work/app.wt/y",
        ]),
    ].join("\n");
    const remoteHead = line([
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
        " ",
        "origin/HEAD",
        "",
        "",
        "",
        "1",
        "",
    ]);

    test("parses checkout, upstream, delta, and commit date per branch", () => {
        const { branches } = parseForEachRef(`${output}\n`, ORIGIN);
        expect<string[]>(branches.map((entry) => entry.name)).toEqual(["feature/x", "main", "agent/y"]);
        expect(branches[0]).toMatchObject({ checkout: { kind: "none" }, upstream: { kind: "none" } });
        expect(branches[1]).toMatchObject({
            checkout: { kind: "here" },
            upstream: { kind: "tracked", remote: "origin", branch: "main", delta: { kind: "ahead", ahead: 2 } },
            lastCommitAt: 1787828220,
        });
        expect(branches[2]).toMatchObject({
            checkout: { kind: "elsewhere", path: "/home/tester/Work/app.wt/y" },
            upstream: { delta: { kind: "gone" } },
        });
    });

    test("reads the remote's default branch off its HEAD symref, unknown when the line is absent", () => {
        expect(parseForEachRef(`${output}\n${remoteHead}\n`, ORIGIN).defaultBranch).toEqual({
            kind: "known",
            branch: requireBranchName("main", "t"),
        });
        expect(parseForEachRef(output, ORIGIN).defaultBranch).toEqual({ kind: "unknown" });
        expect(parseForEachRef(remoteHead, ORIGIN).branches).toEqual([]);
    });

    test("rejects wrong field counts, foreign upstream refs, stray refs, and a HEAD outside its remote", () => {
        expect(() => parseForEachRef(line(["refs/heads/main", "", "*"]), ORIGIN)).toThrow(
            "unexpected for-each-ref line with 3 fields",
        );
        expect(() =>
            parseForEachRef(line(["refs/heads/main", "", "*", "main", "origin", "refs/tags/v1", "", "1", ""]), ORIGIN),
        ).toThrow("unexpected upstream ref");
        expect(() => parseForEachRef(line(["refs/tags/v1", "", " ", "v1", "", "", "", "1", ""]), ORIGIN)).toThrow(
            'unexpected ref in for-each-ref output: "refs/tags/v1"',
        );
        expect(() =>
            parseForEachRef(
                line(["refs/remotes/origin/HEAD", "refs/remotes/other/main", " ", "origin/HEAD", "", "", "", "1", ""]),
                ORIGIN,
            ),
        ).toThrow("points outside refs/remotes/origin/");
    });
});

describe("gates", () => {
    test("parseGitVersion reads plain and vendor-suffixed versions", () => {
        expect(parseGitVersion("git version 2.55.0\n")).toBe("2.55.0");
        expect(parseGitVersion("git version 2.39.5 (Apple Git-154)\n")).toBe("2.39.5");
        expect(() => parseGitVersion("git: command not found")).toThrow("unexpected git --version output");
    });

    test("ownerSource prefers the flag, then the environment, then hosts.yml", () => {
        expect(ownerSource("other", "envlogin")).toEqual({ kind: "flag", login: requireGithubLogin("other", "t") });
        expect(ownerSource(undefined, "envlogin")).toEqual({ kind: "env", login: requireGithubLogin("envlogin", "t") });
        expect(ownerSource(undefined, "")).toEqual({ kind: "hosts" });
        expect(ownerSource()).toEqual({ kind: "hosts" });
        expect(() => ownerSource("bad login")).toThrow("--owner: expected a GitHub login");
        expect(() => ownerSource(undefined, "-bad")).toThrow("GIT_OWNED_UNPUSHED_OWNER: expected a GitHub login");
    });
});

describe("loginFromHosts", () => {
    test("reads github.com.user and rejects a missing host", () => {
        expect<string>(loginFromHosts({ "github.com": { user: "bengous", users: { bengous: {} } } }, "hosts")).toBe(
            "bengous",
        );
        expect(() => loginFromHosts({}, "hosts")).toThrow('run "gh auth login"');
        expect(() => loginFromHosts({ "github.com": {} }, "hosts")).toThrow("github.com.user");
    });
});

describe("exclusions", () => {
    test("expands ~, skips comments, and matches the path or any child", () => {
        const prefixes = parseExcludeFile("# comment\n\n~/Work/vendor/\n/srv\n", HOME);
        expect(prefixes.map(String)).toEqual(["/home/tester/Work/vendor", "/srv"]);
        expect(isExcluded(requireAbsolutePath("/home/tester/Work/vendor", "t"), prefixes)).toBe(true);
        expect(isExcluded(requireAbsolutePath("/home/tester/Work/vendor/lib", "t"), prefixes)).toBe(true);
        expect(isExcluded(requireAbsolutePath("/home/tester/Work/vendored", "t"), prefixes)).toBe(false);
        expect(isExcluded(ROOT, parseExcludeFile("/", HOME))).toBe(true);
    });
});

describe("visibility", () => {
    const ahead: Delta = { kind: "ahead", ahead: requirePositiveInt(1, "t") };
    const here = branch("main", { checkout: { kind: "here" } });
    const pushed = tracked("dev", ahead);
    const side = tracked("feature/sweep", ahead);
    const gone = tracked("merged", { kind: "gone" });
    const local = branch("feature/x");
    const elsewhere = branch("agent/y", { checkout: { kind: "elsewhere", path: ROOT } });
    const unknown: DefaultBranch = { kind: "unknown" };
    const isDev: DefaultBranch = { kind: "known", branch: requireBranchName("dev", "t") };

    test("default view keeps HEAD and the remote's default branch", () => {
        expect(visibility(here, isDev, FOCUS)).toBe("shown");
        expect(visibility(pushed, isDev, FOCUS)).toBe("shown");
        expect(visibility(side, isDev, FOCUS)).toBe("hidden");
        expect(visibility(gone, isDev, FOCUS)).toBe("hidden");
        expect(visibility(local, isDev, FOCUS)).toBe("hidden");
        expect(visibility(elsewhere, isDev, FOCUS)).toBe("hidden");
    });

    test("an unnamed default falls back to every branch pushed once", () => {
        expect([pushed, side].map((entry) => visibility(entry, unknown, FOCUS))).toEqual(["shown", "shown"]);
        expect([gone, local].map((entry) => visibility(entry, unknown, FOCUS))).toEqual(["hidden", "hidden"]);
    });

    test("--all reveals everything; --worktrees delegates branches living elsewhere", () => {
        const all = { all: true, worktrees: false };
        expect([side, gone, local, elsewhere].map((entry) => visibility(entry, isDev, all))).toEqual([
            "shown",
            "shown",
            "shown",
            "shown",
        ]);
        expect(visibility(elsewhere, isDev, { all: true, worktrees: true })).toBe("delegated");
    });
});

describe("buildReport and exitCodeOf", () => {
    const repos: Repo[] = [
        owned([
            branch("main", {
                checkout: { kind: "here" },
                upstream: {
                    kind: "tracked",
                    remote: ORIGIN,
                    branch: requireBranchName("main", "t"),
                    delta: { kind: "ahead", ahead: requirePositiveInt(2, "t") },
                },
            }),
            branch("feature/x"),
            tracked("synced", { kind: "synced" }),
            tracked("behind", { kind: "behind", behind: requirePositiveInt(4, "t") }),
        ]),
        { kind: "local-only", root: requireAbsolutePath("/home/tester/Work/alpha", "t"), worktree: { kind: "main" } },
        { kind: "foreign", root: HOME, worktree: { kind: "main" }, remotes: [] },
        { kind: "linked-worktree", root: HOME, commonRoot: ROOT },
        { kind: "not-a-repo", root: HOME, message: "fatal: not a git repository: (null)" },
    ];

    test("sorts findings by root then branch, counts hidden branches, and exits 10", () => {
        const report = buildReport(repos, FOCUS);
        expect(render(report)).toEqual([
            "LOCAL_ONLY   /home/tester/Work/alpha",
            "AHEAD        /home/tester/Work/app branch=main ahead=2 upstream=origin/main last-fetch=0d",
        ]);
        expect(report.hiddenBranches).toBe(1);
        expect(report.hiddenRepos).toBe(1);
        expect(report.notRepos).toBe(1);
        expect(exitCodeOf(report, 0)).toBe(10);
        expect(renderSummary(5, report, 2)).toBe(
            "5 repos, 2 findings, 1 branches hidden in 1 repos (--all to show), 1 .git entries are not repositories, 2 directories unreadable",
        );
    });

    test("--all reveals NO_UPSTREAM and a clean scan exits 0", () => {
        const report = buildReport(repos, { all: true, worktrees: false });
        expect(report.findings.map((finding) => finding.kind)).toEqual(["LOCAL_ONLY", "NO_UPSTREAM", "AHEAD"]);
        expect(report.hiddenBranches).toBe(0);
        expect(exitCodeOf(buildReport([owned([tracked("main", { kind: "synced" })])], FOCUS), 0)).toBe(0);
    });

    test("an unreadable directory leaves the scan incomplete, whatever the findings", () => {
        expect(exitCodeOf(buildReport([], FOCUS), 1)).toBe(20);
        expect(exitCodeOf(buildReport(repos, FOCUS), 1)).toBe(20);
    });

    test("errors and fetch failures exit 20 and render their cause", () => {
        const failed = owned([], { fetch: { kind: "failed", message: "ssh: connect timed out" } });
        const broken: Repo = { kind: "error", root: ROOT, step: "for-each-ref", message: "boom" };
        const report = buildReport([failed, broken], FOCUS);
        expect(render(report)).toEqual([
            "ERROR        /home/tester/Work/app step=for-each-ref message=boom",
            "FETCH_FAIL   /home/tester/Work/app message=ssh: connect timed out",
        ]);
        expect(exitCodeOf(report, 0)).toBe(20);
    });

    test("the exit code is the most severe finding, whatever the order", () => {
        const failed = owned([], { fetch: { kind: "failed", message: "offline" } });
        const pushable = owned([tracked("main", { kind: "ahead", ahead: requirePositiveInt(1, "t") })], {
            root: requireAbsolutePath("/home/tester/Work/zzz", "t"),
        });
        expect(exitCodeOf(buildReport([pushable, failed], FOCUS), 0)).toBe(20);
        expect(exitCodeOf(buildReport([pushable], FOCUS), 0)).toBe(10);
    });
});

describe("TRACKS_OTHER", () => {
    const ahead = requirePositiveInt(1, "t");
    const behind = requirePositiveInt(111, "t");

    test("replaces AHEAD and DIVERGED when the upstream carries another name", () => {
        const report = buildReport(
            [
                owned([crossTracked("backup/squash", "main", { kind: "diverged", ahead, behind })]),
                owned([crossTracked("archive", "main", { kind: "ahead", ahead })], {
                    root: requireAbsolutePath("/home/tester/Work/legacy", "t"),
                }),
            ],
            FOCUS,
        );
        expect(render(report)).toEqual([
            "TRACKS_OTHER /home/tester/Work/app branch=backup/squash ahead=1 behind=111 upstream=origin/main last-fetch=0d",
            "TRACKS_OTHER /home/tester/Work/legacy branch=archive ahead=1 upstream=origin/main last-fetch=0d",
        ]);
        expect(exitCodeOf(report, 0)).toBe(10);
    });

    test("leaves a matching upstream on AHEAD and stays quiet when merely behind", () => {
        const matching = buildReport([owned([crossTracked("main", "main", { kind: "ahead", ahead })])], FOCUS);
        expect(matching.findings.map((finding) => finding.kind)).toEqual(["AHEAD"]);
        const trailing = buildReport(
            [owned([crossTracked("backup/squash", "main", { kind: "behind", behind })])],
            FOCUS,
        );
        expect(trailing.findings).toEqual([]);
    });
});

describe("freshness", () => {
    const ahead = requirePositiveInt(2, "t");
    const branches = [
        branch("main", {
            checkout: { kind: "here" },
            upstream: {
                kind: "tracked",
                remote: ORIGIN,
                branch: requireBranchName("main", "t"),
                delta: { kind: "ahead", ahead },
            },
        }),
    ];

    function suffix(overrides: Partial<Extract<Repo, { kind: "owned" }>>): string {
        const rendered = render(buildReport([owned(branches, overrides)], FOCUS))[0] ?? "";
        return rendered.slice(rendered.indexOf("upstream=origin/main") + "upstream=origin/main".length);
    }

    test("dates the refs the counts came from, and says nothing once this run fetched them", () => {
        const nineDaysAgo = requireUnixSeconds(NOW - 9 * 86_400 - 60, "t");
        expect(suffix({ lastFetch: { kind: "at", at: nineDaysAgo } })).toBe(" last-fetch=9d");
        expect(suffix({ lastFetch: { kind: "never" } })).toBe(" last-fetch=never");
        expect(suffix({ fetch: { kind: "ok", remote: ORIGIN } })).toBe("");
    });

    test("a fetch of another remote leaves the branch's own refs dated", () => {
        const github = requireRemoteName("github", "t");
        expect(suffix({ fetch: { kind: "ok", remote: github } })).toBe(" last-fetch=0d");
    });

    test("counts fetched repos in the summary and flags only remote-derived findings", () => {
        const report = buildReport([owned(branches, { fetch: { kind: "ok", remote: ORIGIN } })], FOCUS);
        expect(report.fetchedRepos).toBe(1);
        expect(renderSummary(1, report, 0)).toBe("1 repos, 1 findings, 1 repos fetched");
        expect(report.findings.map(dependsOnRemote)).toEqual([true]);
        expect(dependsOnRemote({ kind: "LOCAL_ONLY", root: ROOT })).toBe(false);
        expect(dependsOnRemote({ kind: "NO_UPSTREAM", root: ROOT, branch: requireBranchName("x", "t") })).toBe(false);
    });
});

describe("JSON view", () => {
    test("annotates each branch with its visibility and reports only what the text view would", () => {
        const repo = owned([branch("main", { checkout: { kind: "here" } }), branch("feature/x")]);
        const json = toJsonRepo(repo, FOCUS);
        expect(json.kind === "owned" ? json.branches.map((entry) => entry.visibility) : []).toEqual([
            "shown",
            "hidden",
        ]);
        expect(isReportable(repo, FOCUS)).toBe(true);
        expect(isReportable(owned([tracked("main", { kind: "synced" })]), FOCUS)).toBe(false);
        expect(isReportable({ kind: "foreign", root: ROOT, worktree: { kind: "main" }, remotes: [] }, FOCUS)).toBe(
            false,
        );
    });
});
