// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { createFastifyInstance } from "@/fastify-instance";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import McpServerAgentUsageModel from "@/models/mcp-server-agent-usage";
import { expect, test } from "@/test";
import type { McpAgentUsagePage } from "@/types/mcp-server-agent-usage";
import mcpServerAgentUsageRoutes from "./mcp-server-agent-usage";

test("usage pages merge assigned and auto agents once, with bounded previews, search, sorting and catalog isolation", async ({
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
  const install = await makeMcpServer({ catalogId: catalog.id });
  const secondInstall = await makeMcpServer({ catalogId: catalog.id });
  const tools = await Promise.all([
    makeTool({ catalogId: catalog.id }),
    makeTool({ catalogId: catalog.id }),
  ]);
  const alpha = await makeAgent({
    organizationId: org.id,
    name: "Alpha",
    accessAllTools: true,
  });
  const beta = await makeAgent({
    organizationId: org.id,
    name: "Beta",
    accessAllTools: false,
  });
  await makeAgentTool(alpha.id, tools[0].id, { mcpServerId: install.id });
  await makeAgentTool(alpha.id, tools[1].id);
  await makeAgentTool(beta.id, tools[0].id, { mcpServerId: secondInstall.id });
  await makeAgent({
    organizationId: org.id,
    name: "Gamma_%",
    accessAllTools: true,
  });
  await makeAgent({
    organizationId: org.id,
    name: "Delta",
    accessAllTools: true,
  });
  const deleted = await makeAgent({
    organizationId: org.id,
    name: "Deleted",
    accessAllTools: true,
  });
  await AgentModel.delete(deleted.id);
  const foreignOrg = await makeOrganization();
  const foreignCatalog = await makeInternalMcpCatalog({
    organizationId: foreignOrg.id,
  });
  await makeAgent({
    organizationId: foreignOrg.id,
    name: "Foreign",
    accessAllTools: true,
  });
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.user = user;
    request.organizationId = org.id;
  });
  await app.register(mcpServerAgentUsageRoutes);
  const request = async (extra = "") => {
    const query = new URLSearchParams({
      catalogIds: `${catalog.id},${foreignCatalog.id}`,
      limit: "2",
    });
    for (const [key, value] of new URLSearchParams(extra))
      query.set(key, value);
    const response = await app.inject({
      method: "GET",
      url: `/api/mcp_server/agent_usage?${query}`,
    });
    expect(response.statusCode).toBe(200);
    const pages: McpAgentUsagePage[] = response.json();
    expect(pages.map((page) => page.catalogId)).toEqual([catalog.id]);
    return pages[0];
  };
  try {
    const first = await request();
    expect(first).toMatchObject({
      assignedCount: 2,
      autoCount: 2,
      pagination: { total: 4, hasNext: true },
    });
    expect(first.data.map((agent) => [agent.name, agent.access])).toEqual([
      ["Alpha", "assigned"],
      ["Beta", "assigned"],
    ]);
    expect(
      (await request("&offset=2")).data.map((agent) => agent.name),
    ).toEqual(["Delta", "Gamma_%"]);
    expect(
      (await request("&sortDirection=desc")).data.map((agent) => agent.name),
    ).toEqual(["Gamma_%", "Delta"]);
    const search = await request("&search=mm");
    expect(search.data.map((agent) => agent.name)).toEqual(["Gamma_%"]);
    expect(search.pagination.total).toBe(1);
    expect(
      (await request("&search=%25")).data.map((agent) => agent.name),
    ).toEqual(["Gamma_%"]);
    expect(
      (await request("&search=_")).data.map((agent) => agent.name),
    ).toEqual(["Gamma_%"]);
    const previews = await request("&previews=true&limit=1");
    expect(previews.assignedPreview.map((agent) => agent.name)).toEqual([
      "Alpha",
    ]);
    expect(previews.autoPreview.map((agent) => agent.name)).toEqual(["Delta"]);
    expect(previews.pagination.total).toBe(4);
    expect(
      (await request("&previews=true&limit=1&offset=1")).autoPreview.map(
        (agent) => agent.name,
      ),
    ).toEqual(["Gamma_%"]);
    const otherLocal = await makeInternalMcpCatalog({ organizationId: org.id });
    const batchResponse = await app.inject({
      method: "GET",
      url: `/api/mcp_server/agent_usage?catalogIds=${catalog.id},${otherLocal.id}&previews=true&limit=1`,
    });
    expect(batchResponse.statusCode).toBe(200);
    const batch: McpAgentUsagePage[] = batchResponse.json();
    expect(
      batch
        .find((page) => page.catalogId === catalog.id)
        ?.autoPreview.map((agent) => agent.name),
    ).toEqual(["Delta"]);
    expect(
      batch.find((page) => page.catalogId === otherLocal.id),
    ).toMatchObject({
      assignedCount: 0,
      autoCount: 3,
      pagination: { total: 3 },
    });
    expect(
      batch
        .find((page) => page.catalogId === otherLocal.id)
        ?.autoPreview.map((agent) => agent.name),
    ).toEqual(["Alpha"]);
  } finally {
    await app.close();
  }
});

