import { BUILT_IN_AGENT_IDS } from "@shared";
import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import {
  getAgentTypePermissionChecker,
  requireAgentModifyPermission,
} from "@/auth";
import db, { schema } from "@/database";
import { AgentToolModel, ToolModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { type Agent, ApiError, type User } from "@/types";

vi.mock("@/auth", () => ({
  getAgentTypePermissionChecker: vi.fn(),
  hasAnyAgentTypeReadPermission: vi.fn().mockResolvedValue(true),
  requireAgentModifyPermission: vi.fn(),
  requireAgentTypePermission: vi.fn(),
  isAgentTypeAdmin: vi.fn().mockResolvedValue(true),
  hasAnyAgentTypeAdminPermission: vi.fn().mockResolvedValue(true),
}));

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;
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
        credentialResolutionMode:
          schema.agentToolsTable.credentialResolutionMode,
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

  test("non-admin cannot clone org-scoped agent", async ({
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

    mockGetAgentTypePermissionChecker.mockResolvedValueOnce({
      require: vi.fn(),
      isAdmin: vi.fn().mockReturnValue(false), // Not an admin
      isTeamAdmin: vi.fn().mockReturnValue(false),
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(false),
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

  test("personal agent cloning only by owner", async ({
    makeInternalAgent,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Personal Agent",
      scope: "personal",
      authorId: otherUser.id, // Owned by different user
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    mockRequireAgentModifyPermission.mockImplementationOnce(() => {
      throw new ApiError(403, "You can only manage your own personal agents");
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(403);
  });

  test("team-scoped cloning requires team-admin membership", async ({
    makeInternalAgent,
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id, { role: "member" }); // Not team-admin

    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Team Agent",
      scope: "team",
      teams: [team.id],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    mockGetAgentTypePermissionChecker.mockResolvedValueOnce({
      require: vi.fn(),
      isAdmin: vi.fn().mockReturnValue(false),
      isTeamAdmin: vi.fn().mockReturnValue(false), // Not team-admin
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(false),
    });

    mockRequireAgentModifyPermission.mockImplementationOnce(() => {
      throw new ApiError(
        403,
        "You need team-admin permission to manage team-scoped agents",
      );
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(403);
  });

  test("clones agent with empty associations", async ({
    makeInternalAgent,
  }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Minimal Agent",
      scope: "personal",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      suggestedPrompts: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.id).not.toBe(sourceAgent.id);
    expect(cloned.name).toBe(`Copy of ${sourceAgent.name}`);
    expect(cloned.labels).toEqual([]);
    expect(cloned.knowledgeBaseIds).toEqual([]);
    expect(cloned.connectorIds).toEqual([]);
    expect(cloned.tools).toEqual([]);
  });

  test("clones agent with multiple teams", async ({
    makeInternalAgent,
    makeTeam,
  }) => {
    const team1 = await makeTeam(organizationId, user.id);
    const team2 = await makeTeam(organizationId, user.id);

    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Multi-Team Agent",
      scope: "team",
      teams: [team1.id, team2.id],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.teams.map((t) => t.id)).toEqual(
      expect.arrayContaining([team1.id, team2.id]),
    );
  });

  test("clones all three built-in agent types", async ({
    makeInternalAgent,
  }) => {
    const agentTypes = ["profile", "mcp_gateway", "llm_proxy"] as const;

    for (const agentType of agentTypes) {
      const sourceAgent = await makeInternalAgent({
        organizationId,
        name: `${agentType} Agent`,
        agentType,
        scope: "org",
        teams: [],
        labels: [],
        knowledgeBaseIds: [],
        connectorIds: [],
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${sourceAgent.id}/clone`,
      });

      expect(response.statusCode).toBe(200);
      const cloned = response.json() as Agent;

      expect(cloned.agentType).toBe(agentType);
      expect(cloned.name).toBe(`Copy of ${sourceAgent.name}`);
    }
  });

  test("returns 404 for non-existent agent", async () => {
    // Use a valid, non-nil UUID so the request passes params validation and
    // reaches the handler (nil UUIDs may be rejected as invalid).
    const fakeId = "11111111-1111-4111-8111-111111111111";

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${fakeId}/clone`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 400 for invalid UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/agents/not-a-uuid/clone",
    });

    expect(response.statusCode).toBe(400);
  });

  test("clones passthroughHeaders", async ({ makeInternalAgent }) => {
    const headers = ["X-Custom-Header", "X-Another-Header"];

    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Headers Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      passthroughHeaders: headers,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.passthroughHeaders).toBeNull();
  });

  test("clones incoming email settings", async ({ makeInternalAgent }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Email Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "private",
      incomingEmailAllowedDomain: "example.com",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.incomingEmailEnabled).toBe(true);
    expect(cloned.incomingEmailSecurityMode).toBe("private");
    expect(cloned.incomingEmailAllowedDomain).toBe("example.com");
  });

  test("clones LLM API key and model", async ({ makeInternalAgent }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "LLM Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      llmApiKeyId: null,
      llmModel: "gpt-4",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.llmApiKeyId).toBeNull();
    expect(cloned.llmModel).toBe("gpt-4");
  });

  test("clones identityProviderId for MCP gateway", async ({
    makeInternalAgent,
  }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "MCP Gateway",
      agentType: "mcp_gateway",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      identityProviderId: null,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.identityProviderId).toBeNull();
  });

  test("rejects cloning llm_proxy with knowledge bases or connectors", async ({
    makeInternalAgent,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const kb = await makeKnowledgeBase(organizationId, { name: "KB Reject" });
    const connector = await makeKnowledgeBaseConnector(kb.id, organizationId, {
      name: "Connector Reject",
    });

    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "LLM Proxy With KB",
      agentType: "llm_proxy",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [kb.id],
      connectorIds: [connector.id],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(400);
  });

  test("cleans up partial clone if tool assignment cloning fails", async ({
    makeInternalAgent,
  }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Rollback Source",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const spy = vi
      .spyOn(AgentToolModel, "cloneAssignments")
      .mockRejectedValueOnce(new Error("boom"));

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(500);

    const clones = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.name, `Copy of ${sourceAgent.name}`));
    expect(clones).toHaveLength(0);

    spy.mockRestore();
  });

  test("clones agent with all suggested prompts", async ({
    makeInternalAgent,
  }) => {
    const suggestedPrompts = [
      { summaryTitle: "Summarize", prompt: "Summarize this" },
      { summaryTitle: "Analyze", prompt: "Analyze this" },
      { summaryTitle: "Explain", prompt: "Explain this" },
    ];

    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Prompts Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      suggestedPrompts,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.suggestedPrompts).toEqual(suggestedPrompts);
  });

  test("clones agent with icon", async ({ makeInternalAgent }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Icon Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      icon: "robot",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.icon).toBe("robot");
  });

  test("clones agent with description", async ({ makeInternalAgent }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Described Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      description: "This is a test agent with a description",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.description).toBe("This is a test agent with a description");
  });

  test("clones agent with system prompt", async ({ makeInternalAgent }) => {
    const systemPrompt = "You are a helpful assistant.";

    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Prompt Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      systemPrompt,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.systemPrompt).toBe(systemPrompt);
  });

  test("clones agent with considerContextUntrusted", async ({
    makeInternalAgent,
  }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Untrusted Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      considerContextUntrusted: true,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.considerContextUntrusted).toBe(true);
  });

  test("clones agent with multiple labels", async ({ makeInternalAgent }) => {
    const labels = [
      { key: "env", value: "test" },
      { key: "team", value: "backend" },
      { key: "priority", value: "high" },
    ];

    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Labeled Agent",
      scope: "org",
      teams: [],
      labels,
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    // Compare labels by key-value pairs (API response includes keyId/valueId)
    const clonedKeyValues = cloned.labels
      .map((l) => ({ key: l.key, value: l.value }))
      .sort((a, b) =>
        `${a.key}:${a.value}`.localeCompare(`${b.key}:${b.value}`),
      );
    const expectedKeyValues = [...labels].sort((a, b) =>
      `${a.key}:${a.value}`.localeCompare(`${b.key}:${b.value}`),
    );
    expect(clonedKeyValues).toEqual(expectedKeyValues);
  });

  test("returns 404 when source agent belongs to a different organization", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    // Create an agent in a different organization
    const otherOrg = await makeOrganization();
    const otherOrgAgent = await makeInternalAgent({
      organizationId: otherOrg.id,
      name: "Other Org Agent",
      scope: "org",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${otherOrgAgent.id}/clone`,
    });

    // Should be 404 (not 403) to avoid leaking existence
    expect(response.statusCode).toBe(404);
  });

  test("preserves toolExposureMode and toolAssignmentMode in clone", async ({
    makeInternalAgent,
  }) => {
    const sourceAgent = await makeInternalAgent({
      organizationId,
      name: "Search-Only Agent",
      scope: "org",
      teams: [],
      labels: [{ key: "env", value: "prod" }],
      knowledgeBaseIds: [],
      connectorIds: [],
      toolExposureMode: "search_and_run_only",
      toolAssignmentMode: "automatic",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${sourceAgent.id}/clone`,
    });

    expect(response.statusCode).toBe(200);
    const cloned = response.json() as Agent;

    expect(cloned.toolExposureMode).toBe("search_and_run_only");
    expect(cloned.toolAssignmentMode).toBe("automatic");
  });
});
