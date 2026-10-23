import assert from "node:assert/strict";
import test from "node:test";
import {
  benchmarkDocsCommit,
  benchmarkDocsPath,
  commitBenchmarkDocs,
  updateBenchmarkTable,
} from "./update-proxy-benchmark-docs.mjs";

const markdown = `---\ntitle: Performance & Latency\n---
<!-- Keep run dates in artifacts. -->
Introduction.
<!-- proxy-benchmark-results:start -->
old table
<!-- proxy-benchmark-results:end -->
Timing boundaries and setup.
`;

function fixture() {
  const sha = "a".repeat(40);
  const summary = {
    schemaVersion: 1,
    complete: true,
    gitCommit: sha,
    platformTree: "b".repeat(40),
    logicalCpus: 4,
    memoryGiB: 16,
    repeats: 2,
    requestsPerBlock: 300,
    streamingRequestsPerBlock: 60,
    rows: ["chat", "tools", "stream"].map((scenario) => ({
      scenario,
      concurrency: 50,
      attempted: 600,
      succeeded: 600,
      requestsPerSecond: 100,
      successPercent: 100,
      p50Ms: 10,
      p95Ms: 20,
      p99Ms: 30,
      gatewayMs: scenario === "stream" ? null : { p50: 8, p95: 15, p99: 25 },
      overheadMs: scenario === "stream" ? null : { p50: 5, p95: 10, p99: 20 },
      firstContentP50Ms: scenario === "stream" ? 7 : null,
    })),
  };
  const source = {
    number: 12,
    state: "open",
    user: { login: "archestra-ci[bot]" },
    head: {
      sha,
      ref: "release-please--branches--main--components--platform",
      repo: { full_name: "example/gateway" },
    },
  };
  const current = structuredClone(source);
  const context = {
    repo: { owner: "example", repo: "gateway" },
    payload: { pull_request: source },
  };
  const writes = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: current }) },
      repos: {
        getContent: async () => ({
          data: {
            type: "file",
            encoding: "base64",
            size: Buffer.byteLength(markdown),
            content: Buffer.from(markdown).toString("base64"),
          },
        }),
        getCommit: async () => ({
          data: { commit: { tree: { sha: "c".repeat(40) } } },
        }),
      },
      git: {
        getTree: async () => ({
          data: {
            tree: [
              { path: "platform", type: "tree", sha: summary.platformTree },
            ],
          },
        }),
        createTree: async (args) => {
          writes.push(["tree", args]);
          return { data: { sha: "d".repeat(40) } };
        },
        createCommit: async (args) => {
          writes.push(["commit", args]);
          return { data: { sha: "e".repeat(40) } };
        },
        updateRef: async (args) => writes.push(["ref", args]),
      },
    },
  };
  return {
    github,
    context,
    summary,
    benchmarkResult: "success",
    current,
    writes,
  };
}

test("only the marked table changes; rendering is idempotent and has no dates or release deltas", () => {
  const f = fixture();
  const result = updateBenchmarkTable(markdown, f.summary);
  assert.ok(result.startsWith(markdown.split("old table")[0]));
  assert.ok(result.endsWith(markdown.split("old table")[1]));
  assert.match(result, /Chat \(c=50\) \| 100.0 \| 100.00%/);
  assert.match(result, /Streaming \(c=50\).*— \| —.*7.00/);
  assert.equal(updateBenchmarkTable(result, f.summary), result);
  assert.doesNotMatch(
    result,
    /\d{4}-\d{2}-\d{2}|first run|baseline missing|\(\+.*%\)/,
  );
});

test("partial, unsuccessful, missing, duplicate or injected results cannot replace the docs table", () => {
  for (const change of [
    (s) => {
      s.complete = false;
    },
    (s) => {
      s.rows[0].successPercent = 99;
    },
    (s) => {
      s.rows[0].p50Ms = "| injected |";
    },
    (s) => {
      s.rows[0].gatewayMs = null;
    },
    (s) => {
      s.rows[0].succeeded = 1;
    },
    (s) => {
      s.rows[2].firstContentP50Ms = null;
    },
    (s) => {
      s.rows[2].scenario = "chat";
    },
    (s) => {
      s.rows.pop();
    },
  ]) {
    const f = fixture();
    change(f.summary);
    assert.throws(() => updateBenchmarkTable(markdown, f.summary));
  }
  for (const content of [
    "no markers",
    markdown + markdown,
    markdown.replace("start", "missing"),
  ])
    assert.throws(() => updateBenchmarkTable(content, fixture().summary));
});

