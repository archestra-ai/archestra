import { BUILT_IN_AGENT_IDS, BUILT_IN_AGENT_NAMES } from "@shared";
import { vi } from "vitest";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  getAgentTypePermissionChecker: vi.fn().mockResolvedValue({
    require: vi.fn(),
    isAdmin: vi.fn().mockReturnValue(true),
    isTeamAdmin: vi.fn().mockReturnValue(true),
    hasAnyReadPermission: vi.fn().mockReturnValue(true),
    hasAnyAdminPermission: vi.fn().mockReturnValue(true),
  }),
  hasAnyAgentTypeReadPermission: vi.fn().mockResolvedValue(true),
  requireAgentModifyPermission: vi.fn(),
  requireAgentTypePermission: vi.fn(),
  isAgentTypeAdmin: vi.fn().mockResolvedValue(true),
}));

describe("built-in agents routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    // Seed the built-in policy config agent for this organization
    await AgentModel.create({
      name: BUILT_IN_AGENT_NAMES.POLICY_CONFIG,
      organizationId,
      agentType: "agent",
      scope: "org",
      description:
        "Analyzes tool metadata with AI to generate deterministic security policies",
      systemPrompt: "You are a policy configuration subagent.",
      builtInAgentConfig: {
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        autoConfigureOnToolAssignment: false,
      },
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
    });

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

  test("built-in agent exists and has correct metadata", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/agents?agentTypes=agent&scope=built_in&limit=100",
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    const agents = result.data ?? result;
    const builtIn = agents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );

    expect(builtIn).toBeTruthy();
    expect(builtIn.builtInAgentConfig).toEqual(
      expect.objectContaining({
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
      }),
    );
    expect(builtIn.name).toBe(BUILT_IN_AGENT_NAMES.POLICY_CONFIG);
    expect(builtIn.agentType).toBe("agent");
  });

  test("cannot edit name or description of built-in agent", async () => {
    // Find the built-in agent
    const listResponse = await app.inject({
      method: "GET",
      url: "/api/agents?agentTypes=agent&scope=built_in&limit=100",
    });
    const listResult = listResponse.json();
    const agents = listResult.data ?? listResult;
    const builtIn = agents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(builtIn).toBeTruthy();

    const originalName = builtIn.name;
    const originalDescription = builtIn.description;

    // Attempt to change name and description
    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${builtIn.id}`,
      payload: {
        name: "New Name That Should Be Ignored",
        description: "New description that should be ignored",
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json();

    // Backend strips name/description for built-in agents
    expect(updated.name).toBe(originalName);
    expect(updated.description).toBe(originalDescription);
  });

  test("cannot delete built-in agent", async () => {
    const listResponse = await app.inject({
      method: "GET",
      url: "/api/agents?agentTypes=agent&scope=built_in&limit=100",
    });
    const listResult = listResponse.json();
    const agents = listResult.data ?? listResult;
    const builtIn = agents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(builtIn).toBeTruthy();

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/agents/${builtIn.id}`,
    });

    expect(deleteResponse.statusCode).toBe(403);
  });

  test("can update builtInAgentConfig", async () => {
    const listResponse = await app.inject({
      method: "GET",
      url: "/api/agents?agentTypes=agent&scope=built_in&limit=100",
    });
    const listResult = listResponse.json();
    const agents = listResult.data ?? listResult;
    const builtIn = agents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(builtIn).toBeTruthy();

    const originalAutoConfig =
      builtIn.builtInAgentConfig?.autoConfigureOnToolAssignment ?? false;
    const newAutoConfig = !originalAutoConfig;

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${builtIn.id}`,
      payload: {
        builtInAgentConfig: {
          name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
          autoConfigureOnToolAssignment: newAutoConfig,
        },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json();

    expect(updated.builtInAgentConfig).toEqual(
      expect.objectContaining({
        name: BUILT_IN_AGENT_IDS.POLICY_CONFIG,
        autoConfigureOnToolAssignment: newAutoConfig,
      }),
    );
  });

  test("built-in agent excluded from /api/agents/all when excludeBuiltIn=true", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/agents/all?agentType=agent&excludeBuiltIn=true",
    });

    expect(response.statusCode).toBe(200);
    const agents = response.json();

    const builtIn = agents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(builtIn).toBeUndefined();
  });

  test("built-in agent included in /api/agents/all when excludeBuiltIn is not set", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/agents/all?agentType=agent",
    });

    expect(response.statusCode).toBe(200);
    const agents = response.json();

    const builtIn = agents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(builtIn).toBeTruthy();
  });

  test("built-in agent excluded from /api/agents by default, included with scope=built_in", async () => {
    // Without scope filter, built-in agents should be excluded
    const defaultResponse = await app.inject({
      method: "GET",
      url: "/api/agents?agentTypes=agent&limit=100",
    });
    const defaultResult = defaultResponse.json();
    const defaultAgents = defaultResult.data ?? defaultResult;
    const excluded = defaultAgents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(excluded).toBeUndefined();

    // With scope=built_in, built-in agents should be included
    const builtInResponse = await app.inject({
      method: "GET",
      url: "/api/agents?agentTypes=agent&scope=built_in&limit=100",
    });
    const builtInResult = builtInResponse.json();
    const builtInAgents = builtInResult.data ?? builtInResult;
    const included = builtInAgents.find(
      (a: { builtInAgentConfig?: { name: string } }) =>
        a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    expect(included).toBeTruthy();
    expect(included.builtInAgentConfig?.name).toBe(
      BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
  });
});
