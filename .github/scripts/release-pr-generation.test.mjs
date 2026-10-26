import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  benchmarkMarker,
  benchmarkPayload,
} from "./proxy-benchmark-baseline.mjs";
import {
  blobSha,
  generatedReceipt,
  generationCommit,
  generationWorkflow,
  packBundle,
  publishGeneration,
  receiptPath,
  selectGeneration,
  verifyGeneration,
} from "./release-pr-generation.mjs";
import {
  benchmarkDocsPath,
  updateBenchmarkTable,
  verifyBenchmarkDocs,
} from "./update-proxy-benchmark-docs.mjs";

const markdown = `<!-- proxy-benchmark-results:start -->\nold\n<!-- proxy-benchmark-results:end -->\n<!-- mcp-gateway-benchmark-results:start -->\nold\n<!-- mcp-gateway-benchmark-results:end -->\n`;
const webp = Buffer.from("RIFF0000WEBPfixture");

// Use real Git blobs, trees, commits and ref ancestry; fake only the remote API.
function fixture(t, initialMarkdown = markdown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-generation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args, input, env = {}) =>
    execFileSync("git", args, {
      cwd: root,
      input,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), data);
  };
  git(["init", "-q"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  write("platform/package.json", '{"version":"1.5.0-rc.10"}');
  write("docs/openapi.json", '{"info":{"version":"1.5.0-rc.9"}}');
  write(benchmarkDocsPath, initialMarkdown);
  git(["add", "."]);
  git(["commit", "-qm", "release source"]);
  const sourceSha = git(["rev-parse", "HEAD"]);
  const branch = "release-please--branches--main--components--platform";
  git(["branch", branch]);
  const source = {
    number: 12,
    state: "open",
    user: { login: "archestra-ci[bot]" },
    base: { sha: sourceSha, ref: "main" },
    head: {
      sha: sourceSha,
      ref: branch,
      repo: { full_name: "example/gateway" },
    },
  };
  const context = {
    repo: { owner: "example", repo: "gateway" },
    payload: { pull_request: source },
    runId: 42,
    runAttempt: 1,
  };
  const identity = { sourceSha, baseSha: sourceSha, runId: 42, attempt: 1 };
  const summary = {
    schemaVersion: 1,
    complete: true,
    gitCommit: sourceSha,
    platformTree: git(["rev-parse", "HEAD:platform"]),
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
  const state = {
    base: sourceSha,
    writes: 0,
    author: "archestra-ci[bot]",
    verified: true,
    run: {
      path: generationWorkflow,
      event: "pull_request",
      head_sha: sourceSha,
      head_branch: branch,
      head_repository: source.head.repo,
      status: "completed",
      conclusion: "success",
    },
  };
  const head = () => git(["rev-parse", `refs/heads/${branch}`]);
  const api = {
    pulls: {
      get: async () => ({
        data: {
          ...structuredClone(source),
          base: { ...source.base, sha: state.base },
          head: { ...source.head, sha: head() },
        },
      }),
    },
    repos: {
      getContent: async ({ path: file, ref }) => {
        let data;
        try {
          data = execFileSync("git", ["show", `${ref}:${file}`], {
            cwd: root,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          throw Object.assign(new Error("missing"), { status: 404 });
        }
        return {
          data: {
            type: "file",
            encoding: "base64",
            size: data.length,
            content: data.toString("base64"),
          },
        };
      },
      getCommit: async ({ ref, page = 1, per_page = 30 }) => {
        const parents = git(["show", "-s", "--format=%P", ref])
          .split(" ")
          .filter(Boolean)
          .map((sha) => ({ sha }));
        const files = git([
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-status",
          "-r",
          ref,
        ])
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [status, filename] = line.split("\t");
            return {
              filename,
              status:
                status === "A"
                  ? "added"
                  : status === "D"
                    ? "removed"
                    : "modified",
              sha:
                status === "D"
                  ? null
                  : git(["rev-parse", `${ref}:${filename}`]),
            };
          });
        return {
          data: {
            sha: ref,
            author: { login: state.author },
            committer: { login: "web-flow" },
            parents,
            commit: {
              verification: { verified: state.verified },
              message: git(["show", "-s", "--format=%B", ref]),
              tree: { sha: git(["rev-parse", `${ref}^{tree}`]) },
            },
            files: files.slice((page - 1) * per_page, page * per_page),
          },
        };
      },
    },
    git: {
      getTree: async ({ tree_sha }) => ({
        data: {
          tree: git(["ls-tree", tree_sha])
            .split("\n")
            .map((line) => {
              const [mode, type, sha, file] = line.split(/\s+/);
              return { mode, type, sha, path: file };
            }),
        },
      }),
      createBlob: async ({ content, encoding }) => ({
        data: {
          sha: git(
            ["hash-object", "-w", "--stdin"],
            Buffer.from(content, encoding),
          ),
        },
      }),
      createTree: async ({ base_tree, tree }) => {
        const env = { GIT_INDEX_FILE: path.join(root, "temporary-index") };
        git(["read-tree", base_tree], undefined, env);
        for (const entry of tree)
          git(
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `${entry.mode},${entry.sha},${entry.path}`,
            ],
            undefined,
            env,
          );
        return { data: { sha: git(["write-tree"], undefined, env) } };
      },
      createCommit: async ({ tree, parents, message }) => ({
        data: {
          sha: git(
            ["commit-tree", tree, ...parents.flatMap((sha) => ["-p", sha])],
            message,
          ),
        },
      }),
      updateRef: async ({ sha, force }) => {
        assert.equal(force, false);
        state.writes++;
        const previous = head();
        git(["merge-base", "--is-ancestor", previous, sha]);
        git(["update-ref", `refs/heads/${branch}`, sha, previous]);
      },
    },
    actions: {
      getWorkflowRunAttempt: async ({ run_id, attempt_number }) => {
        assert.equal(run_id, 42);
        assert.equal(attempt_number, 1);
        return { data: state.run };
      },
    },
  };
  api.issues = { listComments: () => {} };
  api.repos.compareCommits = async ({ base, head: target }) => ({
    data: {
      status: "ahead",
      files: git(["diff", "--name-only", base, target])
        .split("\n")
        .filter(Boolean)
        .map((filename) => ({ filename })),
    },
  });
  const github = {
    rest: api,
    paginate: async () => [
      {
        user: { login: "github-actions[bot]" },
        body: `${benchmarkMarker}\n${benchmarkPayload(summary, sourceSha)}`,
      },
    ],
  };
  const args = {
    github,
    context,
    summary,
    results: {
      openapi: "success",
      screenshots: "success",
      benchmark: "success",
    },
  };
  write("docs/openapi.json", '{"info":{"version":"1.5.0-rc.10"}}');
  args.openapi = packBundle({ root, kind: "openapi", identity });
  git(["checkout", "--", "docs/openapi.json"]);
  write("docs/assets/automated_screenshots/example.webp", webp);
  args.screenshots = packBundle({ root, kind: "screenshots", identity });
  fs.rmSync(path.join(root, "docs/assets"), { recursive: true });
  const finalContext = () => ({
    ...context,
    payload: {
      pull_request: {
        ...structuredClone(source),
        head: { ...source.head, sha: head() },
      },
    },
  });
  return {
    root,
    git,
    write,
    head,
    args,
    state,
    identity,
    context,
    github,
    finalContext,
  };
}

test("three producer outputs publish as one real commit and the generated head is idempotent", async (t) => {
  const f = fixture(t);
  assert.equal(await selectGeneration(f.args), true);
  assert.equal((await verifyGeneration(f.args)).ready, false);
  assert.equal(await publishGeneration(f.args), "updated");
  assert.equal(f.state.writes, 1);
  assert.equal(
    f.git(["rev-list", "--count", `${f.identity.sourceSha}..${f.head()}`]),
    "1",
  );
  assert.equal(
    f.git(["show", `${f.head()}:docs/openapi.json`]),
    '{"info":{"version":"1.5.0-rc.10"}}',
  );
  assert.equal(
    f.git(["show", `${f.head()}:${benchmarkDocsPath}`]),
    updateBenchmarkTable(markdown, f.args.summary).trim(),
  );
  const context = f.finalContext();
  assert.equal(await selectGeneration({ ...f.args, context }), false);
  assert.equal((await verifyGeneration({ ...f.args, context })).ready, true);
  assert.equal((await verifyBenchmarkDocs({ ...f.args, context })).ready, true);
  assert.equal(await publishGeneration(f.args), "unchanged");
  assert.equal(f.state.writes, 1);
});

test("partial failure, wrong attempt, mixed sources and tampered artifacts never move the branch", async (t) => {
  for (const mutate of [
    (f) => {
      f.args.results.screenshots = "failure";
    },
    (f) => {
      f.args.results.benchmark = "cancelled";
    },
    (f) => {
      f.args.openapi.attempt++;
    },
    (f) => {
      f.args.screenshots.sourceSha = "f".repeat(40);
    },
    (f) => {
      f.args.openapi.baseSha = "f".repeat(40);
    },
    (f) => {
      f.args.screenshots.files[0].content =
        Buffer.from("invalid").toString("base64");
    },
    (f) => {
      f.args.openapi.files[0].path = "platform/package.json";
    },
    (f) => {
      f.args.screenshots.files[0].path = "docs/assets/../escape.webp";
    },
    (f) => {
      f.args.summary.gitCommit = "f".repeat(40);
    },
    (f) => {
      f.args.summary.platformTree = "f".repeat(40);
    },
    (f) => {
      f.args.summary.complete = false;
    },
    (f) => {
      f.args.summary.diagnostic = true;
    },
    (f) => {
      f.args.summary.rows[3].successPercent = 99;
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(publishGeneration(f.args));
    assert.equal(f.head(), f.identity.sourceSha);
    assert.equal(f.state.writes, 0);
  }
});

test("late artifacts and source/base changes before or during publication are rejected", async (t) => {
  for (const when of ["before", "during", "base"]) {
    const f = fixture(t);
    const move = () => {
      const sha = f.git(
        [
          "commit-tree",
          f.git(["rev-parse", "HEAD^{tree}"]),
          "-p",
          f.identity.sourceSha,
        ],
        "new source",
      );
      f.git([
        "update-ref",
        `refs/heads/${f.context.payload.pull_request.head.ref}`,
        sha,
      ]);
    };
    if (when === "before") move();
    else if (when === "base") f.state.base = "e".repeat(40);
    else {
      const create = f.github.rest.git.createCommit;
      f.github.rest.git.createCommit = async (args) => {
        const result = await create(args);
        move();
        return result;
      };
    }
    assert.equal(await publishGeneration(f.args), "superseded");
    assert.equal(f.state.writes, 0);
  }
});

test("non-fast-forward and queue lock never cause a forced write or dequeue", async (t) => {
  const f = fixture(t);
  let writes = 0;
  f.github.rest.git.updateRef = async ({ force }) => {
    assert.equal(force, false);
    writes++;
    throw Object.assign(
      new Error(
        "A pull request for this branch has been added to a merge queue. Branches that\nare queued for merging cannot be updated.",
      ),
      { status: 422 },
    );
  };
  assert.match(await publishGeneration(f.args), /^queued;/);
  assert.equal(writes, 1);
  f.github.rest.git.updateRef = async () => {
    throw Object.assign(new Error("Permission denied"), { status: 403 });
  };
  await assert.rejects(publishGeneration(f.args), /Permission denied/);
});

test("a failed, pending or unrelated workflow cannot satisfy generation provenance", async (t) => {
  for (const change of [
    { conclusion: "failure" },
    { status: "in_progress", conclusion: null },
    { path: ".github/workflows/other.yml" },
    { head_sha: "e".repeat(40) },
    { event: "workflow_dispatch" },
    { head_repository: { full_name: "foreign/repo" } },
  ]) {
    const f = fixture(t);
    await publishGeneration(f.args);
    Object.assign(f.state.run, change);
    assert.equal(
      (await verifyGeneration({ ...f.args, context: f.finalContext() })).ready,
      false,
    );
  }
});

test("source changes and forged generation subjects cannot suppress generation", async (t) => {
  const f = fixture(t);
  await publishGeneration(f.args);
  const generated = f.head();
  f.git(["checkout", "-q", f.context.payload.pull_request.head.ref]);
  f.write("platform/package.json", '{"version":"1.5.0-rc.11"}');
  f.git(["add", "."]);
  f.git(["commit", "-qm", generationCommit]);
  assert.equal(
    await selectGeneration({ ...f.args, context: f.finalContext() }),
    true,
  );
  f.git([
    "update-ref",
    `refs/heads/${f.context.payload.pull_request.head.ref}`,
    generated,
  ]);
  f.state.author = "human";
  assert.equal(
    await selectGeneration({ ...f.args, context: f.finalContext() }),
    true,
  );
});

test("receipt hashes bind outputs and reject an extra generated-looking file", async (t) => {
  const f = fixture(t);
  await publishGeneration(f.args);
  f.git(["checkout", "-q", f.context.payload.pull_request.head.ref]);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, receiptPath)));
  receipt.files[0].blob = blobSha(Buffer.from("other"));
  f.write(receiptPath, JSON.stringify(receipt));
  f.git(["add", "."]);
  f.git(["commit", "--amend", "--no-edit", "-q"]);
  assert.equal(
    await generatedReceipt({ ...f.args, context: f.finalContext() }),
    null,
  );
});

