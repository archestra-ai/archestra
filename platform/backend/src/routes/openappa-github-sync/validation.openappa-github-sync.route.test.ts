import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { runAutomaticOpenAppaPolicyTests } from "@/services/openappa-policy-tests";
import { registerTaskHandlers } from "@/task-queue/handlers";
import { TaskQueueService } from "@/task-queue/task-queue";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { registerRoutePermissions } from "@/test/route-permissions";
import { useRouteTestApp } from "@/test/route-test-app";
import { PolicyTestRunResultSchema } from "@/types/openappa-policy-tests";
import policyRoutes from "../openappa-policy-tests/openappa-policy-tests.routes";
import routes from "./openappa-github-sync.routes";

const policy = `[policy]
version = 2
[[policy.tool]]
name = "files__read"
delta = { trust = "suspicious" }
[[policy.tool]]
name = "mail__send"
delta = {}
requires = { trust = "trusted" }
`;
const files = [
  { path: "traces/allow.appa", content: "mcp/mail/send {}\nexpect allow\n" },
  { path: "traces/fail.appa", content: "mcp/mail/send {}\nexpect deny\n" },
  { path: "traces/empty.appa", content: "# no assertions\n" },
];
const source = {
  repo: "example/policies",
  ref: "main",
  path: "appa.toml",
  interval: "15m",
  githubPatId: null,
  githubAppConfigId: null,
  validationDirectory: "traces",
};