test("members only receive readable catalogs and visible agents, including an empty visible roster", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalMcpCatalog,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const colleague = await makeUser();
  await makeMember(user.id, org.id);
  await makeMember(colleague.id, org.id);
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const privateCatalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    authorId: colleague.id,
    access: "personal",
  });
  await makeAgent({
    organizationId: org.id,
    authorId: user.id,
    name: "Mine",
    accessAllTools: true,
    access: "personal",
  });
  await makeAgent({
    organizationId: org.id,
    authorId: colleague.id,
    name: "Shared",
    accessAllTools: true,
    access: "org",
  });
  await makeAgent({
    organizationId: org.id,
    authorId: colleague.id,
    name: "Private",
    accessAllTools: true,
    access: "personal",
  });
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.user = user;
    request.organizationId = org.id;
  });
  await app.register(mcpServerAgentUsageRoutes);
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/mcp_server/agent_usage?catalogIds=${catalog.id},${privateCatalog.id}`,
    });
    expect(response.statusCode).toBe(200);
    const pages: McpAgentUsagePage[] = response.json();
    expect(pages.map((page) => page.catalogId)).toEqual([catalog.id]);
    expect(pages[0].data.map((agent) => agent.name)).toEqual([
      "Mine",
      "Shared",
    ]);
    expect(pages[0]).toMatchObject({
      assignedCount: 0,
      autoCount: 2,
      pagination: { total: 2 },
    });
  } finally {
    await app.close();
  }
});

test("bounded assigned usage preserves legacy distinct membership across foreign owners, duplicate tools and deleted agents", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeAgent,
  makeTool,
  makeAgentTool,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
  const server = await makeMcpServer({ catalogId: catalog.id });
  const tool = await makeTool({ catalogId: catalog.id });
  const anotherTool = await makeTool({ catalogId: catalog.id });
  const local = await makeAgent({
    organizationId: org.id,
    accessAllTools: false,
  });
  const foreign = await makeAgent({
    organizationId: otherOrg.id,
    accessAllTools: true,
  });
  const deleted = await makeAgent({
    organizationId: org.id,
    accessAllTools: false,
  });
  await makeAgentTool(local.id, tool.id, { mcpServerId: server.id });
  await makeAgentTool(local.id, anotherTool.id);
  await makeAgentTool(foreign.id, tool.id);
  await makeAgentTool(deleted.id, tool.id);
  await AgentModel.delete(deleted.id);
  const legacy = await AgentToolModel.getAssignedAgentDetailsForMcpServers([
    server.id,
  ]);
  const expectedIds = legacy
    .get(server.id)
    ?.map((entry) => entry.id)
    .sort();
  expect(expectedIds).toEqual([local.id, foreign.id].sort());
  for (const previews of [true, false]) {
    const [page] = await McpServerAgentUsageModel.find({
      catalogIds: [catalog.id],
      serverIds: [server.id],
      organizationId: org.id,
      limit: 20,
      offset: 0,
      sortDirection: "asc",
      previews,
    });
    expect(page.data.map((entry) => entry.id).sort()).toEqual(expectedIds);
    expect(page).toMatchObject({
      assignedCount: 2,
      autoCount: 0,
      pagination: { total: 2 },
    });
  }
});
