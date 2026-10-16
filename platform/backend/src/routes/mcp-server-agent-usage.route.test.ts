// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { createFastifyInstance } from "@/fastify-instance";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import { expect, test } from "@/test";
import { McpAutoModeAgentPageSchema } from "@/types/mcp-server-agent-usage";
import routes from "./mcp-server-agent-usage";

test("automatic pages preserve legacy membership, exclude explicit assignments, and use stable searchable cursors", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeAgent,
  makeTool,
  makeAgentTool,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const server = await makeMcpServer({ catalogId: catalog.id });
  const tools = await Promise.all([
    makeTool({ catalogId: catalog.id }),
    makeTool({ catalogId: catalog.id }),
  ]);
  const alpha = await makeAgent({
    organizationId: org.id,
    name: "Alpha",
    accessAllTools: true,
    authorId: user.id,
  });
  const beta = await makeAgent({
    organizationId: org.id,
    name: "Beta",
    accessAllTools: false,
  });
  const delta = await makeAgent({
    organizationId: org.id,
    name: "Delta",
    accessAllTools: true,
  });
  const gamma = await makeAgent({
    organizationId: org.id,
    name: "Gamma_%",
    accessAllTools: true,
  });
  await makeAgentTool(alpha.id, tools[0].id, { mcpServerId: server.id });
  await makeAgentTool(alpha.id, tools[1].id);
  await makeAgentTool(beta.id, tools[0].id);
  const deleted = await makeAgent({
    organizationId: org.id,
    accessAllTools: true,
  });
  await AgentModel.delete(deleted.id);
  const foreignOrg = await makeOrganization();
  const foreign = await makeAgent({
    organizationId: foreignOrg.id,
    name: "Foreign",
    accessAllTools: true,
  });
  await makeAgentTool(foreign.id, tools[0].id);
  const foreignCatalog = await makeInternalMcpCatalog({
    organizationId: foreignOrg.id,
  });
  const legacy = await AgentModel.getAutoModeAgentDetailsByOrganizations([
    org.id,
  ]);
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.user = user;
    request.organizationId = org.id;
  });
  await app.register(routes);
  const request = async (query: Record<string, string> = {}) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/mcp_server/auto_mode_agents/page?${new URLSearchParams(query)}`,
    });
    expect(response.statusCode).toBe(200);
    return McpAutoModeAgentPageSchema.parse(response.json());
  };
  try {
    const summary = await request({ summary: "true" });
    expect(summary.totalAutoCount).toBe(legacy.get(org.id)?.length);
    expect(summary.totalAutoCount).toBe(3);
    expect(summary.organizationId).toBe(org.id);
    expect(summary.data).toEqual([]);
    const assigned =
      (
        await AgentToolModel.getAssignedAgentDetailsForMcpServers([server.id])
      ).get(server.id) ?? [];
    expect(assigned.map((agent) => agent.id).sort()).toEqual(
      [alpha.id, beta.id, foreign.id].sort(),
    );
    expect(
      assigned
        .filter(
          (agent) => agent.accessAllTools && agent.organizationId === org.id,
        )
        .map((agent) => agent.id),
    ).toEqual([alpha.id]);
    const first = await request({ catalogId: catalog.id, limit: "1" });
    expect(first.data.map((agent) => agent.id)).toEqual([delta.id]);
    expect(first.pagination.hasNext).toBe(true);
    expect(
      (
        await request({
          catalogId: catalog.id,
          limit: "1",
          cursor: first.pagination.nextCursor ?? "",
        })
      ).data.map((agent) => agent.id),
    ).toEqual([gamma.id]);
    expect(
      (
        await request({ catalogId: catalog.id, afterAgentId: beta.id })
      ).data.map((agent) => agent.id),
    ).toEqual([delta.id, gamma.id]);
    expect(
      (
        await request({
          catalogId: catalog.id,
          sortDirection: "desc",
          afterAgentId: gamma.id,
        })
      ).data.map((agent) => agent.id),
    ).toEqual([delta.id]);
    expect(
      (await request({ catalogId: catalog.id, search: "%" })).data.map(
        (agent) => agent.id,
      ),
    ).toEqual([gamma.id]);
    expect(
      (await request({ summary: "true", search: user.email })).totalAutoCount,
    ).toBe(1);
    expect(
      (await request({ catalogId: catalog.id, cursor: "broken" })).data.map(
        (agent) => agent.id,
      ),
    ).toEqual([delta.id, gamma.id]);
    const noInstalls = await makeInternalMcpCatalog({ organizationId: org.id });
    expect(
      (await request({ catalogId: noInstalls.id })).data.map(
        (agent) => agent.id,
      ),
    ).toEqual([alpha.id, delta.id, gamma.id]);
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/mcp_server/auto_mode_agents/page?catalogId=${foreignCatalog.id}`,
    });
    expect(forbidden.statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

test("member automatic counts and pages retain visible-agent and readable-catalog fences", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalMcpCatalog,
  makeAgent,
  makeMcpServer,
  makeTool,
  makeAgentTool,
}) => {
  const org = await makeOrganization();
  const user = await makeUser(),
    colleague = await makeUser();
  await makeMember(user.id, org.id);
  await makeMember(colleague.id, org.id);
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const privateCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    authorId: colleague.id,
    access: "personal",
  });
  const mine = await makeAgent({
    organizationId: org.id,
    authorId: user.id,
    name: "Mine",
    accessAllTools: true,
    access: "personal",
  });
  const shared = await makeAgent({
    organizationId: org.id,
    authorId: colleague.id,
    name: "Shared",
    accessAllTools: true,
    access: "org",
  });
  const privateAgent = await makeAgent({
    organizationId: org.id,
    authorId: colleague.id,
    name: "Private",
    accessAllTools: true,
    access: "personal",
  });
  const install = await makeMcpServer({ catalogId: catalog.id });
  const tool = await makeTool({ catalogId: catalog.id });
  await makeAgentTool(privateAgent.id, tool.id, { mcpServerId: install.id });
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.user = user;
    request.organizationId = org.id;
  });
  const { default: mcpServerRoutes } = await import("./mcp-server");
  await app.register(mcpServerRoutes);
  try {
    const summary = await app.inject({
      method: "GET",
      url: "/api/mcp_server/auto_mode_agents/page?summary=true",
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().totalAutoCount).toBe(2);
    const response = await app.inject({
      method: "GET",
      url: `/api/mcp_server/auto_mode_agents/page?catalogId=${catalog.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      McpAutoModeAgentPageSchema.parse(response.json()).data.map(
        (agent) => agent.id,
      ),
    ).toEqual([mine.id, shared.id]);
    const legacyInstalls = await app.inject({
      method: "GET",
      url: `/api/mcp_server?catalogId=${catalog.id}`,
    });
    expect(legacyInstalls.statusCode).toBe(200);
    expect(
      legacyInstalls
        .json()
        .flatMap(
          (server: { assignedAgents: Array<{ id: string }> }) =>
            server.assignedAgents,
        )
        .map((agent: { id: string }) => agent.id),
    ).not.toContain(privateAgent.id);
    const privateBoundary = await app.inject({
      method: "GET",
      url: `/api/mcp_server/auto_mode_agents/page?catalogId=${catalog.id}&afterAgentId=${privateAgent.id}`,
    });
    expect(privateBoundary.statusCode).toBe(200);
    expect(
      McpAutoModeAgentPageSchema.parse(privateBoundary.json()).data.map(
        (agent) => agent.id,
      ),
    ).toEqual([mine.id, shared.id]);
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/mcp_server/auto_mode_agents/page?catalogId=${privateCatalog.id}`,
    });
    expect(forbidden.statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

test("dense assigned prefixes cannot hide later automatic-only agents or truncate cursor pages", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeTool,
  makeAgent,
  makeAgentTool,
}) => {
  const org = await makeOrganization(),
    user = await makeUser();
  await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const install = await makeMcpServer({ catalogId: catalog.id });
  const tool = await makeTool({ catalogId: catalog.id });
  const assigned = await Promise.all(
    Array.from({ length: 105 }, (_, i) =>
      makeAgent({
        organizationId: org.id,
        name: `Assigned ${String(i).padStart(3, "0")}`,
        accessAllTools: true,
      }),
    ),
  );
  await Promise.all(
    assigned.map((agent) =>
      makeAgentTool(agent.id, tool.id, { mcpServerId: install.id }),
    ),
  );
  const first = await makeAgent({
    organizationId: org.id,
    name: "Zeta 1",
    accessAllTools: true,
  });
  const second = await makeAgent({
    organizationId: org.id,
    name: "Zeta 2",
    accessAllTools: true,
  });
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.user = user;
    request.organizationId = org.id;
  });
  await app.register(routes);
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/mcp_server/auto_mode_agents/page?catalogId=${catalog.id}&limit=1`,
    });
    expect(response.statusCode).toBe(200);
    const page = McpAutoModeAgentPageSchema.parse(response.json());
    expect(page.data.map((agent) => agent.id)).toEqual([first.id]);
    expect(page.pagination.hasNext).toBe(true);
    const next = await app.inject({
      method: "GET",
      url: `/api/mcp_server/auto_mode_agents/page?catalogId=${catalog.id}&limit=1&cursor=${encodeURIComponent(page.pagination.nextCursor ?? "")}`,
    });
    expect(next.statusCode).toBe(200);
    const end = McpAutoModeAgentPageSchema.parse(next.json());
    expect(end.data.map((agent) => agent.id)).toEqual([second.id]);
    expect(end.pagination.hasNext).toBe(false);
  } finally {
    await app.close();
  }
});

test("same-name cursor pages use owner email and id across automatic and assigned boundaries", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeTool,
  makeAgent,
  makeAgentTool,
}) => {
  const org = await makeOrganization(),
    user = await makeUser();
  const earlyOwner = await makeUser({ email: "early-owner@example.test" });
  const lateOwner = await makeUser({ email: "late-owner@example.test" });
  await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const server = await makeMcpServer({ catalogId: catalog.id });
  const tool = await makeTool({ catalogId: catalog.id });
  const automatic = await Promise.all(
    [earlyOwner, earlyOwner, lateOwner].map((owner) =>
      makeAgent({
        organizationId: org.id,
        name: "Repeated",
        authorId: owner.id,
        accessAllTools: true,
      }),
    ),
  );
  const manual = await makeAgent({
    organizationId: org.id,
    name: "Repeated",
    authorId: earlyOwner.id,
    accessAllTools: false,
  });
  await makeAgentTool(manual.id, tool.id, { mcpServerId: server.id });
  const expected = automatic
    .map((agent, index) => ({
      ...agent,
      email: index < 2 ? earlyOwner.email : lateOwner.email,
    }))
    .sort((a, b) => a.email.localeCompare(b.email) || a.id.localeCompare(b.id));
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.user = user;
    request.organizationId = org.id;
  });
  await app.register(routes);
  try {
    let cursor: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const query = new URLSearchParams({
        catalogId: catalog.id,
        limit: "1",
        ...(cursor ? { cursor } : {}),
      });
      const response = await app.inject({
        method: "GET",
        url: `/api/mcp_server/auto_mode_agents/page?${query}`,
      });
      expect(response.statusCode).toBe(200);
      const page = McpAutoModeAgentPageSchema.parse(response.json());
      ids.push(...page.data.map((agent) => agent.id));
      cursor = page.pagination.nextCursor;
    }
    expect(ids).toEqual(expected.map((agent) => agent.id));
    const response = await app.inject({
      method: "GET",
      url: `/api/mcp_server/auto_mode_agents/page?catalogId=${catalog.id}&afterAgentId=${manual.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      McpAutoModeAgentPageSchema.parse(response.json()).data.map(
        (agent) => agent.id,
      ),
    ).toEqual(
      expected
        .filter(
          (agent) => agent.email > earlyOwner.email || agent.id > manual.id,
        )
        .map((agent) => agent.id),
    );
  } finally {
    await app.close();
  }
});
