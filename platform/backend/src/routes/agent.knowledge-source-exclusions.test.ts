import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import { getAgentTypePermissionChecker } from "@/auth";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;

describe("agent knowledge-source-exclusions routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let requireMock: Mock;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);

    requireMock = vi.fn();
    mockGetAgentTypePermissionChecker.mockResolvedValue({
      require: requireMock,
      isAdmin: vi.fn().mockReturnValue(true),
      isTeamAdmin: vi.fn().mockReturnValue(true),
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(true),
    });

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

  test("GET starts empty and PUT round-trips a full replace", async ({
    makeAgent,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllTools: true });
    const knowledgeBase = await makeKnowledgeBase(organizationId);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      organizationId,
    );

    const emptyResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/knowledge-source-exclusions`,
    });
    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json()).toEqual({ excludedConnectorIds: [] });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/knowledge-source-exclusions`,
      payload: { excludedConnectorIds: [connector.id] },
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual({
      excludedConnectorIds: [connector.id],
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/knowledge-source-exclusions`,
    });
    expect(getResponse.json()).toEqual({
      excludedConnectorIds: [connector.id],
    });

    // Full replace with an empty set re-enables everything.
    const clearResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/knowledge-source-exclusions`,
      payload: { excludedConnectorIds: [] },
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({ excludedConnectorIds: [] });
  });

  test("PUT drops ids that are not live same-org connectors", async ({
    makeAgent,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
    makeOrganization,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllTools: true });
    const knowledgeBase = await makeKnowledgeBase(organizationId);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      organizationId,
    );

    const otherOrg = await makeOrganization();
    const foreignKnowledgeBase = await makeKnowledgeBase(otherOrg.id);
    const foreignConnector = await makeKnowledgeBaseConnector(
      foreignKnowledgeBase.id,
      otherOrg.id,
    );

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/knowledge-source-exclusions`,
      payload: {
        excludedConnectorIds: [
          connector.id,
          foreignConnector.id,
          crypto.randomUUID(),
        ],
      },
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual({
      excludedConnectorIds: [connector.id],
    });
  });

  test("PUT writes an agent.updated audit record capturing the exclusions", async ({
    makeAgent,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllTools: true });
    const knowledgeBase = await makeKnowledgeBase(organizationId);
    const connector = await makeKnowledgeBaseConnector(
      knowledgeBase.id,
      organizationId,
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/knowledge-source-exclusions`,
      payload: { excludedConnectorIds: [connector.id] },
    });
    expect(response.statusCode).toBe(200);

    const auditRows = await db
      .select({
        action: schema.auditLogsTable.action,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "agent.updated"),
          eq(schema.auditLogsTable.resourceId, agent.id),
        ),
      );

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].before).toMatchObject({ excludedConnectorIds: [] });
    expect(auditRows[0].after).toMatchObject({
      excludedConnectorIds: [connector.id],
    });
  });

  test("returns 404 for an agent belonging to another organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${foreignAgent.id}/knowledge-source-exclusions`,
    });
    expect(getResponse.statusCode).toBe(404);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${foreignAgent.id}/knowledge-source-exclusions`,
      payload: { excludedConnectorIds: [] },
    });
    expect(putResponse.statusCode).toBe(404);
  });

  test("returns 404 when the caller lacks the agent-type permission", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    requireMock.mockImplementation(() => {
      throw new Error("missing permission");
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/knowledge-source-exclusions`,
    });
    expect(getResponse.statusCode).toBe(404);
    expect(requireMock).toHaveBeenCalledWith(agent.agentType, "read");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/knowledge-source-exclusions`,
      payload: { excludedConnectorIds: [] },
    });
    expect(putResponse.statusCode).toBe(404);
    expect(requireMock).toHaveBeenCalledWith(agent.agentType, "update");
  });
});
