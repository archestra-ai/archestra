import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import { getAgentTypePermissionChecker } from "@/auth";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  AgentModel,
  AgentToolModel,
  AgentVersionModel,
  HookFileModel,
  ToolModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;

describe("POST /api/agents/:id/versions/:version/restore", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  function mockChecker(params: { canUpdate: boolean; isAdmin: boolean }) {
    mockGetAgentTypePermissionChecker.mockResolvedValue({
      require: vi.fn().mockImplementation((_type: string, action: string) => {
        if (action === "update" && !params.canUpdate) {
          throw new Error("denied");
        }
      }),
      isAdmin: vi.fn().mockReturnValue(params.isAdmin),
    });
  }

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    mockChecker({ canUpdate: true, isAdmin: true });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(app);

    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function restore(
    agentId: string,
    version: number,
    body?: { expectedHeadVersion?: number },
  ) {
    return app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/versions/${version}/restore`,
      ...(body ? { payload: body } : {}),
    });
  }

  test("restores an earlier config as a new head version with the same content hash", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      description: "first draft",
    });
    await AgentModel.update(agent.id, { description: "second draft" });

    const response = await restore(agent.id, 1, { expectedHeadVersion: 2 });
    expect(response.statusCode).toBe(200);

    const { agent: restored, warnings } = response.json();
    expect(warnings).toEqual([]);
    expect(restored.description).toBe("first draft");
    expect(restored.latestVersion).toBe(3);

    // The restore forked forward: history keeps all three versions, and the
    // new head is byte-identical to the restored snapshot (nothing referenced
    // by v1 was renamed or deleted in this fixture).
    const [v1, v3] = await Promise.all([
      AgentVersionModel.findByAgentAndVersion({
        agentId: agent.id,
        version: 1,
        organizationId,
      }),
      AgentVersionModel.findByAgentAndVersion({
        agentId: agent.id,
        version: 3,
        organizationId,
      }),
    ]);
    expect(v3?.contentHash).toBe(v1?.contentHash);
  });

  test("restoring the version matching the live config keeps the head", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });

    const response = await restore(agent.id, 1, { expectedHeadVersion: 1 });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent.latestVersion).toBe(1);
  });

  test("409 when the head moved past the previewed version", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    await AgentModel.update(agent.id, { description: "newer than preview" });

    const response = await restore(agent.id, 1, { expectedHeadVersion: 1 });
    expect(response.statusCode).toBe(409);
  });

  test("uncaptured config drift is forked before restoring and fails a stale preview", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    // Simulate a write that bypassed the version-fork boundary: the live row
    // is now ahead of the head snapshot with no version recording it.
    await db
      .update(schema.agentsTable)
      .set({ description: "drifted outside versioning" })
      .where(eq(schema.agentsTable.id, agent.id));

    const response = await restore(agent.id, 1, { expectedHeadVersion: 1 });
    // The restore's fork-first captured the drift as v2 (so it stays
    // recoverable) and therefore rejected the v1-based preview.
    expect(response.statusCode).toBe(409);

    const drifted = await AgentVersionModel.findByAgentAndVersion({
      agentId: agent.id,
      version: 2,
      organizationId,
    });
    expect(drifted?.snapshot.description).toBe("drifted outside versioning");
  });

  test("a version that does not exist is 404", async ({ makeAgent }) => {
    const agent = await makeAgent({ organizationId });

    const response = await restore(agent.id, 99);
    expect(response.statusCode).toBe(404);
  });

  test("built-in agents cannot be restored", async ({ makeAgent }) => {
    const agent = await makeAgent({ organizationId });
    await db
      .update(schema.agentsTable)
      .set({
        builtInAgentConfig: { name: "dual-llm-quarantine-agent" },
      })
      .where(eq(schema.agentsTable.id, agent.id));

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(403);
  });

  test("missing type update permission is 404, not 403", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    mockChecker({ canUpdate: false, isAdmin: false });

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(404);
  });

  test("an agent of another organization is 404", async ({ makeAgent }) => {
    const foreignAgent = await makeAgent();

    const response = await restore(foreignAgent.id, 1);
    expect(response.statusCode).toBe(404);
  });

  test("replays tool assignments and downgrades a deleted tool to a warning", async ({
    makeAgent,
    makeTool,
    makeAgentTool,
  }) => {
    const agent = await makeAgent({ organizationId });
    const keptTool = await makeTool();
    const doomedTool = await makeTool();
    await makeAgentTool(agent.id, keptTool.id);
    await makeAgentTool(agent.id, doomedTool.id);
    // The junction fixture bypasses the fork boundary; capture the two-tool
    // config explicitly.
    const forked = await AgentVersionModel.forkIfChanged(agent.id);
    const twoToolVersion = forked?.version;
    expect(twoToolVersion).toBeDefined();

    // Move on: drop both assignments (a recorded version), then delete one of
    // the tools entirely (leaves the snapshot pointing at a dead reference).
    await AgentToolModel.delete({ agentId: agent.id, toolId: keptTool.id });
    await AgentToolModel.delete({ agentId: agent.id, toolId: doomedTool.id });
    await ToolModel.delete(doomedTool.id);

    // biome-ignore lint/style/noNonNullAssertion: asserted above
    const response = await restore(agent.id, twoToolVersion!);
    expect(response.statusCode).toBe(200);

    const { warnings } = response.json();
    expect(warnings).toEqual([
      expect.objectContaining({ type: "tool", name: doomedTool.name }),
    ]);

    const restoredToolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    expect(restoredToolIds).toEqual([keptTool.id]);
  });

  test("replays hook files", async ({ makeAgent }) => {
    const agent = await makeAgent({ organizationId });
    const hook = await HookFileModel.create({
      agentId: agent.id,
      organizationId,
      event: "session_start",
      fileName: "greet.py",
      content: "print('hello')",
      requirements: [],
      enabled: true,
    });
    const withHook = await AgentVersionModel.forkIfChanged(agent.id);
    await HookFileModel.delete(hook.id, organizationId);

    // biome-ignore lint/style/noNonNullAssertion: fixture agent always forks
    const response = await restore(agent.id, withHook!.version);
    expect(response.statusCode).toBe(200);

    const hooks = await HookFileModel.listByAgent(agent.id, organizationId);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      event: "session_start",
      fileName: "greet.py",
      content: "print('hello')",
      enabled: true,
    });
  });

  test("audits the restore as an agent update with a before/after diff", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      description: "audited original",
    });
    await AgentModel.update(agent.id, { description: "audited edit" });

    const response = await restore(agent.id, 1, { expectedHeadVersion: 2 });
    expect(response.statusCode).toBe(200);

    const row = await auditRow("agent.updated", agent.id);
    expect(row).not.toBeNull();
    expect(row?.resourceType).toBe("agent");
    expect(row?.before).toMatchObject({ description: "audited edit" });
    expect(row?.after).toMatchObject({ description: "audited original" });
  });

  /** The audit hook writes after the response; poll briefly for the record. */
  async function auditRow(action: string, resourceId: string) {
    for (let i = 0; i < 20; i++) {
      const rows = await db
        .select({
          action: schema.auditLogsTable.action,
          resourceType: schema.auditLogsTable.resourceType,
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, action as never),
            eq(schema.auditLogsTable.resourceId, resourceId),
          ),
        );
      if (rows.length > 0) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return null;
  }
});
