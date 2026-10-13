import {
  ARCHESTRA_MCP_CATALOG_ID,
  BUILT_IN_AGENT_NAMES,
  IMPLICIT_OPENAPPA_READ_TOOL_SHORT_NAMES,
  OAUTH_TOKEN_ID_PREFIX,
} from "@archestra/shared";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type ArchestraContext,
  archestraMcpBranding,
  executeArchestraTool,
  preflightArchestraToolCall,
} from "@/archestra-mcp-server";
import config from "@/config";
import {
  syncBuiltInAgents,
  syncOpenAppaConfigAgentCapabilities,
} from "@/database/seed";
import { AgentExcludedToolModel, AgentModel, ToolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { createAgentServer } from "./utils";

type ListHandler = (request: unknown) => Promise<ListToolsResult>;
type SearchResult = { tools: Array<{ toolName: string }> };

const READ = IMPLICIT_OPENAPPA_READ_TOOL_SHORT_NAMES.map((shortName) =>
  archestraMcpBranding.getToolName(shortName),
);
const GET_POLICY = archestraMcpBranding.getToolName("get_guardrails_policy");
const UPDATE_POLICY = archestraMcpBranding.getToolName(
  "update_guardrails_policy",
);
const WRITE = [
  UPDATE_POLICY,
  archestraMcpBranding.getToolName("create_guardrails_repository"),
];

beforeEach(() => {
  config.openappa.enabled = true;
});

function userToken(organizationId: string, userId: string) {
  return {
    tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
    teamId: null,
    isOrganizationToken: false,
    organizationId,
    isUserToken: true,
    userId,
  };
}

async function listed(params: {
  agentId: string;
  organizationId: string;
  userId?: string;
}): Promise<string[]> {
  const { server } = await createAgentServer({
    agentId: params.agentId,
    tokenAuth: params.userId
      ? userToken(params.organizationId, params.userId)
      : {
          tokenId: crypto.randomUUID(),
          teamId: null,
          isOrganizationToken: true,
          organizationId: params.organizationId,
        },
  });
  const handler = (
    server.server as unknown as { _requestHandlers: Map<string, ListHandler> }
  )._requestHandlers.get("tools/list");
  if (!handler) throw new Error("Expected tools/list handler");
  const response = await handler({ method: "tools/list", params: {} });
  return response.tools.map((tool) => tool.name);
}

async function searched(context: ArchestraContext): Promise<string[]> {
  const result = await executeArchestraTool(
    archestraMcpBranding.getToolName("search_tools"),
    { query: "guardrails|openappa", mode: "regex", limit: 20 },
    context,
  );
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as SearchResult).tools.map(
    (tool) => tool.toolName,
  );
}

type Admission = "admitted" | "not_assigned" | "denied";

const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  [GET_POLICY]: {},
  [UPDATE_POLICY]: { content: "x", expectedRevision: 0 },
};

async function admission(
  context: ArchestraContext,
  toolName: string,
): Promise<Admission> {
  const args = SAMPLE_ARGS[toolName];
  if (!args) throw new Error(`No sample args for ${toolName}`);
  const refusal = await preflightArchestraToolCall({ toolName, args, context });
  if (refusal === null) return "admitted";
  const code = (
    refusal.structuredContent as { archestraError?: { code?: string } }
  )?.archestraError?.code;
  return code === "tool_not_assigned" ? "not_assigned" : "denied";
}

async function contextFor(params: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    options: { role: string },
  ) => Promise<unknown>;
  role?: string;
}) {
  const organization = await params.makeOrganization();
  const user = await params.makeUser();
  await params.makeMember(user.id, organization.id, {
    role: params.role ?? "member",
  });
  return { organizationId: organization.id, userId: user.id };
}

