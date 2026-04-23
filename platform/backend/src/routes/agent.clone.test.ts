import { BUILT_IN_AGENT_IDS } from "@shared";
import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth";
import { ToolModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type Agent, type User } from "@/types";

vi.mock("@/auth", () => ({
  getAgentTypePermissionChecker: vi.fn(),
  hasAnyAgentTypeReadPermission: vi.fn().mockResolvedValue(true),
  requireAgentModifyPermission: vi.fn(),
  requireAgentTypePermission: vi.fn(),
  isAgentTypeAdmin: vi.fn().mockResolvedValue(true),
  hasAnyAgentTypeAdminPermission: vi.fn().mockResolvedValue(true),
}));

const mockGetAgentTypePermissionChecker =
  getAgentTypePermissionChecker as Mock;
const mockRequireAgentModifyPermission = requireAgentModifyPermission as Mock;

describe("clone agent route", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);

    mockGetAgentTypePermissionChecker.mockResolvedValue({
      require: vi.fn(),
      isAdmin: vi.fn().mockReturnValue(true),
      isTeamAdmin: vi.fn().mockReturnValue(true),
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(true),
    });
    mockRequireAgentModifyPermission.mockImplementation(() => {});

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("clones an agent including labels, knowledge, connectors, tools, and delegations", async ({
    makeInternalAgent,
    makeTool,
    makeAgentTool,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const kb = await makeKnowledgeBase(organizationId, { name: "KB 1" });
    const connector = await makeKnowledgeBaseConnector(kb.id, organizationId, {
      name: "Connector 1",
    });

    const baseTool = await makeTool({ name: "tool-a" });

    const targetSubAgent = await makeInternalAgent({
      organizationId,
      name: "Sub Agent",
      scope: "org",
      teams: [],
      labels: [],
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetSubAgent.id,
    );

    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Source Agent",
      scope: "org",
      teams: [],
      labels: [{ key: "env", value: "test" }],
      knowledgeBaseIds: [kb.id],
      connectorIds: [connector.id],
      suggestedPrompts: [{ summaryTitle: "S1", prompt: "P1" }],
      considerContextUntrusted: true,
    });

    await makeAgentTool(sourceAgent.id, baseTool.id, {
      credentialResolutionMode: "dynamic",
    });
    await makeAgentTool(sourceAgent.id, delegationTool.id, {
      credentialResolutionMode: "static",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.id).not.toBe(sourceAgent.id);
    expect(cloned.name).toBe(`Copy of ${sourceAgent.name}`);
    expect(cloned.considerContextUntrusted).toBe(true);

    // Associations via API response
    expect(cloned.labels).toEqual(sourceAgent.labels);
    expect(cloned.knowledgeBaseIds).toEqual([kb.id]);
    expect(cloned.connectorIds).toEqual([connector.id]);
    expect(cloned.suggestedPrompts).toEqual(
      expect.arrayContaining([{ summaryTitle: "S1", prompt: "P1" }]),
    );

    const clonedToolIds = cloned.tools.map((t) => t.id);
    expect(clonedToolIds).toEqual(
      expect.arrayContaining([baseTool.id, delegationTool.id]),
    );

    // Ensure agent_tools rows were duplicated (assignment-level settings preserved)
    const clonedAssignments = await db
      .select({
        toolId: schema.agentToolsTable.toolId,
        credentialResolutionMode: schema.agentToolsTable.credentialResolutionMode,
      })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, cloned.id));

    expect(clonedAssignments).toEqual(
      expect.arrayContaining([
        {
          toolId: baseTool.id,
          credentialResolutionMode: "dynamic",
        },
        {
          toolId: delegationTool.id,
          credentialResolutionMode: "static",
        },
      ]),
    );
  });

  test("cannot clone built-in agents", async ({ makeInternalAgent }) => {
    const builtIn = await makeInternalAgent({
      organizationId,
      name: "Built In",
      scope: "org",
      builtInAgentConfig: {
        // Any valid built-in discriminator works here
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        autoConfigureOnToolDiscovery: false,
      },
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${builtIn.id}/clone`,
    });

    expect(response.statusCode).toBe(403);
  });

  test("returns 404 when permission checker denies read/create", async ({
    makeInternalAgent,
  }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Source Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    mockGetAgentTypePermissionChecker.mockResolvedValueOnce({
      require: vi.fn(() => {
        throw new ApiError(403, "Forbidden");
      }),
      isAdmin: vi.fn().mockReturnValue(true),
      isTeamAdmin: vi.fn().mockReturnValue(true),
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(true),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 403 when scope-based modify permission is denied", async ({
    makeInternalAgent,
  }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Org Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    mockRequireAgentModifyPermission.mockImplementationOnce(() => {
      throw new ApiError(403, "Only admins can manage org-scoped agents");
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(403);
  });
});
