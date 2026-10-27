import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  benchmarkMarker,
  benchmarkPayload,
} from "./proxy-benchmark-baseline.mjs";
import {
  benchmarkDocsCommit,
  benchmarkDocsPath,
  commitBenchmarkDocs,
  updateBenchmarkTable,
  verifyBenchmarkDocs,
} from "./update-proxy-benchmark-docs.mjs";

function validationFixture() {
  const f = fixture();
  f.comments = [
    {
      user: { login: "github-actions[bot]" },
      body: `${benchmarkMarker}\n${benchmarkPayload(f.summary, f.summary.gitCommit)}`,
    },
  ];
  f.markdown = updateBenchmarkTable(markdown, f.summary);
  f.changes = { status: "ahead", files: [{ filename: benchmarkDocsPath }] };
  f.github.rest.issues = { listComments: () => {} };
  f.github.paginate = async () => f.comments;
  f.github.rest.repos.compareCommits = async () => ({ data: f.changes });
  f.github.rest.repos.getContent = async () => ({
    data: {
      type: "file",
      encoding: "base64",
      size: Buffer.byteLength(f.markdown),
      content: Buffer.from(f.markdown).toString("base64"),
    },
  });
  return f;
}

test("release validation stays pending until both generated tables match the saved benchmark", async () => {
  const f = validationFixture();
  f.markdown = markdown;
  assert.equal((await verifyBenchmarkDocs(f)).ready, false);
  f.markdown = updateBenchmarkTable(markdown, f.summary);
  f.markdown = f.markdown.replace(
    "| 4 vCPU / ~16 GiB RAM | 50 | 5.00 ms",
    "| 4 vCPU / ~16 GiB RAM | 50 | 500.00 ms",
  );
  assert.equal((await verifyBenchmarkDocs(f)).ready, false);
  f.markdown = updateBenchmarkTable(markdown, f.summary);
  assert.equal((await verifyBenchmarkDocs(f)).ready, true);
  const mcpStart = f.markdown.indexOf(
    "<!-- mcp-gateway-benchmark-results:start -->",
  );
  f.markdown =
    f.markdown.slice(0, mcpStart) +
    f.markdown.slice(mcpStart).replace("5.00 ms", "500.00 ms");
  assert.equal((await verifyBenchmarkDocs(f)).ready, false);
  assert.deepEqual(f.writes, []);
});

test("generated tables and screenshots may follow the measurement without another benchmark", async () => {
  const f = validationFixture();
  f.context.payload.pull_request.head.sha = "f".repeat(40);
  f.changes.files.push({ filename: "docs/assets/screenshot.webp" });
  assert.equal((await verifyBenchmarkDocs(f)).ready, true);
  assert.deepEqual(f.writes, []);
});

test("changed code, benchmark configuration, renamed inputs and uncertain ancestry require a new measurement", async () => {
  for (const changes of [
    {
      status: "ahead",
      files: [{ filename: "platform/backend/src/server.ts" }],
    },
    {
      status: "ahead",
      files: [{ filename: ".github/workflows/llm-proxy-benchmark.yml" }],
    },
    {
      status: "ahead",
      files: [
        {
          filename: benchmarkDocsPath,
          previous_filename: "platform/input.json",
        },
      ],
    },
    { status: "diverged", files: [{ filename: benchmarkDocsPath }] },
    { status: "ahead", files: [] },
    {
      status: "ahead",
      files: Array.from({ length: 300 }, () => ({
        filename: benchmarkDocsPath,
      })),
    },
  ]) {
    const f = validationFixture();
    f.context.payload.pull_request.head.sha = "f".repeat(40);
    f.changes = changes;
    assert.equal((await verifyBenchmarkDocs(f)).ready, false);
  }
});

