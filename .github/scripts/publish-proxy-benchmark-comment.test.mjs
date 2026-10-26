import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  benchmarkMarker,
  benchmarkPayload,
  findReleaseBenchmark,
} from "./proxy-benchmark-baseline.mjs";
import { publishBenchmarkComment } from "./publish-proxy-benchmark-comment.mjs";

function fixture() {
  const sha = "a".repeat(40);
  const comments = [];
  const context = {
    eventName: "pull_request",
    repo: { owner: "example", repo: "gateway" },
    runId: 123,
    payload: {
      pull_request: {
        number: 12,
        base: { ref: "main", sha: "f".repeat(40) },
        head: {
          sha,
          ref: "release-please--branches--main--components--platform",
          repo: { full_name: "example/gateway" },
        },
      },
    },
  };
  let currentSha = sha;
  const calls = [];
  const releases = [
    {
      tag_name: "platform-v1.5.0-rc.3",
      draft: false,
      prerelease: true,
      published_at: "2026-10-20T00:00:00Z",
    },
  ];
  const previousComments = [];
  const previousPr = {
    number: 11,
    merged_at: "2026-10-20T00:00:00Z",
    merge_commit_sha: "e".repeat(40),
    head: {
      sha: "b".repeat(40),
      ref: "release-please--branches--main--components--platform",
      repo: { full_name: "example/gateway" },
    },
  };
  const lookups = [];
  const github = {
    rest: {
      repos: {
        listReleases() {},
        listPullRequestsAssociatedWithCommit() {},
        compareCommits: async () => ({ data: { status: "ahead" } }),
        getCommit: async ({ ref }) => {
          lookups.push(ref);
          return {
            data: {
              sha: "e".repeat(40),
              commit: {
                tree: { sha: "f".repeat(40) },
                message: "release source",
              },
            },
          };
        },
      },
      git: {
        getTree: async () => ({
          data: {
            tree: [{ path: "platform", type: "tree", sha: "c".repeat(40) }],
          },
        }),
      },
      pulls: { get: async () => ({ data: { head: { sha: currentSha } } }) },
      issues: {
        listComments() {},
        createComment: async (args) => {
          calls.push(["create", args]);
          comments.push({ id: 9, body: args.body, user: { type: "Bot" } });
        },
        updateComment: async (args) => {
          calls.push(["update", args]);
          comments.find((c) => c.id === args.comment_id).body = args.body;
        },
      },
    },
    paginate: async (method, args) => {
      if (method === github.rest.repos.listReleases) return releases;
      if (method === github.rest.repos.listPullRequestsAssociatedWithCommit)
        return [previousPr];
      return args.issue_number === 11 ? previousComments : comments;
    },
  };
  return {
    github,
    context,
    releases,
    previousComments,
    previousPr,
    lookups,
    comments,
    calls,
    setHead: (value) => {
      currentSha = value;
    },
    summary: {
      schemaVersion: 1,
      complete: true,
      gitCommit: sha,
      platformTree: "d".repeat(40),
      comparison: {
        workloadVersion: "test-v1",
        node: "v24",
        os: "Linux",
        arch: "x64",
        cpu: "Test CPU",
        auth: "passthrough-virtual-key",
        logicalCpus: 4,
        memoryGiB: 8,
        count: 300,
        streamCount: 60,
        warmup: 30,
        repeats: 2,
        concurrencyLevels: [1, 10, 50],
        scenarios: ["chat"],
        mock: { benchmarkMock: 1, chunks: 20, intervalMs: 10 },
      },
      logicalCpus: 4,
      memoryGiB: 8,
      repeats: 2,
      requestsPerBlock: 300,
      streamingRequestsPerBlock: 60,
      rows: [
        {
          scenario: "chat",
          concurrency: 50,
          requestsPerSecond: 100,
          successPercent: 100,
          p50Ms: 10,
          p95Ms: 20,
          p99Ms: 30,
          gatewayMs: { p50: 5, p95: 10, p99: 20 },
          overheadMs: { p50: 4, p95: 8, p99: 16 },
          firstContentP50Ms: null,
        },
      ],
    },
    benchmarkResult: "success",
  };
}

