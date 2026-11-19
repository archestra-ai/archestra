import {
  ARCHESTRA_MCP_CATALOG_ID,
  BUILT_IN_AGENT_NAMES,
  IMPLICIT_OPENAPPA_READ_TOOL_SHORT_NAMES,
  OAUTH_TOKEN_ID_PREFIX,
} from "@archestra/shared";
import { memberPermissions } from "@archestra/shared/access-control";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type ArchestraContext,
  archestraMcpBranding,
  executeArchestraTool,
  preflightArchestraToolCall,
} from "@/archestra-mcp-server";
import config from "@/config";
import {
  AgentExcludedToolModel,
  AgentModel,
  AgentToolModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  ToolModel,
} from "@/models";
import {
  AGENT_RUNTIME_OAUTH_CLIENT_ID,
  agentRunGatewayTokenId,
} from "@/services/agent-runtime/runtime-contract";
import {
  syncBuiltInAgents,
  syncOpenAppaConfigAgentCapabilities,
} from "@/services/seed";
import { beforeEach, describe, expect, test } from "@/test";
import {
  createAgentServer,
  type TokenAuthResult,
  validateMCPGatewayToken,
} from "./utils";

type ListHandler = (request: unknown) => Promise<ListToolsResult>;
type SearchResult = {
  tools: Array<{ toolName: string }>;
  nextOffset: number | null;
};

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
  archestraMcpBranding.getToolName("connect_guardrails_repository"),
];

beforeEach(() => {
  config.openappa.enabled = true;
});

function userToken(organizationId: string, userId: string): TokenAuthResult {
  return {
    tokenId: `${OAUTH_TOKEN_ID_PREFIX}${crypto.randomUUID()}`,
    teamId: null,
    isOrganizationToken: false,
    organizationId,
    isUserToken: true,
    userId,
  };
}

