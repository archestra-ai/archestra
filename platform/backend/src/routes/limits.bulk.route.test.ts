import { ADMIN_ROLE_NAME, MAX_BULK_IDS, RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { LimitModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import limitsRoutes from "./limits";

describe("DELETE /api/limits/bulk", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { organizationId, user });
    });
    registerAuditLogHook(app);
    await app.register(limitsRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/limits/bulk",
      payload: { ids },
    });

  test("deletes a deduplicated in-org batch and reports missing and foreign ids", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent({ organizationId });
    const first = await createAgentLimit(agent.id);
    const second = await createAgentLimit(agent.id);
    const foreignOrganization = await makeOrganization();
    const foreignAgent = await makeAgent({
      organizationId: foreignOrganization.id,
    });
    const foreign = await LimitModel.create({
      entityType: "agent",
      entityId: foreignAgent.id,
      limitType: "token_cost",
      limitValue: 100,
      model: ["gpt-4o"],
    });
    const missing = crypto.randomUUID();

    const response = await bulkDelete([
      first.id,
      first.id,
      second.id,
      missing,
      foreign.id,
    ]);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "agent limit" },
        { id: second.id, name: "agent limit" },
      ],
      failed: [
        { id: missing, name: null, error: "Limit not found" },
        { id: foreign.id, name: null, error: "Limit not found" },
      ],
    });
    expect(await LimitModel.findById(first.id)).toBeNull();
    expect(await LimitModel.findById(second.id)).toBeNull();
    expect(await LimitModel.findById(foreign.id)).not.toBeNull();
  });

  test("rejects invalid, empty, and over-cap id lists before mutating", async () => {
    const retained = await LimitModel.create({
      entityType: "organization",
      entityId: organizationId,
      limitType: "token_cost",
      limitValue: 100,
      model: ["gpt-4o"],
    });

    expect((await bulkDelete([])).statusCode).toBe(400);
    expect((await bulkDelete(["not-a-uuid"])).statusCode).toBe(400);
    expect(
      (
        await bulkDelete(
          Array.from({ length: MAX_BULK_IDS + 1 }, () => crypto.randomUUID()),
        )
      ).statusCode,
    ).toBe(400);
    expect(await LimitModel.findById(retained.id)).not.toBeNull();
  });

  test("does not bulk-delete user limits whose organization ownership is ambiguous", async () => {
    const limit = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 100,
      model: ["gpt-4o"],
    });

    const response = await bulkDelete([limit.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [],
      failed: [{ id: limit.id, name: null, error: "Limit not found" }],
    });
    expect(await LimitModel.findById(limit.id)).not.toBeNull();
  });

  test("requires the llmLimit delete permission", () => {
    expect(requiredEndpointPermissionsMap[RouteId.BulkDeleteLimits]).toEqual({
      llmLimit: ["delete"],
    });
  });

  test("writes one organization-context audit record and cascades model usage", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    const limit = await createAgentLimit(agent.id);

    expect(await LimitModel.getRawModelUsage(limit.id)).toHaveLength(1);
    expect((await bulkDelete([limit.id])).statusCode).toBe(200);
    expect(await LimitModel.getRawModelUsage(limit.id)).toEqual([]);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceId: schema.auditLogsTable.resourceId,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "limit.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resourceId: organizationId,
      resourceType: "limit",
      before: {
        limits: [{ id: limit.id, entityType: "agent", entityId: agent.id }],
      },
      after: { limits: [] },
    });
  });

  async function createAgentLimit(agentId: string) {
    return LimitModel.create({
      entityType: "agent",
      entityId: agentId,
      limitType: "token_cost",
      limitValue: 100,
      model: ["gpt-4o"],
    });
  }
});