describe("informational Git sync validation", () => {
  const ctx = useRouteTestApp(async (app) => {
    registerRoutePermissions(app);
    await app.register(routes);
    await app.register(policyRoutes);
  });
  const server = useMswServer();
  let commit: string;
  let pulledPolicy: string;
  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    config.openappa.enabled = true;
    commit = "a".repeat(40);
    pulledPolicy = policy;
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/commits/:ref",
        () => HttpResponse.json({ sha: commit }),
      ),
      http.get(
        "https://api.github.com/repos/example/policies/contents/appa.toml",
        () => HttpResponse.text(pulledPolicy),
      ),
      http.get(
        "https://api.github.com/repos/example/policies/contents/traces",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("ref")).toMatch(
            /^[a-f0-9]{40}$/,
          );
          return HttpResponse.json(
            files.map((file) => ({
              type: "file",
              path: file.path,
              size: file.content.length,
            })),
          );
        },
      ),
      http.get(
        "https://api.github.com/repos/example/policies/contents/traces/:file",
        ({ params }) =>
          HttpResponse.text(
            files.find((file) => file.path === `traces/${params.file}`)
              ?.content ?? "",
          ),
      ),
    );
  });
  const configure = (validationDirectory = "traces") =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/openappa/github-sync",
      payload: { ...source, validationDirectory },
    });
  const sync = () =>
    ctx.app.inject({
      method: "PATCH",
      url: "/api/openappa/github-sync",
      payload: { action: "sync" },
    });
  const jobs = () =>
    db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "openappa_policy_validation"));

  test("sync accepts policy before replay; the real worker saves all outcomes and repeated sync creates no duplicate run", async () => {
    expect((await configure()).statusCode).toBe(200);
    const synced = await sync();
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json().source).toMatchObject({
      sourceCommit: commit,
      lastSyncError: null,
    });
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(0);
    expect(await jobs()).toHaveLength(1);
    const worker = new TaskQueueService();
    registerTaskHandlers(worker);
    config.kb.taskWorkerPollIntervalSeconds = 0.05;
    worker.startWorker();
    try {
      await vi.waitFor(
        async () =>
          expect(
            await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
          ).toHaveLength(1),
        { timeout: 10000 },
      );
    } finally {
      await worker.stopWorker();
    }
    const history = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    expect(history.json()).toMatchObject([
      {
        trigger: "policy_change",
        createdBy: null,
        draft: false,
        stale: false,
        sourceCommit: commit,
        files: [
          { status: "passed" },
          { status: "cannot_run" },
          { status: "failed" },
        ],
      },
    ]);
    expect(
      await GuardrailsPolicyModel.findLatest(ctx.organizationId),
    ).toMatchObject({ content: policy });
    expect((await sync()).json().source.lastSyncError).toBeNull();
    expect(await jobs()).toHaveLength(1);
    await runAutomaticOpenAppaPolicyTests((await jobs())[0].payload);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(1);
  });

  test("disabled validation queues no run while the policy remains active", async () => {
    await configure("");
    expect((await sync()).json().source).toMatchObject({
      sourceCommit: commit,
      lastSyncError: null,
    });
    expect(await jobs()).toHaveLength(0);
    expect(
      await GuardrailsPolicyModel.findLatest(ctx.organizationId),
    ).toMatchObject({ content: policy });
  });
  test("concurrent delivery saves only one automatic result", async () => {
    await configure();
    await sync();
    const job = (await jobs())[0];
    await Promise.all([
      runAutomaticOpenAppaPolicyTests(job.payload),
      runAutomaticOpenAppaPolicyTests(job.payload),
    ]);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(1);
  });

  test("an inaccessible test folder does not turn successful sync into a policy failure", async () => {
    await configure();
    await sync();
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/traces",
        () => new HttpResponse(null, { status: 403 }),
      ),
    );
    await expect(
      runAutomaticOpenAppaPolicyTests((await jobs())[0].payload),
    ).rejects.toThrow("denied access");
    const status = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/github-sync",
    });
    expect(status.json().source).toMatchObject({
      sourceCommit: commit,
      lastSyncError: null,
    });
    expect(
      await GuardrailsPolicyModel.findLatest(ctx.organizationId),
    ).toMatchObject({ content: policy });
    const [unavailable] = await OpenAppaPolicyTestsModel.listRuns(
      ctx.organizationId,
    );
    expect(unavailable.result).toMatchObject({
      trigger: "policy_change",
      executionError: expect.stringContaining("denied access"),
      sourceCommit: commit,
      files: [],
    });
    const history = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests/runs",
    });
    expect(history.json()[0]).toMatchObject({ stale: false });
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/traces",
        () =>
          HttpResponse.json(
            files.map((file) => ({
              type: "file",
              path: file.path,
              size: file.content.length,
            })),
          ),
      ),
    );
    await runAutomaticOpenAppaPolicyTests((await jobs())[0].payload);
    const recovered = await OpenAppaPolicyTestsModel.listRuns(
      ctx.organizationId,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe(unavailable.id);
    expect(recovered[0].result.executionError).toBeUndefined();
  });

  test("an unchanged policy at a newer commit preserves the queued run and uses authoritative current specs", async () => {
    await configure();
    await sync();
    const first = (await jobs())[0];
    commit = "b".repeat(40);
    await sync();
    expect(await jobs()).toHaveLength(1);
    await runAutomaticOpenAppaPolicyTests(first.payload);
    const [saved] = await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId);
    expect(saved.result.sourceCommit).toBe(commit);
    expect(saved.result.policyHash).toBe(
      (await GuardrailsPolicyModel.findLatest(ctx.organizationId))?.contentHash,
    );
  });

  test("a tests-only or unrelated repository commit does not create a new run after completion", async () => {
    await configure();
    await sync();
    await runAutomaticOpenAppaPolicyTests((await jobs())[0].payload);
    commit = "b".repeat(40);
    await sync();
    expect(await jobs()).toHaveLength(1);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(1);
    expect(
      (await GuardrailsPolicyModel.findLatest(ctx.organizationId))?.revision,
    ).toBe(1);
  });

  test("an accepted policy change queues a hash-bound run while obsolete policy jobs are skipped", async () => {
    await configure();
    await sync();
    const first = (await jobs())[0];
    pulledPolicy = policy.replace('trust = "trusted"', 'trust = "suspicious"');
    commit = "b".repeat(40);
    await sync();
    const queued = await jobs();
    expect(queued).toHaveLength(2);
    const latest = await GuardrailsPolicyModel.findLatest(ctx.organizationId);
    expect(latest?.revision).toBe(2);
    const next = queued.find(
      (job) => job.payload.policyHash === latest?.contentHash,
    );
    expect(next).toBeDefined();
    await runAutomaticOpenAppaPolicyTests(first.payload);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(0);
    await runAutomaticOpenAppaPolicyTests(next?.payload ?? {});
    expect(
      (await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId))[0].result,
    ).toMatchObject({
      trigger: "policy_change",
      policyRevision: 2,
      policyHash: latest?.contentHash,
      sourceCommit: commit,
    });
  });

  test("disconnecting with a queued run prevents background replay", async () => {
    await configure();
    await sync();
    const job = (await jobs())[0];
    await ctx.app.inject({
      method: "PATCH",
      url: "/api/openappa/github-sync",
      payload: { action: "disconnect" },
    });
    await runAutomaticOpenAppaPolicyTests(job.payload);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(0);
  });

  test.each([
    { reason: "changed", values: { contentHash: "changed-during-replay" } },
    { reason: "invalidated", values: { rootRevision: -1 } },
  ])("automatic saving refuses an effective policy that was $reason during replay", async ({
    values,
  }) => {
    await configure();
    await sync();
    const job = (await jobs())[0];
    await runAutomaticOpenAppaPolicyTests(job.payload);
    const [automatic] = await OpenAppaPolicyTestsModel.listRuns(
      ctx.organizationId,
    );
    await db
      .delete(schema.openappaPolicyTestRunsTable)
      .where(eq(schema.openappaPolicyTestRunsTable.id, automatic.id));
    await db
      .update(schema.tasksTable)
      .set({ payload: job.payload })
      .where(eq(schema.tasksTable.id, job.id));
    await db
      .update(schema.openappaEffectivePoliciesTable)
      .set(values)
      .where(
        eq(
          schema.openappaEffectivePoliciesTable.organizationId,
          ctx.organizationId,
        ),
      );
    const saved = await OpenAppaPolicyTestsModel.saveRun(
      ctx.organizationId,
      null,
      PolicyTestRunResultSchema.parse(automatic.result),
      {
        files,
        rootContent: policy,
        effectiveContent: policy,
        sourceRepo: source.repo,
        directory: "traces",
      },
      job.payload.key as string,
    );
    expect(saved).toBeNull();
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(0);
  });
});
