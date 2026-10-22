import {
  A2A_OAUTH_SCOPE,
  ADMIN_ROLE_NAME,
  ARCHESTRA_MCP_CATALOG_ID,
  MCP_OAUTH_CLIENT_REFERENCE_PREFIX,
  MEMBER_ROLE_NAME,
  PLATFORM_ADMIN_ROLE_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { beforeEach } from "vitest";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import {
  AgentModel,
  AgentToolModel,
  McpOauthClientModel,
  McpServerModel,
  OAuthAccessTokenModel,
  ToolModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import agentRoutes from "@/routes/agent";
import agentToolRoutes from "@/routes/agent-tool";
import chatRoutes from "@/routes/chat/routes";
import internalMcpCatalogRoutes from "@/routes/internal-mcp-catalog";
import { validateMCPGatewayToken } from "@/routes/mcp-gateway/utils";
import mcpOauthClientsRoutes from "@/routes/mcp-oauth-clients";
import mcpServerRoutes from "@/routes/mcp-server";
import toolRoutes from "@/routes/tool";
import { ResourcePermissions } from "@/services/resource-permissions";
import { describe, expect, test } from "@/test";
import type { User } from "@/types";
import {
  SRE_AGENT_ID,
  SRE_AGENT_TOOL_NAMES,
  SRE_CATALOG_ID,
  SRE_ENVIRONMENT_ID,
  SRE_SERVER_NAME,
} from "./definition";
import { sreAgentService } from "./index";

describe("the SRE agent and its tools are hidden without sre:read", () => {
  beforeEach(() => {
    config.sreAgent.enabled = true;
    config.sreAgent.k8sServiceAccount = "archestra-mcp-k8s-operator";
    config.sreAgent.apiServerCidrs = [];
    config.skillsSandbox.enabled = false;
    config.openappa.enabled = false;
  });

  test.for([
    { caller: "platform admin", canSee: false },
    { caller: "member", canSee: false },
    { caller: "admin", canSee: true },
    { caller: "custom role with sre:read", canSee: true },
  ] as const)("$caller", async ({ caller, canSee }, {
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
    seedAndAssignArchestraTools,
  }) => {
    const { organizationId, admin, tools, envAgent } = await seedSre({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    });
    const [podsLog] = tools;

    const user: User = await (async () => {
      switch (caller) {
        case "admin":
          return admin;
        case "platform admin":
        case "member": {
          const created = await makeUser();
          await makeMember(created.id, organizationId, {
            role:
              caller === "member" ? MEMBER_ROLE_NAME : PLATFORM_ADMIN_ROLE_NAME,
          });
          return created;
        }
        case "custom role with sre:read": {
          const created = await makeUser();
          const { id, role } = await makeCustomRole(organizationId, {
            permission: {
              sre: ["read"],
              agent: ["read"],
              chat: ["read", "create"],
            },
          });
          await makeMember(created.id, organizationId, { role });
          await shareWithRole(organizationId, id);
          return created;
        }
      }
    })();

    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    await app.register(agentRoutes);
    await app.register(agentToolRoutes);
    await app.register(chatRoutes);
    const body = async (url: string) => {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, response.body).toBe(200);
      return response.body;
    };

    try {
      for (const url of [
        "/api/agents?limit=100",
        "/api/agents/chat-roster/page?limit=100",
        `/api/agents/chat-roster?ids=${SRE_AGENT_ID}`,
        "/api/agents/options?limit=100",
      ]) {
        expect((await body(url)).includes(SRE_AGENT_ID), url).toBe(canSee);
      }
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/agents/${SRE_AGENT_ID}`,
          })
        ).statusCode,
      ).toBe(canSee ? 200 : 404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/chat/conversations",
            payload: { agentId: SRE_AGENT_ID },
          })
        ).statusCode,
      ).toBe(canSee ? 200 : 404);
      expect(
        await ResourcePermissions.allows({
          organizationId,
          userId: user.id,
          resource: "agent",
          scope: SRE_AGENT_ID,
          action: "use",
        }),
      ).toBe(canSee);

      for (const url of [
        `/api/agents/${envAgent.id}/tools`,
        `/api/agent-tools?agentId=${envAgent.id}&skipPagination=true`,
      ]) {
        expect((await body(url)).includes(podsLog.id), url).toBe(canSee);
      }
      const search = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { query: "Kubernetes pods", limit: 50 },
        {
          agent: { id: envAgent.id, name: envAgent.name },
          agentId: envAgent.id,
          organizationId,
          userId: user.id,
        },
      );
      const found = (
        search.structuredContent as { tools: { toolName: string }[] }
      ).tools.map(({ toolName }) => toolName);
      const sreToolNames = new Set(tools.map(({ name }) => name));
      expect(found.some((name) => sreToolNames.has(name))).toBe(canSee);
      expect(await AgentModel.findById(SRE_AGENT_ID)).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  test.for([
    { caller: "platform admin", canUse: false },
    { caller: "member", canUse: false },
    { caller: "admin", canUse: true },
  ] as const)("$caller: server inspection, tool rows, delegation and OAuth clients", async ({
    caller,
    canUse,
  }, {
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const { organizationId, admin, server, tools, envAgent } = await seedSre({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    });
    const user =
      caller === "admin"
        ? admin
        : await (async () => {
            const created = await makeUser();
            await makeMember(created.id, organizationId, {
              role:
                caller === "member"
                  ? MEMBER_ROLE_NAME
                  : PLATFORM_ADMIN_ROLE_NAME,
            });
            return created;
          })();
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    await app.register(agentToolRoutes);
    await app.register(mcpServerRoutes);
    await app.register(toolRoutes);
    await app.register(mcpOauthClientsRoutes);
    await app.register(agentRoutes);
    const send = (method: "GET" | "POST", url: string, payload?: object) =>
      app.inject({ method, url, payload });
    const lists = async (url: string, id: string) => {
      const response = await send("GET", url);
      return response.statusCode === 200 && response.body.includes(id);
    };

    try {
      for (const payload of [
        { method: "tools/list" },
        { method: "tools/call", toolName: "pods_log", toolArguments: {} },
      ]) {
        const { statusCode } = await send(
          "POST",
          `/api/mcp_server/${server.id}/inspect`,
          payload,
        );
        // Past the gate the inspection fails only because no server runs.
        expect(statusCode === 404, payload.method).toBe(!canUse);
      }
      expect(
        await lists(`/api/mcp_server/${server.id}/tools`, tools[0].id),
      ).toBe(canUse);
      const listedTools: string[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = (
          await send("GET", `/api/tools?limit=100&offset=${offset}`)
        ).json();
        listedTools.push(...page.data.map(({ id }: { id: string }) => id));
        if (!page.pagination.hasNext) break;
      }
      expect(listedTools.includes(tools[0].id)).toBe(canUse);
      if (caller === "member") return;
      expect(
        await lists(
          "/api/tools/with-assignments?search=kubernetes&limit=100&offset=0",
          tools[0].id,
        ),
      ).toBe(canUse);
      await AgentToolModel.syncDelegations(envAgent.id, [SRE_AGENT_ID]);
      const assigned = (await send("GET", `/api/agents/${envAgent.id}`)).json()
        .tools as { id: string; delegateToAgentId: string | null }[];
      expect(assigned.some(({ id }) => id === tools[0].id)).toBe(canUse);
      expect(
        assigned.some(
          ({ delegateToAgentId }) => delegateToAgentId === SRE_AGENT_ID,
        ),
      ).toBe(canUse);
      for (const url of [
        `/api/agents/${SRE_AGENT_ID}/default-suggested-prompts`,
        `/api/agents/${SRE_AGENT_ID}/mcp-tool-preview`,
        `/api/agents/${SRE_AGENT_ID}/tools`,
        `/api/agents/${SRE_AGENT_ID}/delegations`,
      ]) {
        expect((await send("GET", url)).statusCode === 404, url).toBe(!canUse);
      }
      expect(await lists("/api/agent-delegations", SRE_AGENT_ID)).toBe(canUse);
      expect(
        (
          await send("POST", `/api/agents/${envAgent.id}/delegations`, {
            targetAgentIds: [SRE_AGENT_ID],
          })
        ).statusCode,
      ).toBe(canUse ? 200 : 404);
      expect(
        (
          await send("POST", "/api/mcp-oauth-clients", {
            name: "sre",
            grantType: "authorization_code",
            redirectUris: ["https://app.example.com/callback"],
            allowedGatewayIds: [SRE_AGENT_ID],
          })
        ).statusCode,
      ).toBe(canUse ? 200 : 404);
    } finally {
      await app.close();
    }
  });

  test.for([
    { caller: "platform admin", canSee: false },
    { caller: "admin", canSee: true },
  ] as const)("$caller: SRE chats and built-in tool assignments", async ({
    caller,
    canSee,
  }, {
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeConversation,
    seedAndAssignArchestraTools,
  }) => {
    const { organizationId, admin } = await seedSre({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    });
    await seedAndAssignArchestraTools(SRE_AGENT_ID);
    const user =
      caller === "admin"
        ? admin
        : await (async () => {
            const created = await makeUser();
            await makeMember(created.id, organizationId, {
              role: PLATFORM_ADMIN_ROLE_NAME,
            });
            return created;
          })();
    const [conversation, deleted] = await Promise.all(
      [1, 2].map(() =>
        makeConversation(SRE_AGENT_ID, { userId: user.id, organizationId }),
      ),
    );
    await db
      .update(schema.conversationsTable)
      .set({ deletedAt: new Date() })
      .where(eq(schema.conversationsTable.id, deleted.id));
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    await app.register(chatRoutes);
    await app.register(internalMcpCatalogRoutes);

    try {
      for (const url of [
        `/api/chat/conversations/${conversation.id}`,
        "/api/chat/conversations",
        "/api/chat/conversations?search=Test",
        "/api/chat/conversations/deleted",
        `/api/internal_mcp_catalog/${ARCHESTRA_MCP_CATALOG_ID}/tools`,
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body.includes(SRE_AGENT_ID), url).toBe(canSee);
      }
    } finally {
      await app.close();
    }
  });

  test("A2A refuses the SRE agent to an unbound client and to the system caller", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const { organizationId, admin, envAgent } = await seedSre({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId,
      authorId: admin.id,
      name: "service",
      allowedGatewayIds: [SRE_AGENT_ID, envAgent.id],
    });
    const token = `mcp_at_${crypto.randomUUID()}`;
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(token),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [A2A_OAUTH_SCOPE],
      referenceId: `${MCP_OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
    });
    expect(
      await validateMCPGatewayToken(envAgent.id, token, "a2a"),
    ).not.toBeNull();
    expect(
      await validateMCPGatewayToken(SRE_AGENT_ID, token, "a2a"),
    ).toBeNull();
    await expect(
      executeA2AMessage({
        agentId: SRE_AGENT_ID,
        message: "Why did a pod restart?",
        organizationId,
        userId: "system",
      }),
    ).rejects.toThrow(`Agent ${SRE_AGENT_ID} not found`);
  });
});

/** An admin sharing the SRE agent with a role. */
async function shareWithRole(organizationId: string, roleId: string) {
  const key = {
    organizationId,
    resource: "agent" as const,
    scope: SRE_AGENT_ID,
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  if (!policy) throw new Error("the SRE agent has no permission policy");
  const replaced = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy.revision,
    grants: [
      ...policy.grants,
      { subject: { type: "role", id: roleId }, actions: ["read", "use"] },
    ],
  });
  if (!replaced) throw new Error("the SRE agent policy changed meanwhile");
}