test("missing, failed, malformed, diagnostic and untrusted records cannot pass the release gate", async () => {
  for (const change of [
    (f) => {
      f.comments = [];
    },
    (f) => {
      f.comments[0].user.login = "human";
    },
    (f) => {
      f.comments[0].user.login = "another[bot]";
    },
    (f) => {
      f.comments[0].body = `${benchmarkMarker}\n<!-- archestra-llm-proxy-benchmark-data:v1:AAAA -->`;
    },
    (f) => {
      f.summary.complete = false;
    },
    (f) => {
      f.summary.diagnostic = "cpu-profile";
    },
    (f) => {
      f.summary.webWorkers = 4;
    },
    (f) => {
      f.summary.gitCommit = "e".repeat(40);
    },
    (f) => {
      f.summary.platformTree = "invalid";
    },
    (f) => {
      f.summary.rows[0].overheadMs = null;
    },
    (f) => {
      f.github.rest.git.getTree = async () => ({ data: { tree: [] } });
    },
  ]) {
    const f = validationFixture();
    change(f);
    if (
      f.comments[0]?.body.startsWith(
        `${benchmarkMarker}\n<!-- archestra-llm-proxy-benchmark-data:v1:ey`,
      )
    )
      f.comments[0].body = `${benchmarkMarker}\n${benchmarkPayload(f.summary, "a".repeat(40))}`;
    assert.equal((await verifyBenchmarkDocs(f)).ready, false);
    assert.deepEqual(f.writes, []);
  }
});

test("ordinary PRs, fork branches and manual or merge-group runs do not wait for release codegen", async () => {
  for (const change of [
    (f) => {
      delete f.context.payload.pull_request;
    },
    (f) => {
      f.context.payload.pull_request.user.login = "human";
    },
    (f) => {
      f.context.payload.pull_request.head.ref = "feature/work";
    },
    (f) => {
      f.context.payload.pull_request.head.repo.full_name = "fork/gateway";
    },
  ]) {
    const f = validationFixture();
    change(f);
    f.github.paginate = async () => {
      throw new Error("Must not read comments");
    };
    assert.equal((await verifyBenchmarkDocs(f)).ready, true);
  }
});

test("the required workflow waits for publication and fails closed after its bounded wait", async () => {
  const workflow = await readFile(
    new URL("../workflows/docs.yml", import.meta.url),
    "utf8",
  );
  const script = workflow
    .split("const { verifyBenchmarkDocs } = await import(")[1]
    .split("\n")
    .slice(1)
    .join("\n")
    .split("\n  # Standalone")[0]
    .split("\n")
    .map((line) => line.slice(12))
    .join("\n");
  const execute = new (Object.getPrototypeOf(async () => {}).constructor)(
    "verifyBenchmarkDocs",
    "verifyGeneration",
    "github",
    "context",
    "core",
    "setTimeout",
    script,
  );
  for (const becomesReady of [true, false]) {
    let attempts = 0;
    let failed = false;
    let waits = 0;
    await execute(
      async () => ({ ready: ++attempts === 2 && becomesReady, reason: "test" }),
      async () => ({ ready: true }),
      {},
      {},
      {
        info: () => {},
        setFailed: () => {
          failed = true;
        },
      },
      (callback) => {
        waits++;
        callback();
      },
    );
    assert.equal(failed, !becomesReady);
    assert.equal(attempts, becomesReady ? 2 : 140);
    assert.equal(waits, attempts - 1);
  }
});

