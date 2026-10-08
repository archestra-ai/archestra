import { createHash } from "node:crypto";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import ToolModel from "@/models/tool";
import { initialPolicy } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
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
      stale: false,
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
  test("the shipped default replays through its annotators, stopping only at a step no offline answer covers", async () => {
    const shipped = initialPolicy();
    await GuardrailsPolicyModel.save({
      organizationId: ctx.organizationId,
      content: shipped,
      contentHash: hash(shipped),
      updatedBy: ctx.user.id,
      expectedRevision: 1,
    });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const scenarios = [
      {
        path: "traces/catch-all.appa",
        content:
          "mcp/notes/read {}\nexpect allow\nmcp/archestra/ask_user {}\nexpect allow\n",
      },
      {
        path: "traces/wrong.appa",
        content: "mcp/notes/read {}\nexpect deny\n",
      },
      {
        path: "traces/sandbox.appa",
        content:
          "mcp/notes/read {}\nexpect allow\nmcp/archestra/run_command {}\nexpect deny\n",
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
            { line: 3, status: "cannot_run", actual: null },
          ],
        },
      ],
    });
  });
  test("uses real replay state and file isolation, stores outcomes and marks policy changes stale", async () => {
    const sourceVersion = await saveFiles();
    const run = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/run",
      payload: { files, sourceVersion },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({
      draft: false,
      stale: false,
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
    expect(history.json()[0]).toMatchObject({
      id: run.json().id,
      stale: false,
    });
    const changed = `${content}\n# new policy revision\n`;
    await GuardrailsPolicyModel.save({
      organizationId: ctx.organizationId,
      content: changed,
      contentHash: hash(changed),
      updatedBy: ctx.user.id,
      expectedRevision: 1,
    });
    const stale = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    expect(stale.json()[0]).toMatchObject({ id: run.json().id, stale: true });
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
  test("a policy changed while native replay waits makes the returned frozen run stale", async () => {
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
        stale: true,
        policyRevision: 1,
        policyHash: hash(content),
        files: [{ status: "passed" }],
      });
      const history = await ctx.app.inject({
        method: "GET",
        url: "/api/openappa/policy-tests/runs",
      });
      expect(history.json()[0]).toMatchObject({
        id: run.json().id,
        stale: true,
      });
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