test("later runs update the existing bot comment instead of adding comments", async () => {
  const f = fixture();
  assert.equal(await publishBenchmarkComment(f), "created");
  const next = "b".repeat(40);
  f.setHead(next);
  f.context.payload.pull_request.head.sha = next;
  f.summary.gitCommit = next;
  assert.equal(await publishBenchmarkComment(f), "updated");
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0].body, new RegExp(next));
  assert.deepEqual(
    f.calls.map(([action]) => action),
    ["create", "update"],
  );
});

test("diagnostic CPU profiles cannot become saved release measurements", async () => {
  const f = fixture();
  f.summary.diagnostic = "cpu-profile";
  assert.equal(await publishBenchmarkComment(f), "created");
  const body = f.comments[0].body;
  assert.doesNotMatch(body, /\| HTTP proxy request/);
  const encoded = body.match(/data:v1:([A-Za-z0-9+/=]+)/)[1];
  assert.equal(JSON.parse(Buffer.from(encoded, "base64")).summary, null);
});

test("superseded runs cannot replace results for a newer commit", async () => {
  const f = fixture();
  f.setHead("b".repeat(40));
  assert.equal(await publishBenchmarkComment(f), "superseded");
  assert.equal(f.calls.length, 0);
  f.setHead(f.context.payload.pull_request.head.sha);
  f.github.paginate = async () => {
    f.setHead("c".repeat(40));
    return [];
  };
  assert.equal(await publishBenchmarkComment(f), "superseded");
  assert.equal(f.calls.length, 0);
});

test("setup failure replaces old green results with an explicit failure", async () => {
  const f = fixture();
  await publishBenchmarkComment(f);
  f.summary = null;
  f.benchmarkResult = "failure";
  assert.equal(await publishBenchmarkComment(f), "updated");
  assert.match(f.comments[0].body, /did not complete successfully/);
  assert.doesNotMatch(f.comments[0].body, /Completed successfully/);
});

test("forks and ordinary feature PRs cannot publish release comments", async () => {
  const f = fixture();
  f.context.payload.pull_request.head.repo.full_name = "fork/gateway";
  assert.equal(await publishBenchmarkComment(f), "ineligible");
  f.context.payload.pull_request.head.repo.full_name = "example/gateway";
  f.context.payload.pull_request.head.ref = "feature/work";
  assert.equal(await publishBenchmarkComment(f), "ineligible");
  assert.equal(f.calls.length, 0);
});

test("results from a different commit cannot be presented as current", async () => {
  const f = fixture();
  f.summary.gitCommit = "b".repeat(40);
  await publishBenchmarkComment(f);
  assert.match(f.comments[0].body, /did not complete successfully/);
  assert.doesNotMatch(f.comments[0].body, /Completed successfully/);
});

