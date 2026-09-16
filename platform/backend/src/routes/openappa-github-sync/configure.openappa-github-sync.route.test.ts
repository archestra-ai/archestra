import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import {
  checkDueAppaGithubSyncs,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import routes from "./openappa-github-sync.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
const commit = "a".repeat(40);
const policy =
  '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n[externals]\ntimeout_ms = 2000\nmax_body_bytes = 65536\n';
const source = {
  repo: "example/policies",
  ref: "policy/main",
  path: "guardrails/appa.toml",
  interval: "1h" as const,
  githubPatId: null,
  githubAppConfigId: null,
};

describe("APPA GitHub sync", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    adminId = user.id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(routes);
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/commits/:ref",
        ({ params }) => {
          expect(params.ref).toBe("policy/main");
          return HttpResponse.json({ sha: commit });
        },
      ),
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("ref")).toBe(commit);
          return HttpResponse.text(policy);
        },
      ),
    );
  });
  afterEach(async () => {
    await app.close();
  });
  const configure = (body: unknown = source) =>
    app.inject({
      method: "PUT",
      url: "/api/openappa/github-sync",
      payload: body as Record<string, unknown>,
    });
  const action = (body: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: "/api/openappa/github-sync",
      payload: body,
    });

  test("saves, audits and pulls a pinned, natively validated policy without exposing its content", async () => {
    expect((await configure()).statusCode).toBe(200);
    await syncAppaGithubPolicy(organizationId);
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    expect(row).toMatchObject({
      content: policy,
      sourceCommit: commit,
      lastSyncError: null,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/openappa/github-sync",
    });
    expect(response.json()).toMatchObject({
      hasPolicy: true,
      source: { repo: source.repo, sourceCommit: commit },
    });
    expect(response.json().source).not.toHaveProperty("content");
    await vi.waitFor(async () => {
      const records = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.organizationId, organizationId),
            eq(schema.auditLogsTable.action, "organization.updated"),
          ),
        );
      expect(records.length).toBe(1);
      expect(records[0].after).toMatchObject({ repo: source.repo });
      expect(records[0].after).not.toEqual(records[0].before);
      expect(records[0].after).not.toHaveProperty("content");
    });
  });

  test("an invalid upstream policy preserves the last accepted bytes and commit", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        () => HttpResponse.text("not a policy"),
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      content: policy,
      sourceCommit: commit,
      lastSyncError: expect.stringContaining("APPA rejected"),
    });
  });

  test("a disconnect during download prevents the stale result from publishing", async () => {
    await configure();
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        async () => {
          expect((await action({ action: "disconnect" })).statusCode).toBe(200);
          return HttpResponse.text(policy);
        },
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      interval: null,
      content: null,
      lastSyncedAt: null,
    });
    expect(await GuardrailsPolicyModel.findLatest(organizationId)).toBeNull();
  });

  test("a changed source during download prevents the old source from publishing", async () => {
    await configure();
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        async () => {
          expect(
            (await configure({ ...source, path: "new.toml" })).statusCode,
          ).toBe(200);
          return HttpResponse.text(policy);
        },
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      path: "new.toml",
      content: null,
    });
    expect(await GuardrailsPolicyModel.findLatest(organizationId)).toBeNull();
  });

  test("disconnect keeps accepted policy, records the change, and stops scheduled pulls", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const response = await action({ action: "disconnect" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasPolicy: true,
      source: { interval: null },
    });
    expect(await OpenAppaGithubSyncModel.findDue()).toEqual([]);
    expect((await action({ action: "sync" })).statusCode).toBe(409);
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.organizationId, organizationId),
            eq(schema.auditLogsTable.action, "organization.updated"),
          ),
        );
      expect(
        rows.some(
          (row) =>
            (row.before as { interval?: string })?.interval === "1h" &&
            (row.after as { interval?: string | null })?.interval === null,
        ),
      ).toBe(true);
    });
  });

  test("concurrent manual and scheduled requests enqueue one pull", async () => {
    await configure();
    await Promise.all([
      action({ action: "sync" }),
      action({ action: "sync" }),
      checkDueAppaGithubSyncs(),
    ]);
    const tasks = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "openappa_github_sync"));
    expect(tasks).toHaveLength(1);
  });

  test("schedule changes persist and successful recent syncs are not due", async () => {
    await configure();
    expect(
      (await action({ action: "schedule", interval: "15m" })).json().source
        .interval,
    ).toBe("15m");
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.findDue()).toEqual([]);
  });

  test("rejects malformed paths, conflicting credentials and disabled APPA", async () => {
    for (const body of [
      { ...source, path: "../secret.toml" },
      { ...source, repo: "https://attacker.test/repo" },
      {
        ...source,
        githubPatId: "00000000-0000-4000-8000-000000000001",
        githubAppConfigId: "00000000-0000-4000-8000-000000000002",
      },
    ])
      expect((await configure(body)).statusCode).toBe(400);
    config.openappa.enabled = false;
    expect((await configure()).statusCode).toBe(409);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
  });

  test("refuses non-administrators and does not read another organization's source", async ({
    makeOrganization,
  }) => {
    await configure();
    const other = await makeOrganization();
    expect(await OpenAppaGithubSyncModel.find(other.id)).toBeNull();
    // Remove management access while keeping the same authenticated request identity.
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, adminId));
    expect((await configure()).statusCode).toBe(403);
    expect((await action({ action: "disconnect" })).statusCode).toBe(403);
  });

  test("oversized or failed GitHub downloads preserve the active policy", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        () =>
          new HttpResponse("", {
            headers: { "content-length": String(2 * 1024 * 1024) },
          }),
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      content: policy,
      lastSyncError: expect.stringContaining("1 MiB"),
    });
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/commits/:ref",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      content: policy,
      lastSyncError: expect.stringContaining("404"),
    });
  });
  test("synced policies cannot be manually overwritten, disconnect enables editing", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const write = () =>
      guardrailsPolicyService.update({
        organizationId,
        userId: adminId,
        content: `${policy}# manual`,
        expectedRevision: 1,
      });
    await expect(write()).rejects.toThrow("Stop GitHub syncing");
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
    // The database guard also covers callers whose validation raced a new sync configuration.
    expect(
      await GuardrailsPolicyModel.save({
        organizationId,
        updatedBy: adminId,
        content: "stale edit",
        contentHash: "stale",
        expectedRevision: 1,
      }),
    ).toBeNull();
    await action({ action: "disconnect" });
    expect(await write()).toMatchObject({
      content: `${policy}# manual`,
      revision: 2,
    });
  });

  test("unchanged upstream bytes do not create redundant policy revisions", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    await syncAppaGithubPolicy(organizationId);
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ revision: 1, content: policy });
  });
});