/** The seeded SRE install and agent, and an agent in the SRE environment. */
async function seedSre(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<User>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides: { role: string },
  ) => Promise<unknown>;
  makeAgent: (overrides: {
    organizationId: string;
    authorId: string;
    agentType: "agent";
    environmentId: string;
    access: "org";
  }) => Promise<{ id: string; name: string }>;
  seedAndAssignArchestraTools: (agentId: string) => Promise<unknown>;
}) {
  const {
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  } = fixtures;
  const organizationId = (await makeOrganization()).id;
  const admin = await makeUser();
  await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
  await sreAgentService.seed();
  const [server] = await McpServerModel.findByCatalogId(SRE_CATALOG_ID);
  const tools = await ToolModel.bulkCreateToolsIfNotExists(
    SRE_AGENT_TOOL_NAMES.map((rawName) => ({
      name: ToolModel.slugifyName(SRE_SERVER_NAME, rawName),
      rawToolName: rawName,
      description: `Kubernetes ${rawName}`,
      parameters: { type: "object", properties: {} },
      catalogId: SRE_CATALOG_ID,
    })),
  );
  await sreAgentService.ensureAgent({
    organizationId,
    authorId: admin.id,
    mcpServerId: server.id,
  });
  // An org-wide agent in the SRE environment an admin gave a Kubernetes tool.
  const envAgent = await makeAgent({
    organizationId,
    authorId: admin.id,
    agentType: "agent",
    environmentId: SRE_ENVIRONMENT_ID,
    access: "org",
  });
  await db
    .update(schema.agentsTable)
    .set({ accessAllTools: true })
    .where(eq(schema.agentsTable.id, envAgent.id));
  await seedAndAssignArchestraTools(envAgent.id);
  await AgentToolModel.create(envAgent.id, tools[0].id, {
    mcpServerId: server.id,
  });
  return { organizationId, admin, server, tools, envAgent };
}