test("workflow selects release updates and benchmark changes without loading unrelated PRs", async () => {
  const workflow = await readFile(
    new URL("../workflows/llm-proxy-benchmark.yml", import.meta.url),
    "utf8",
  );
  const script = workflow
    .split("          script: |\n")[1]
    .split("\n      #")[0]
    .split("\n")
    .map((line) => line.slice(12))
    .join("\n");
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)(
    "github",
    "context",
    "core",
    script,
  );
  const f = fixture();
  const output = {};
  const core = {
    setOutput: (key, value) => {
      output[key] = value;
    },
  };
  f.github.rest.pulls.listFiles = () => {};
  f.github.paginate = async () => [{ filename: "platform/CHANGELOG.md" }];
  await execute(f.github, f.context, core);
  assert.deepEqual(output, { run: "true", release: "true" });
  f.github.rest.repos.getCommit = async () => ({
    data: {
      commit: { message: "docs: update proxy benchmark results" },
      parents: [{ sha: "f".repeat(40) }],
      files: [
        {
          filename: "docs/pages/admin/observability/performance-benchmarks.md",
          status: "modified",
        },
      ],
    },
  });
  // The coordinator owns loop prevention. A selected legacy generated head
  // still needs a measurement artifact; skipping here would strand publication.
  f.github.paginate = async () => [{ filename: "platform/benchmarks/run.mjs" }];
  await execute(f.github, f.context, core);
  assert.deepEqual(output, { run: "true", release: "true" });
  const generatedCommit = await f.github.rest.repos.getCommit();
  generatedCommit.data.files.push({
    filename: "platform/backend/src/server.ts",
    status: "modified",
  });
  f.github.rest.repos.getCommit = async () => generatedCommit;
  await execute(f.github, f.context, core);
  assert.deepEqual(output, { run: "true", release: "true" });
  f.context.payload.pull_request.head.ref = "feature/work";
  f.github.paginate = async () => [{ filename: "platform/CHANGELOG.md" }];
  await execute(f.github, f.context, core);
  assert.deepEqual(output, { run: "false", release: "false" });
  f.github.paginate = async () => [{ filename: "platform/benchmarks/run.mjs" }];
  await execute(f.github, f.context, core);
  assert.deepEqual(output, { run: "true", release: "false" });
});

test("malformed measurement content replaces stale success without rendering artifact text", async () => {
  const f = fixture();
  await publishBenchmarkComment(f);
  f.summary.rows = [{ scenario: "injected | table" }];
  await publishBenchmarkComment(f);
  assert.match(f.comments[0].body, /measurement summary was invalid/);
  assert.doesNotMatch(f.comments[0].body, /injected|Completed successfully/);
});

function savePrevious(f, transform = (s) => s) {
  const summary = transform(structuredClone(f.summary));
  summary.gitCommit = f.previousPr.head.sha;
  summary.platformTree = "c".repeat(40);
  f.previousComments.push({
    user: { type: "Bot" },
    body: `${benchmarkMarker}\n${benchmarkPayload(summary, summary.gitCommit)}`,
  });
  return summary;
}

test("release comments compare every percentile and numeric cell with the published release", async () => {
  const f = fixture();
  savePrevious(f, (s) => {
    s.rows[0].requestsPerSecond = 50;
    s.rows[0].successPercent = 90;
    s.rows[0].p50Ms = 20;
    s.rows[0].p95Ms = 40;
    s.rows[0].p99Ms = 60;
    s.rows[0].gatewayMs = { p50: 10, p95: 20, p99: 40 };
    s.rows[0].overheadMs = { p50: 8, p95: 16, p99: 32 };
    return s;
  });
  await publishBenchmarkComment(f);
  const body = f.comments[0].body;
  assert.match(body, /100.0 \(\+100.0%\)/);
  assert.match(body, /100.00% \(\+11.1%\)/);
  assert.match(body, /5.00 \(-50.0%\) \/ 10.00 \(-50.0%\) \/ 20.00 \(-50.0%\)/);
  assert.match(body, /4.00 \(-50.0%\) \/ 8.00 \(-50.0%\) \/ 16.00 \(-50.0%\)/);
  assert.match(
    body,
    /10.00 \(-50.0%\) \/ 20.00 \(-50.0%\) \/ 30.00 \(-50.0%\)/,
  );
  assert.match(body, /\| — \|\n/);
  assert.match(body, /Percentages compare with `platform-v1.5.0-rc.3`/);
  assert.match(body, /archestra-llm-proxy-benchmark-data:v1:/);
});

test("first runs and missing, legacy or unsuccessful release records are distinct", async () => {
  const f = fixture();
  assert.equal((await findReleaseBenchmark(f)).state, "first-run");
  f.previousComments.push({ user: { type: "Bot" }, body: benchmarkMarker });
  assert.match(
    (await findReleaseBenchmark(f)).reason,
    /machine-readable metrics/,
  );
  f.previousComments.length = 0;
  f.previousComments.push({
    user: { type: "Bot" },
    body: benchmarkMarker + benchmarkPayload(null, f.previousPr.head.sha),
  });
  assert.match(
    (await findReleaseBenchmark(f)).reason,
    /successful complete benchmark/,
  );
  f.releases.length = 0;
  assert.match(
    (await findReleaseBenchmark(f)).reason,
    /no earlier published platform release/,
  );
});