async function mintValidatedRuntimeToken(params: {
  agentId: string;
  userId: string;
}): Promise<TokenAuthResult> {
  await OAuthClientModel.ensurePlatformIssuedClient({
    id: AGENT_RUNTIME_OAUTH_CLIENT_ID,
    clientId: AGENT_RUNTIME_OAUTH_CLIENT_ID,
    name: "Agent Runtime",
  });
  const rawToken = `runtime-token-${crypto.randomUUID()}`;
  const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(rawToken);
  await OAuthAccessTokenModel.create({
    id: agentRunGatewayTokenId(crypto.randomUUID()),
    tokenHash,
    clientId: AGENT_RUNTIME_OAUTH_CLIENT_ID,
    userId: params.userId,
    referenceId: `mcp-resource:${params.agentId}`,
    scopes: ["mcp"],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const validated = await validateMCPGatewayToken(params.agentId, rawToken);
  if (!validated) {
    throw new Error("Expected runtime OAuth token to validate");
  }
  return validated;
}

async function listed(params: {
  agentId: string;
  organizationId: string;
  userId?: string;
  tokenAuth?: TokenAuthResult;
}): Promise<string[]> {
  const { server } = await createAgentServer({
    agentId: params.agentId,
    tokenAuth:
      params.tokenAuth ??
      (params.userId
        ? userToken(params.organizationId, params.userId)
        : {
            tokenId: crypto.randomUUID(),
            teamId: null,
            isOrganizationToken: false,
            organizationId: params.organizationId,
            serviceAccountId: crypto.randomUUID(),
          }),
  });
  const handler = (
    server.server as unknown as { _requestHandlers: Map<string, ListHandler> }
  )._requestHandlers.get("tools/list");
  if (!handler) throw new Error("Expected tools/list handler");
  const response = await handler({ method: "tools/list", params: {} });
  return response.tools.map((tool) => tool.name);
}

/** Every tool the search offers for the Guardrails query, page by page. */
async function searched(context: ArchestraContext): Promise<string[]> {
  const names: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await executeArchestraTool(
      archestraMcpBranding.getToolName("search_tools"),
      { query: "guardrails|openappa", mode: "regex", limit: 20, offset },
      context,
    );
    expect(result.isError).toBeFalsy();
    const page = result.structuredContent as SearchResult;
    names.push(...page.tools.map((tool) => tool.toolName));
    offset = page.nextOffset;
  }
  return names;
}

type Admission = "admitted" | "not_assigned" | "denied";

const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  [GET_POLICY]: {},
  [archestraMcpBranding.getToolName("list_guardrails_battery_fits")]: {},
  [archestraMcpBranding.getToolName("inspect_guardrails_server")]: {
    mcpServerId: ARCHESTRA_MCP_CATALOG_ID,
  },
  [archestraMcpBranding.getToolName("validate_guardrails_policy")]: {
    content: "x",
  },
  [archestraMcpBranding.getToolName("preview_guardrails_policy_change")]: {
    content: "x",
    expectedRevision: 0,
  },
  [archestraMcpBranding.getToolName("get_guardrails_policy_change_status")]: {
    number: 1,
  },
  [archestraMcpBranding.getToolName("get_openappa_yell")]: {
    id: ARCHESTRA_MCP_CATALOG_ID,
  },
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
    for (const read of READ) {
      expect(names.includes(read)).toBe(
        surface.agentType === "agent" || surface.toolExposureMode === "full",
      );
    }
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
      role: "admin",
    });
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    expect(
      await listed({ agentId: agent.id, organizationId, userId }),
    ).toContain(GET_POLICY);
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
    makeCustomRole,
    seedAndAssignArchestraTools,
  }) => {
    const organization = await makeOrganization();
    const reader = await makeCustomRole(organization.id, {
      permission: { ...memberPermissions, guardrailsPolicy: ["read"] },
    });
    const { organizationId, userId } = await contextFor({
      makeOrganization: async () => organization,
      makeUser,
      makeMember,
      role: reader.role,
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
      role: "admin",
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

  test("an Agent Runtime OAuth token on an unassigned agent requires explicit assignment or accessAllTools for policy reads", async ({
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
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    const restrictedAgent = await makeAgent({
      organizationId,
      agentType: "agent",
      accessAllTools: false,
      toolExposureMode: "search_and_run_only",
    });
    const restrictedTokenAuth = await mintValidatedRuntimeToken({
      agentId: restrictedAgent.id,
      userId,
    });
    expect(restrictedTokenAuth).not.toHaveProperty("oauthClientId");

    const restrictedContext: ArchestraContext = {
      agent: { id: restrictedAgent.id, name: restrictedAgent.name },
      agentId: restrictedAgent.id,
      organizationId,
      userId,
      tokenAuth: restrictedTokenAuth,
    };

    const restrictedListed = await listed({
      agentId: restrictedAgent.id,
      organizationId,
      tokenAuth: restrictedTokenAuth,
    });
    const restrictedSearched = await searched(restrictedContext);
    for (const read of READ) {
      expect(restrictedListed).not.toContain(read);
      expect(restrictedSearched).not.toContain(read);
      expect(await admission(restrictedContext, read)).toBe("not_assigned");
    }

    const [getPolicyToolId] = await ToolModel.findBuiltInToolIdsByNames([
      GET_POLICY,
    ]);
    if (!getPolicyToolId) throw new Error("Expected seeded GET_POLICY tool");
    await AgentToolModel.create(restrictedAgent.id, getPolicyToolId);

    const assignedListed = await listed({
      agentId: restrictedAgent.id,
      organizationId,
      tokenAuth: restrictedTokenAuth,
    });
    const assignedSearched = await searched(restrictedContext);
    expect(assignedListed).toContain(GET_POLICY);
    expect(assignedSearched).toContain(GET_POLICY);
    expect(await admission(restrictedContext, GET_POLICY)).toBe("admitted");
    for (const read of READ.filter((name) => name !== GET_POLICY)) {
      expect(assignedListed).not.toContain(read);
      expect(assignedSearched).not.toContain(read);
      expect(await admission(restrictedContext, read)).toBe("not_assigned");
    }

    const autoAgent = await makeAgent({
      organizationId,
      agentType: "agent",
      accessAllTools: true,
      toolExposureMode: "search_and_run_only",
    });
    await AgentExcludedToolModel.replaceForAgent(autoAgent.id, []);
    const autoTokenAuth = await mintValidatedRuntimeToken({
      agentId: autoAgent.id,
      userId,
    });
    const autoContext: ArchestraContext = {
      agent: { id: autoAgent.id, name: autoAgent.name },
      agentId: autoAgent.id,
      organizationId,
      userId,
      tokenAuth: autoTokenAuth,
    };
    const autoListed = await listed({
      agentId: autoAgent.id,
      organizationId,
      tokenAuth: autoTokenAuth,
    });
    const autoSearched = await searched(autoContext);
    for (const read of READ) {
      expect(autoListed).toContain(read);
      expect(autoSearched).toContain(read);
      expect(await admission(autoContext, read)).toBe("admitted");
    }
  });

  test("a caller without a user, or without guardrailsPolicy:read, neither lists nor runs policy reads", async ({
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