const markdown = `---\ntitle: Performance & Latency\n---
<!-- Keep run dates in artifacts. -->
Introduction.
<!-- proxy-benchmark-results:start -->
old table
<!-- proxy-benchmark-results:end -->
Timing boundaries and setup.
<!-- mcp-gateway-benchmark-results:start -->
old mcp table
<!-- mcp-gateway-benchmark-results:end -->
MCP setup.
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
    rows: ["chat", "tools", "stream", "mcp"].map((scenario) => ({
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
  f.summary.rows.find((row) => row.scenario === "tools").overheadMs = {
    p50: 6,
    p95: 7,
    p99: 8,
  };
  f.summary.rows.find((row) => row.scenario === "mcp").overheadMs = {
    p50: 1,
    p95: 2,
    p99: 3,
  };
  f.summary.rows.reverse();
  const result = updateBenchmarkTable(markdown, f.summary);
  assert.ok(result.startsWith(markdown.split("old table")[0]));
  assert.ok(result.includes("-->\nTiming boundaries and setup.\n<!--"));
  assert.ok(result.endsWith(markdown.split("old mcp table")[1]));
  assert.match(
    result,
    /Concurrent tool calls \| Median added latency[\s\S]*\| 50 \| 1.00 ms \| 2.00 ms \| 3.00 ms \|/,
  );
  assert.match(result, /Concurrent HTTP requests \| Median added latency/);
  assert.match(
    result,
    /\| 4 vCPU \/ ~16 GiB RAM \| 50 \| 5.00 ms \| 10.00 ms \| 20.00 ms \|/,
  );
  assert.doesNotMatch(result, /Chat|Streaming|Gateway|Client|Requests\/sec/);
  assert.equal(updateBenchmarkTable(result, f.summary), result);
  assert.doesNotMatch(
    result,
    /\d{4}-\d{2}-\d{2}|first run|baseline missing|\(\+.*%\)/,
  );
});

test("runner resources refresh from each measured host", () => {
  const f = fixture();
  const previous = updateBenchmarkTable(markdown, f.summary);
  f.summary.logicalCpus = 8;
  f.summary.memoryGiB = 31.6;
  const updated = updateBenchmarkTable(previous, f.summary);
  assert.match(
    updated,
    /\| 8 vCPU \/ ~32 GiB RAM \| 50 \| 5.00 ms \| 10.00 ms \| 20.00 ms \|/,
  );
  assert.doesNotMatch(updated, /4 vCPU|16 GiB/);
});

test("diagnostic CPU profiles cannot replace release docs", async () => {
  const f = fixture();
  f.summary.diagnostic = "cpu-profile";
  assert.throws(
    () => updateBenchmarkTable(markdown, f.summary),
    /Only complete/,
  );
  assert.equal(await commitBenchmarkDocs(f), "ineligible");
  assert.equal(f.writes.length, 0);
});

test("manual worker scaling cannot replace the single-process release table", async () => {
  const f = fixture();
  f.summary.webWorkers = 4;
  assert.throws(
    () => updateBenchmarkTable(markdown, f.summary),
    /Only complete/,
  );
  assert.equal(await commitBenchmarkDocs(f), "ineligible");
  assert.equal(f.writes.length, 0);
});

test("partial, unsuccessful, missing, duplicate or injected results cannot replace the docs table", () => {
  for (const change of [
    (s) => {
      s.logicalCpus = 0;
    },
    (s) => {
      s.logicalCpus = 1.5;
    },
    (s) => {
      s.memoryGiB = 0;
    },
    (s) => {
      s.memoryGiB = Number.NaN;
    },
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
      s.rows[0].overheadMs.p95 = null;
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
    (s) => {
      s.rows[3].overheadMs = null;
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
    markdown.replace("mcp-gateway-benchmark-results:end", "missing"),
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
      if (status !== 403) f.current.head.sha = "f".repeat(40);
      throw Object.assign(new Error("GitHub rejected the update"), { status });
    };
    if (status === 403)
      await assert.rejects(commitBenchmarkDocs(f), /rejected/);
    else assert.equal(await commitBenchmarkDocs(f), "superseded");
  }
});

test("a rejected write at an unchanged head fails visibly instead of claiming a race", async () => {
  for (const status of [409, 422]) {
    const f = fixture();
    f.github.rest.git.updateRef = async () => {
      throw Object.assign(new Error("Write rejected without a newer head"), {
        status,
      });
    };
    await assert.rejects(commitBenchmarkDocs(f), /without a newer head/);
  }
});

test("queue entry during publication retains the validated head without retrying the write", async () => {
  const f = fixture();
  let attempts = 0;
  f.github.rest.git.updateRef = async ({ force }) => {
    attempts++;
    assert.equal(force, false);
    throw Object.assign(
      new Error(
        "A pull request for this branch has been added to a merge queue. Branches that\n" +
          "are queued for merging cannot be updated. To modify this branch, dequeue the\n" +
          "associated pull request.",
      ),
      { status: 422 },
    );
  };
  assert.equal(
    await commitBenchmarkDocs(f),
    "queued; retaining validated benchmark artifacts and the queued head",
  );
  assert.equal(attempts, 1);
  assert.equal(f.current.head.sha, f.summary.gitCommit);
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