test("stale revisions, different released source trees and invalid saved data cannot become a baseline", async () => {
  for (const mode of ["stale", "tree", "invalid", "corrupt"]) {
    const f = fixture();
    savePrevious(f, (s) => {
      if (mode === "invalid") s.rows[0].p50Ms = "injected";
      return s;
    });
    if (mode === "stale") f.previousPr.head.sha = "0".repeat(40);
    if (mode === "tree")
      f.github.rest.git.getTree = async () => ({ data: { tree: [] } });
    if (mode === "corrupt")
      f.previousComments[0].body =
        benchmarkMarker + "<!-- archestra-llm-proxy-benchmark-data:v1:AAAA -->";
    assert.equal((await findReleaseBenchmark(f)).state, "missing", mode);
  }
});

test("generated docs may follow a measurement, but changed execution inputs and truncated comparisons cannot", async () => {
  for (const mode of [
    "docs",
    "source",
    "workflow",
    "renamed",
    "diverged",
    "truncated",
    "tree",
  ]) {
    const f = fixture();
    savePrevious(f);
    f.previousPr.head.sha = "0".repeat(40);
    f.github.rest.repos.compareCommits = async ({ base }) => ({
      data: {
        status:
          mode === "diverged" && !base.startsWith("platform-v")
            ? "diverged"
            : "ahead",
        files:
          mode === "truncated"
            ? Array(300).fill({ filename: "docs/example.md" })
            : [
                {
                  filename:
                    mode === "source"
                      ? "platform/backend/src/server.ts"
                      : mode === "workflow"
                        ? ".github/workflows/llm-proxy-benchmark.yml"
                        : "docs/pages/admin/observability/performance-benchmarks.md",
                  ...(mode === "renamed"
                    ? { previous_filename: "platform/backend/src/server.ts" }
                    : {}),
                },
              ],
      },
    });
    if (mode === "tree")
      f.github.rest.git.getTree = async () => ({ data: { tree: [] } });
    assert.equal(
      (await findReleaseBenchmark(f)).state,
      mode === "docs" ? "available" : "missing",
      mode,
    );
  }
});

test("missing last-release numbers never silently fall back to an older release", async () => {
  const f = fixture();
  f.releases.push({
    ...f.releases[0],
    tag_name: "platform-v1.5.0-rc.2",
    published_at: "2026-10-19T00:00:00Z",
  });
  assert.equal((await findReleaseBenchmark(f)).state, "first-run");
  assert.deepEqual(f.lookups, ["platform-v1.5.0-rc.3"]);
});

test("stable release tracks exclude other minors and prereleases", async () => {
  const f = fixture();
  f.context.payload.pull_request.base.ref = "release/1.4";
  f.releases.push({
    tag_name: "platform-v1.4.8",
    draft: false,
    prerelease: false,
    published_at: "2026-10-18T00:00:00Z",
  });
  await findReleaseBenchmark(f);
  assert.deepEqual(f.lookups, ["platform-v1.4.8"]);
});

test("API failure is explicit and saved artifact metadata cannot terminate an HTML comment", async () => {
  const f = fixture();
  f.github.rest.repos.compareCommits = async () => {
    throw Error("unavailable");
  };
  assert.match((await findReleaseBenchmark(f)).reason, /could not be read/);
  assert.doesNotMatch(
    benchmarkPayload({ comparison: { cpu: "--> injected" } }, "a".repeat(40)),
    /injected/,
  );
});

test("oversized metadata cannot overflow the sticky comment payload", () => {
  const payload = benchmarkPayload(
    { unexpected: "x".repeat(65536) },
    "a".repeat(40),
  );
  assert.ok(payload.length < 1000);
  assert.match(
    Buffer.from(payload.split(":v1:")[1].split(" ")[0], "base64").toString(),
    /"summary":null/,
  );
});