test("successful release measurement commits exactly one file on the measured parent without force", async () => {
  const f = fixture();
  assert.equal(await commitBenchmarkDocs(f), "updated");
  assert.equal(f.writes[0][1].tree.length, 1);
  assert.equal(f.writes[0][1].tree[0].path, benchmarkDocsPath);
  assert.equal(f.writes[0][1].base_tree, "c".repeat(40));
  assert.equal(
    f.writes[0][1].tree[0].content,
    updateBenchmarkTable(markdown, f.summary),
  );
  assert.equal(f.writes[1][1].message, benchmarkDocsCommit);
  assert.deepEqual(f.writes[1][1].parents, [f.summary.gitCommit]);
  assert.deepEqual(f.writes[2][1], {
    ...f.context.repo,
    ref: `heads/${f.context.payload.pull_request.head.ref}`,
    sha: "e".repeat(40),
    force: false,
  });
});

test("failure, partial data, wrong measured revision, forks, human and ordinary PRs never write", async () => {
  for (const change of [
    (f) => {
      f.benchmarkResult = "failure";
    },
    (f) => {
      f.summary.complete = false;
    },
    (f) => {
      f.summary.gitCommit = "f".repeat(40);
    },
    (f) => {
      f.context.payload.pull_request.head.repo.full_name = "fork/gateway";
    },
    (f) => {
      f.context.payload.pull_request.user.login = "human";
    },
    (f) => {
      f.context.payload.pull_request.head.ref = "feature/work";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await commitBenchmarkDocs(f), "ineligible");
    assert.deepEqual(f.writes, []);
  }
});

test("closed PRs and newer heads cannot be updated", async () => {
  for (const change of [
    (f) => {
      f.current.state = "closed";
    },
    (f) => {
      f.current.head.sha = "f".repeat(40);
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await commitBenchmarkDocs(f), "superseded");
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  const createCommit = f.github.rest.git.createCommit;
  f.github.rest.git.createCommit = async (args) => {
    const result = await createCommit(args);
    f.current.head.sha = "f".repeat(40);
    return result;
  };
  assert.equal(await commitBenchmarkDocs(f), "superseded");
  assert.ok(f.writes.every(([action]) => action !== "ref"));
});

test("concurrent branch updates are not overwritten; permission failures remain visible", async () => {
  for (const status of [409, 422, 403]) {
    const f = fixture();
    f.github.rest.git.updateRef = async ({ force }) => {
      assert.equal(force, false);
      throw Object.assign(new Error("GitHub rejected the update"), { status });
    };
    if (status === 403)
      await assert.rejects(commitBenchmarkDocs(f), /rejected/);
    else assert.equal(await commitBenchmarkDocs(f), "superseded");
  }
});

test("source mismatch, symlinks and invalid marker blocks cannot produce a docs commit", async () => {
  for (const change of [
    (f) => {
      f.github.rest.git.getTree = async () => ({ data: { tree: [] } });
    },
    (f) => {
      f.github.rest.repos.getContent = async () => ({
        data: { type: "symlink" },
      });
    },
    (f) => {
      f.github.rest.repos.getContent = async () => ({
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from("missing markers").toString("base64"),
        },
      });
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(commitBenchmarkDocs(f));
    assert.deepEqual(f.writes, []);
  }
});

test("already-current tables do not create empty commits", async () => {
  const f = fixture();
  f.github.rest.repos.getContent = async () => ({
    data: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(updateBenchmarkTable(markdown, f.summary)).toString(
        "base64",
      ),
    },
  });
  assert.equal(await commitBenchmarkDocs(f), "unchanged");
  assert.deepEqual(f.writes, []);
});
