import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import ToolModel from "@/models/tool";
import {
  type OpenappaReplayOwner,
  openappaReplayOwner,
} from "@/openappa/replay-owner";
import {
  GUARDRAILS_NOOP_ANNOTATOR_PATH,
  OPENAPPA_ARCHESTRA_ANNOTATOR_PATH,
} from "@/routes/route-paths";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { beforeEach, describe, expect, onTestFinished, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-policy-tests.routes";

const content = `[policy]
version = 2
[[policy.tool]]
name = 'files__read'
delta = { trust = 'suspicious' }
[[policy.tool]]
name = 'mail__send'
delta = {}
requires = { trust = 'trusted' }
`;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const files = [
  {
    path: "traces/tainted.appa",
    content: "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\n",
  },
  { path: "traces/fresh.appa", content: "mcp/mail/send {}\nexpect allow\n" },
  { path: "traces/mismatch.appa", content: "mcp/mail/send {}\nexpect deny\n" },
];
describe("policy replay runs", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async () => {
    config.openappa.enabled = true;
    await GuardrailsPolicyModel.save({
      organizationId: ctx.organizationId,
      content,
      contentHash: hash(content),
      updatedBy: ctx.user.id,
      expectedRevision: 0,
    });
  });
  async function saveFiles(scenarios = files) {
    const saved = await ctx.app.inject({
      method: "PUT",
      url: "/api/openappa/policy-tests",
      payload: { files: scenarios, expectedVersion: "empty" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    return saved.json().version as string;
  }
  test("a disabled Git validation directory rejects both saved runs and editor previews", async () => {
    await OpenAppaGithubSyncModel.save(ctx.organizationId, {
      repo: "example/policy",
      path: "appa.toml",
      ref: "main",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
      validationDirectory: "",
    });
    const collection = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    for (const action of ["run", "preview"]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/openappa/policy-tests/${action}`,
        payload: {
          files: [files[0]],
          sourceVersion: collection.json().version,
        },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.message).toContain("Validation is disabled");
    }
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(0);
    await OpenAppaGithubSyncModel.setInterval(ctx.organizationId, null);
    const local = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(local.json()).toMatchObject({
      source: "local",
      directory: "traces",
      activeDirectory: "traces",
    });
  });
  test("editor preview uses real replay without creating or replacing a saved suite run", async () => {
    const sourceVersion = await saveFiles();
    const suite = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: { files, sourceVersion },
    });
    expect(suite.statusCode, suite.body).toBe(200);
    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    const draft = { ...files[1], content: "mcp/mail/send {}\nexpect deny\n" };
    const preview = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/preview",
      payload: { files: [draft], sourceVersion },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      draft: true,
      validation: { valid: true },
      files: [
        {
          path: draft.path,
          status: "failed",
          steps: [{ expected: "deny", actual: "allow", status: "failed" }],
        },
      ],
    });
    expect(preview.json()).not.toHaveProperty("id");
    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    expect(after.json()).toEqual(before.json());
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(1);
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual(files);
  });
  test("editor preview rejects batches and stale sources without saving results", async () => {
    for (const previewFiles of [[], files]) {
      const invalid = await ctx.app.inject({
        method: "POST",
        url: "/api/openappa/policy-tests/preview",
        payload: { files: previewFiles, sourceVersion: "empty" },
      });
      expect(invalid.statusCode, invalid.body).toBe(400);
    }
    const conflict = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/preview",
      payload: { files: [files[0]], sourceVersion: "stale" },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
  });
  /**
   * This process's own loopback endpoints, which no test server listens on:
   * the no-op annotator answers, the archestra annotator answers 503 after
   * noting whose replay its capability names.
   */
  async function serveHostAnnotators() {
    const asked: (OpenappaReplayOwner | null)[] = [];
    const server = createServer((request, reply) => {
      request.resume();
      request.on("end", () => {
        if (request.url === GUARDRAILS_NOOP_ANNOTATOR_PATH) {
          reply.writeHead(200, { "content-type": "application/json" });
          reply.end(JSON.stringify(guardrailsPolicyService.annotate()));
          return;
        }
        if (request.url === OPENAPPA_ARCHESTRA_ANNOTATOR_PATH)
          asked.push(
            openappaReplayOwner(
              request.headers["x-archestra-openappa-context"] as string,
            ),
          );
        reply.writeHead(503).end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = config.api.port;
    config.api.port = (server.address() as AddressInfo).port;
    onTestFinished(async () => {
      config.api.port = port;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return asked;
  }
  test("the shipped default replays through its annotators live, stopping only at a step no answer covers", async () => {
    const asked = await serveHostAnnotators();
    const shipped = initialPolicy();
    await GuardrailsPolicyModel.save({
      organizationId: ctx.organizationId,
      content: shipped,
      contentHash: hash(shipped),
      updatedBy: ctx.user.id,
      expectedRevision: 1,
    });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    // A client built-in the claude-code battery labels statically.
    const read = 'host/archestra/Read {\n  file_path: "README.md"\n}\n';
    const scenarios = [
      {
        path: "traces/static.appa",
        content: `${read}expect allow\nmcp/archestra/ask_user {}\nexpect allow\n`,
      },
      {
        path: "traces/wrong.appa",
        content: `${read}expect deny\n`,
      },
      {
        path: "traces/sandbox.appa",
        content: `${read}expect allow\nmcp/archestra/run_command {}\nexpect deny\n`,
      },
      {
        path: "traces/unruled.appa",
        content: "mcp/notes/read {}\nexpect allow\n",
      },
      // Codex's shell reaches the client battery's Bash rules as a dispatch
      // does, so its credential read is labelled without a model.
      {
        path: "traces/codex-shell.appa",
        content:
          'host/archestra/exec_command {\n  cmd: "cat ~/.aws/credentials"\n}\nexpect allow\n',
      },
    ];
    const sourceVersion = await saveFiles(scenarios);
    const run = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: { files: scenarios, sourceVersion },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({
      validation: { valid: true },
      files: [
        { path: scenarios[0].path, status: "passed" },
        {
          path: scenarios[1].path,
          status: "failed",
          steps: [{ expected: "deny", actual: "allow" }],
        },
        {
          path: scenarios[2].path,
          status: "cannot_run",
          steps: [
            { line: 1, status: "passed" },
            { line: 5, status: "cannot_run", actual: null },
          ],
        },
        {
          path: scenarios[3].path,
          status: "cannot_run",
          steps: [{ line: 1, status: "cannot_run", actual: null }],
        },
        { path: scenarios[4].path, status: "passed" },
      ],
    });
    // The archestra annotator was asked for the run, filed under its caller.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).toEqual(
      asked.map(() => ({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
      })),
    );
  });
  test("uses real replay state and file isolation, stores outcomes and snapshots", async () => {
    const sourceVersion = await saveFiles();
    const run = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: { files, sourceVersion },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({
      draft: false,
      policyRevision: 1,
      validation: { valid: true },
      files: [
        { path: files[0].path, assertionCount: 2, status: "passed" },
        { path: files[1].path, assertionCount: 1, status: "passed" },
        { path: files[2].path, assertionCount: 1, status: "failed" },
      ],
    });
    expect(run.json().files[2].steps[0]).toMatchObject({
      expected: "deny",
      actual: "allow",
    });
    const evidence = await OpenAppaPolicyTestsModel.listRuns(
      ctx.organizationId,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0].result.snapshots).toMatchObject({
      files,
      rootContent: content,
    });
    const history = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    expect(history.json()[0]).toMatchObject({ id: run.json().id });
  });
  test("saved runs reject stale versions, subsets and draft bytes without replacing history", async () => {
    const sourceVersion = await saveFiles();
    const savedRun = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: { files: [...files].reverse(), sourceVersion },
    });
    expect(savedRun.statusCode, savedRun.body).toBe(200);
    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    for (const payload of [
      { files, sourceVersion: "stale" },
      { files: [files[0]], sourceVersion },
      {
        files: files.map((file, index) =>
          index === 0 ? { ...file, content: `${file.content}# draft\n` } : file,
        ),
        sourceVersion,
      },
      {
        files: [...files, { ...files[0], path: "new.appa" }],
        sourceVersion,
      },
    ]) {
      const rejected = await ctx.app.inject({
        method: "POST",
        url: "/api/openappa/policy-tests/run",
        payload,
      });
      expect(rejected.statusCode, rejected.body).toBe(409);
    }
    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    expect(after.json()).toEqual(before.json());
  });
  test("a partial run records one saved file and refuses its unsaved draft", async () => {
    const sourceVersion = await saveFiles();
    const single = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: { files: [files[1]], sourceVersion, partial: true },
    });
    expect(single.statusCode, single.body).toBe(200);
    expect(single.json()).toMatchObject({
      partial: true,
      files: [{ path: files[1].path, status: "passed" }],
    });
    const draft = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: {
        files: [{ ...files[1], content: `${files[1].content}# draft\n` }],
        sourceVersion,
        partial: true,
      },
    });
    expect(draft.statusCode, draft.body).toBe(409);
    const runs = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    expect(runs.json()).toHaveLength(1);
  });
  test("keeps each saved file's newest result past the 20 most recent runs", async () => {
    const sourceVersion = await saveFiles();
    const suite = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: { files, sourceVersion },
    });
    expect(suite.statusCode, suite.body).toBe(200);
    for (let index = 0; index < 21; index++) {
      const single = await ctx.app.inject({
        method: "POST",
        url: "/api/openappa/policy-tests/run",
        payload: { files: [files[1]], sourceVersion, partial: true },
      });
      expect(single.statusCode, single.body).toBe(200);
    }
    const runs = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    const ids = runs.json().map((run: { id: string }) => run.id);
    // 20 single-file runs plus the suite run, still the newest result for
    // the two files no later run replayed.
    expect(ids).toHaveLength(21);
    expect(ids.at(-1)).toBe(suite.json().id);
  });
  test("keeps empty scenario files as cannot-run rather than false passing coverage", async () => {
    const emptyFiles = [{ path: "empty.appa", content: "# no assertions\n" }];
    const sourceVersion = await saveFiles(emptyFiles);
    const run = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: {
        files: emptyFiles,
        sourceVersion,
      },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({
      draft: false,
      files: [{ assertionCount: 0, status: "cannot_run" }],
    });
  });
  test("saves valid oversized multibyte effective policies as cannot-run instead of throwing", async () => {
    const sourceVersion = await saveFiles([files[0]]);
    const oversized = `[policy]\nversion = 2\n[[policy.tool]]\nname = 'files__read'\ndescription = '${"é".repeat(131072)}'\ndelta = {}\n`;
    expect(oversized.length).toBeLessThan(262144);
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(262144);
    await GuardrailsPolicyModel.save({
      organizationId: ctx.organizationId,
      content: oversized,
      contentHash: hash(oversized),
      updatedBy: ctx.user.id,
      expectedRevision: 1,
    });
    const run = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: { files: [files[0]], sourceVersion },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(
      run.json().validation.valid,
      run
        .json()
        .validation.errors.map((error: string) => error.slice(0, 300))
        .join("; "),
    ).toBe(true);
    expect(run.json()).toMatchObject({
      validation: { valid: true },
      files: [{ status: "cannot_run", assertionCount: 0 }],
    });
    expect(run.json().files[0].error).toContain("256 KiB");
    const stored = await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId);
    expect(stored).toHaveLength(1);
    expect(stored[0].result).toMatchObject({
      files: [{ status: "cannot_run" }],
    });
  });
  test("a policy changed while native replay waits leaves the run recording the policy it replayed", async () => {
    const sourceVersion = await saveFiles([files[0]]);
    const native = await import("@archestra/openappa-rs");
    const replay = native.replayOpenappaPolicy;
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi
      .spyOn(native, "replayOpenappaPolicy")
      .mockImplementation(async (input) => {
        entered();
        await waiting;
        return replay(input);
      });
    try {
      const pending = ctx.app.inject({
        method: "POST",
        url: "/api/openappa/policy-tests/run",
        payload: { files: [files[0]], sourceVersion },
      });
      await started;
      const changed = `${content}\n# policy changed during replay\n`;
      await GuardrailsPolicyModel.save({
        organizationId: ctx.organizationId,
        content: changed,
        contentHash: hash(changed),
        updatedBy: ctx.user.id,
        expectedRevision: 1,
      });
      release();
      const run = await pending;
      expect(run.statusCode, run.body).toBe(200);
      expect(run.json()).toMatchObject({
        policyRevision: 1,
        policyHash: hash(content),
        files: [{ status: "passed" }],
      });
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