test("a release outside the base ancestry is skipped before selecting its benchmark", async () => {
  const f = fixture();
  f.releases.unshift({
    ...f.releases[0],
    tag_name: "platform-v9.0.0",
    published_at: "2026-10-22T00:00:00Z",
  });
  f.github.rest.repos.compareCommits = async ({ base }) => ({
    data: { status: base === "platform-v9.0.0" ? "diverged" : "ahead" },
  });
  await findReleaseBenchmark(f);
  assert.deepEqual(f.lookups, ["platform-v1.5.0-rc.3"]);
});

test("a release squashed on top of later commits still supplies its measured baseline", async () => {
  const f = fixture();
  savePrevious(f);
  // The release commit's tree includes a change merged after the release
  // PR was measured; the measured revision's tree matches the saved one.
  const trees = { [f.previousPr.head.sha]: "1".repeat(40) };
  f.github.rest.repos.getCommit = async ({ ref }) => {
    f.lookups.push(ref);
    return {
      data: {
        sha: "e".repeat(40),
        commit: { tree: { sha: trees[ref] ?? "2".repeat(40) } },
      },
    };
  };
  f.github.rest.git.getTree = async ({ tree_sha }) => ({
    data: {
      tree: [
        {
          path: "platform",
          type: "tree",
          sha: tree_sha === "1".repeat(40) ? "c".repeat(40) : "9".repeat(40),
        },
      ],
    },
  });
  const baseline = await findReleaseBenchmark(f);
  assert.equal(baseline.state, "available");
  assert.equal(baseline.tag, "platform-v1.5.0-rc.3");
});

test("the first release of a new track and a new major version compare with the release before them", async () => {
  const f = fixture();
  // release/1.6 has no 1.6 stable release yet: it was cut from 1.6.0-rc.3.
  f.context.payload.pull_request.base.ref = "release/1.6";
  f.releases.length = 0;
  f.releases.push({
    tag_name: "platform-v1.6.0-rc.3",
    draft: false,
    prerelease: true,
    published_at: "2026-10-20T00:00:00Z",
  });
  await findReleaseBenchmark(f);
  assert.deepEqual(f.lookups, ["platform-v1.6.0-rc.3"]);

  const main = fixture();
  main.releases.length = 0;
  main.releases.push({
    tag_name: "platform-v1.9.4",
    draft: false,
    prerelease: false,
    published_at: "2026-10-20T00:00:00Z",
  });
  // A 2.0.0 release PR on main.
  await findReleaseBenchmark(main);
  assert.deepEqual(main.lookups, ["platform-v1.9.4"]);
});

test("the previous release measured again on this runner is the baseline", async () => {
  const f = fixture();
  savePrevious(f, (s) => {
    s.rows[0].p99Ms = 300;
    return s;
  });
  const remeasured = structuredClone(f.summary);
  remeasured.gitCommit = "e".repeat(40); // The release tag's commit.
  remeasured.platformTree = "c".repeat(40);
  remeasured.rows[0].p99Ms = 60;
  await publishBenchmarkComment({ ...f, remeasured });
  const body = f.comments[0].body;
  assert.match(body, /measured again on this runner/);
  assert.match(body, /30.00 \(-50.0%\)/);
});

test("a re-measurement of another revision or source tree falls back to saved metrics", async () => {
  for (const change of [
    { gitCommit: "0".repeat(40) },
    { platformTree: "0".repeat(40) },
    { complete: false },
  ]) {
    const f = fixture();
    savePrevious(f);
    const remeasured = {
      ...structuredClone(f.summary),
      gitCommit: "e".repeat(40),
      platformTree: "c".repeat(40),
      ...change,
    };
    const baseline = await findReleaseBenchmark({ ...f, remeasured });
    assert.equal(baseline.state, "available");
    assert.equal(baseline.sameRunner, undefined, JSON.stringify(change));
  }
});
