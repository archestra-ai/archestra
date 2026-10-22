import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  PLATFORM_ADMIN_ROLE_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { beforeEach } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import {
  AgentModel,
  AgentToolModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import agentRoutes from "@/routes/agent";
import agentToolRoutes from "@/routes/agent-tool";
import chatRoutes from "@/routes/chat/routes";
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
    const [podsLog] = tools;
    await AgentToolModel.create(envAgent.id, podsLog.id, {
      mcpServerId: server.id,
    });

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