describe("implicit OpenAPPA policy read tools", () => {
  test.for([
    { agentType: "agent", toolExposureMode: "search_and_run_only" },
    { agentType: "agent", toolExposureMode: "full" },
    { agentType: "mcp_gateway", toolExposureMode: "full" },
    { agentType: "mcp_gateway", toolExposureMode: "search_and_run_only" },
  ] as const)("an unassigned $agentType ($toolExposureMode) lists, finds and runs the read set but no write", async (surface, {
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organizationId, userId } = await contextFor({
      makeOrganization,
      makeUser,
      makeMember,
      role: "admin",
    });
    const agent = await makeAgent({ organizationId, ...surface });
    const context = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId,
      userId,
    };

    const names = await listed({ agentId: agent.id, organizationId, userId });
    expect(names).toEqual(expect.arrayContaining(READ));
    for (const write of WRITE) expect(names).not.toContain(write);

    const found = await searched(context);
    expect(found).toEqual(expect.arrayContaining(READ));
    for (const write of WRITE) expect(found).not.toContain(write);

    expect(await admission(context, GET_POLICY)).toBe("admitted");
    expect(await admission(context, UPDATE_POLICY)).toBe("not_assigned");
  });

  test("nothing is implicit while OpenAPPA is disabled", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organizationId, userId } = await contextFor({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    config.openappa.enabled = false;
    expect(
      await listed({ agentId: agent.id, organizationId, userId }),
    ).not.toContain(GET_POLICY);
  });

  test("an Auto agent's exclusion hides and refuses an excluded read tool", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const { organizationId, userId } = await contextFor({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const seeder = await makeAgent({ organizationId });
    await seedAndAssignArchestraTools(seeder.id);
    const agent = await makeAgent({
      organizationId,
      agentType: "agent",
      accessAllTools: true,
      toolExposureMode: "search_and_run_only",
    });
    const [excludedId] = await ToolModel.findBuiltInToolIdsByNames([
      GET_POLICY,
    ]);
    if (!excludedId) throw new Error("Expected seeded built-in");
    await AgentExcludedToolModel.replaceForAgent(agent.id, [excludedId]);
    const context = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId,
      userId,
    };

    const names = await listed({ agentId: agent.id, organizationId, userId });
    expect(names).not.toContain(GET_POLICY);
    expect(names).toContain(
      archestraMcpBranding.getToolName("validate_guardrails_policy"),
    );
    expect(await searched(context)).not.toContain(GET_POLICY);
    expect(await admission(context, GET_POLICY)).toBe("not_assigned");
  });

  test("a delegated run neither finds nor runs policy tools", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { organizationId, userId } = await contextFor({
      makeOrganization,
      makeUser,
      makeMember,
    });
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    const delegated = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId,
      userId,
      delegationChain: `${crypto.randomUUID()}:${agent.id}`,
    };

    const found = await searched(delegated);
    for (const read of READ) expect(found).not.toContain(read);
    await expect(
      executeArchestraTool(GET_POLICY, {}, delegated),
    ).rejects.toMatchObject({ code: -32601 });
  });

  test("a caller without a user, or without openappaPolicy:read, neither lists nor runs policy reads", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
  }) => {
    const organization = await makeOrganization();
    const role = await makeCustomRole(organization.id, {
      permission: { agent: ["read"] },
    });
    const { userId } = await contextFor({
      makeOrganization: async () => organization,
      makeUser,
      makeMember,
      role: role.role,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      agentType: "mcp_gateway",
      toolExposureMode: "full",
    });
    const base = {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId: organization.id,
    };

    for (const caller of [userId, undefined]) {
      const names = await listed({
        agentId: agent.id,
        organizationId: organization.id,
        userId: caller,
      });
      expect(names).not.toContain(GET_POLICY);
      expect(await admission({ ...base, userId: caller }, GET_POLICY)).toBe(
        "denied",
      );
    }
  });

  test("the built-in configuration agent lists and runs its assigned policy write", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const { organizationId, userId } = await contextFor({
      makeOrganization,
      makeUser,
      makeMember,
      role: "admin",
    });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await syncBuiltInAgents();
    await syncOpenAppaConfigAgentCapabilities();
    const agentId = await AgentModel.findActiveIdByNameInOrganization({
      name: BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG,
      organizationId,
    });
    if (!agentId) throw new Error("Expected the configuration agent");
    const context = {
      agent: { id: agentId, name: BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG },
      agentId,
      organizationId,
      userId,
    };

    const names = await listed({ agentId, organizationId, userId });
    expect(names).toEqual(expect.arrayContaining([...READ, UPDATE_POLICY]));
    expect(await searched(context)).toContain(UPDATE_POLICY);
    expect(await admission(context, UPDATE_POLICY)).toBe("admitted");
  });
});
