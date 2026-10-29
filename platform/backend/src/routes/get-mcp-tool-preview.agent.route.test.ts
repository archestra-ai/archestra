import {
  ARCHESTRA_MCP_CATALOG_ID,
  DEFAULT_APP_NAME,
  resolveMcpClientServerName,
} from "@archestra/shared";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { removeAttestationTokens } from "@/archestra-mcp-server/tool-attestation";
import config from "@/config";
import {
  AgentExcludedToolModel,
  McpToolCallModel,
  MemberModel,
  OrganizationModel,
  ToolModel,
  UserTokenModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { estimateMcpToolTokens } from "@/services/mcp-tool-token-estimate";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import agentRoutes from "./agent";
import { createAgentServer } from "./mcp-gateway/utils";

describe("GET agent MCP tool preview", () => {
  const ctx = useRouteTestApp(agentRoutes);

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    config.auth.secret = "preview-test-attestation-secret";
  });

  for (const mode of ["full", "search_and_run_only"] as const) {
    test(`matches the gateway's ${mode} list for the caller`, async ({
      makeAgent,
      makeUser,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    }) => {
      const gateway = await makeAgent({
        agentType: "mcp_gateway",
        organizationId: ctx.organizationId,
        toolExposureMode: mode,
        accessAllTools: mode === "search_and_run_only",
      });
      const catalog = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        name: "Public documents",
      });
      const privateCatalog = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        authorId: (await makeUser()).id,
        name: "Private documents",
        access: "personal",
      });
      const excludedCatalog = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        name: "Excluded documents",
      });
      const visible = await makeTool({
        name: "documents__search",
        description: "Search public documents",
        catalogId: catalog.id,
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Search term" } },
          required: ["query"],
        },
      });
      const excluded = await makeTool({
        name: "documents__delete",
        catalogId: excludedCatalog.id,
      });
      const hidden = await makeTool({
        name: "private_documents__search",
        catalogId: privateCatalog.id,
      });
      await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
      for (const tool of [visible, excluded, hidden]) {
        await makeAgentTool(gateway.id, tool.id);
      }
      await AgentExcludedToolModel.replaceForAgent(gateway.id, [excluded.id]);

      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/agents/${gateway.id}/mcp-tool-preview?client=claude-code`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        (await McpToolCallModel.findAllPaginated({ limit: 10, offset: 0 }))
          .pagination.total,
      ).toBe(0);
      expect(
        await UserTokenModel.findByUserAndOrg(ctx.user.id, ctx.organizationId),
      ).toBeNull();
      const snapshot = response.json<{
        toolExposureMode: "full" | "search_and_run_only";
        tools: {
          name: string;
          description: string;
          catalogId: string | null;
          tokens: number;
        }[];
      }>();
      expect(snapshot.toolExposureMode).toBe(mode);
      const preview = snapshot.tools;
      const { server } = await createAgentServer({
        agentId: gateway.id,
        tokenAuth: {
          tokenId: crypto.randomUUID(),
          teamId: null,
          isOrganizationToken: false,
          isUserToken: true,
          organizationId: ctx.organizationId,
          userId: ctx.user.id,
        },
      });
      try {
        const handler = (
          server.server as unknown as {
            _requestHandlers: Map<
              string,
              (request: unknown) => Promise<ListToolsResult>
            >;
          }
        )._requestHandlers.get("tools/list");
        if (!handler) throw new Error("Missing tools/list handler");
        const wire = await handler({ method: "tools/list", params: {} });
        expect(preview.map((tool) => tool.name)).toEqual(
          wire.tools.map((tool) => tool.name),
        );
        expect(preview.map((tool) => tool.description)).toEqual(
          wire.tools.map((tool) =>
            removeAttestationTokens(tool.description ?? ""),
          ),
        );
        const organization = await OrganizationModel.getById(
          ctx.organizationId,
        );
        expect(preview.map((tool) => tool.tokens)).toEqual(
          estimateMcpToolTokens({
            tools: wire.tools,
            client: "claude-code",
            serverName: resolveMcpClientServerName({
              gatewayName: gateway.name,
              appName: organization?.appName ?? DEFAULT_APP_NAME,
              isPersonalGateway: gateway.isPersonalGateway,
            }),
          }),
        );
        expect(
          (await McpToolCallModel.findAllPaginated({ limit: 10, offset: 0 }))
            .pagination.total,
        ).toBe(1);
        expect(preview.some((tool) => tool.name === excluded.name)).toBe(
          mode === "full",
        );
        expect(preview.some((tool) => tool.name === hidden.name)).toBe(false);
        expect(
          preview.some((tool) => tool.name === "archestra__render_app"),
        ).toBe(false);
        expect(
          preview.filter((tool) => tool.name === "archestra__ask_user"),
        ).toHaveLength(1);
        if (mode === "full") {
          expect(
            preview.find((tool) => tool.name === visible.name)?.catalogId,
          ).toBe(catalog.id);
        } else {
          expect(preview.some((tool) => tool.name === visible.name)).toBe(
            false,
          );
          const search = preview.find((tool) =>
            tool.name.endsWith("__search_tools"),
          );
          expect(search?.description).toContain(catalog.name);
          expect(search?.description).not.toContain(privateCatalog.name);
          expect(search?.description).not.toContain(excludedCatalog.name);
        }
      } finally {
        await server.close();
      }
    });
  }

  test("an empty catalog still previews implicit gateway tools, and defaults to generic estimates", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId: ctx.organizationId,
    });
    const url = `/api/agents/${gateway.id}/mcp-tool-preview`;
    const implicit = await ctx.app.inject({ method: "GET", url });
    const explicit = await ctx.app.inject({
      method: "GET",
      url: `${url}?client=generic`,
    });
    expect(implicit.statusCode, implicit.body).toBe(200);
    expect(implicit.json()).toEqual(explicit.json());
    expect(implicit.json().tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "archestra__ask_user",
          catalogId: ARCHESTRA_MCP_CATALOG_ID,
          tokens: expect.any(Number),
        }),
      ]),
    );
    const invalid = await ctx.app.inject({
      method: "GET",
      url: `${url}?client=invalid`,
    });
    expect(invalid.statusCode).toBe(400);
  });

  test("hides missing, foreign, and inaccessible gateways", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const foreign = await makeAgent({
      agentType: "mcp_gateway",
      organizationId: (await makeOrganization()).id,
    });
    const hidden = await makeAgent({
      agentType: "mcp_gateway",
      organizationId: ctx.organizationId,
      authorId: (await makeUser()).id,
      access: "personal",
    });
    for (const id of [crypto.randomUUID(), foreign.id, hidden.id]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/agents/${id}/mcp-tool-preview`,
      });
      expect(response.statusCode, response.body).toBe(404);
    }
  });

  test("revoking gateway read access immediately removes its preview", async ({
    makeAgent,
    makeCustomRole,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId: ctx.organizationId,
    });
    const role = await makeCustomRole(ctx.organizationId, { permission: {} });
    await MemberModel.updateRole(ctx.user.id, ctx.organizationId, role.role);
    const before = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/${gateway.id}/mcp-tool-preview`,
    });
    expect(before.statusCode, before.body).toBe(200);
    const policyKey = {
      organizationId: ctx.organizationId,
      resource: "mcpGateway" as const,
      scope: gateway.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(policyKey);
    await ResourcePermissionPolicyModel.replace({
      ...policyKey,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/agents/${gateway.id}/mcp-tool-preview`,
    });
    expect(response.statusCode, response.body).toBe(404);
  });
});
