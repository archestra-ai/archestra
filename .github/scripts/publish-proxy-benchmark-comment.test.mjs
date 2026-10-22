import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { publishBenchmarkComment } from "./publish-proxy-benchmark-comment.mjs";

function fixture() {
  const sha = "a".repeat(40);
  const comments = [];
  const context = {
    repo: { owner: "example", repo: "gateway" },
    runId: 123,
    payload: {
      pull_request: {
        number: 12,
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
  const github = {
    rest: {
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
    paginate: async () => comments,
  };
  return {
    github,
    context,
    comments,
    calls,
    setHead: (value) => { currentSha = value; },
    summary: {
      schemaVersion: 1,
      complete: true,
      gitCommit: sha,
      logicalCpus: 4,
      memoryGiB: 8,
      repeats: 2,
      requestsPerBlock: 300,
      streamingRequestsPerBlock: 60,
      rows: [{
        scenario: "chat", concurrency: 50, requestsPerSecond: 100,
        successPercent: 100, p50Ms: 10, p95Ms: 20, p99Ms: 30,
        firstContentP50Ms: null,
      }],
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
  assert.deepEqual(f.calls.map(([action]) => action), ["create", "update"]);
});

test("superseded runs cannot replace results for a newer commit", async () => {
  const f = fixture();
  f.setHead("b".repeat(40));
  assert.equal(await publishBenchmarkComment(f), "superseded");
  assert.equal(f.calls.length, 0);
  f.setHead(f.context.payload.pull_request.head.sha);
  f.github.paginate = async () => { f.setHead("c".repeat(40)); return []; };
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
  const workflow = await readFile(new URL("../workflows/llm-proxy-benchmark.yml", import.meta.url), "utf8");
  const script = workflow.split("          script: |\n")[1].split("\n  benchmark:")[0].split("\n").map((line) => line.slice(12)).join("\n");
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)("github", "context", "core", script);
  const f = fixture();
  const output = {};
  const core = { setOutput: (key, value) => { output[key] = value; } };
  f.github.rest.pulls.listFiles = () => {};
  f.github.paginate = async () => [{ filename: "platform/CHANGELOG.md" }];
  await execute(f.github, f.context, core);
  assert.deepEqual(output, { run: "true", release: "true" });
  f.context.payload.pull_request.head.ref = "feature/work";
  await execute(f.github, f.context, core);
  assert.deepEqual(output, { run: "false", release: "false" });
  f.github.paginate = async () => [{ filename: "platform/benchmarks/run.mjs" }];
  await execute(f.github, f.context, core);
  assert.deepEqual(output, { run: "true", release: "false" });
});

test("malformed measurement content replaces stale success without rendering artifact text", async () => {
  const f = fixture();
  await publishBenchmarkComment(f);
  f.summary.rows = [{scenario: "injected | table"}];
  await publishBenchmarkComment(f);
  assert.match(f.comments[0].body, /measurement summary was invalid/);
  assert.doesNotMatch(f.comments[0].body, /injected|Completed successfully/);
});