test("packing rejects changed source, deletions, symlinks and unrelated codegen output", (t) => {
  for (const change of [
    (f) => {
      f.identity.sourceSha = "a".repeat(40);
    },
    (f) => {
      fs.unlinkSync(path.join(f.root, "docs/openapi.json"));
    },
    (f) => {
      fs.unlinkSync(path.join(f.root, "docs/openapi.json"));
      fs.symlinkSync(
        "../../platform/package.json",
        path.join(f.root, "docs/openapi.json"),
      );
    },
    (f) => {
      f.write("platform/source.ts", "changed");
    },
  ]) {
    const f = fixture(t);
    change(f);
    assert.throws(() =>
      packBundle({ root: f.root, kind: "openapi", identity: f.identity }),
    );
  }
});

test("unchanged generators still attest completion once and then stop", async (t) => {
  const reference = fixture(t);
  const f = fixture(t, updateBenchmarkTable(markdown, reference.args.summary));
  f.args.openapi.files = [];
  f.args.screenshots.files = [];
  assert.equal(await publishGeneration(f.args), "updated");
  const receipt = await generatedReceipt({
    ...f.args,
    context: f.finalContext(),
  });
  assert.deepEqual(receipt.files, []);
  assert.equal(await publishGeneration(f.args), "unchanged");
  assert.equal(
    await selectGeneration({ ...f.args, context: f.finalContext() }),
    false,
  );
  assert.equal(f.state.writes, 1);
});

test("unsigned bot attribution is not accepted as GitHub App provenance", async (t) => {
  const f = fixture(t);
  await publishGeneration(f.args);
  f.state.verified = false;
  assert.equal(
    await generatedReceipt({ ...f.args, context: f.finalContext() }),
    null,
  );
  assert.equal(
    await selectGeneration({ ...f.args, context: f.finalContext() }),
    true,
  );
});
