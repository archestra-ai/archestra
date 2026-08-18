import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/mcp_server/auto_mode_agents", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: mcpServerRoutes } = await import("./mcp-server");
    await app.register(mcpServerRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns the org's auto-mode agents once, not embedded per server", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
  }) => {
    const autoAgent = await makeAgent({
      organizationId,
      name: "Auto Agent",
      accessAllTools: true,
    });
    // Explicit-assignment agents are not auto-mode; other orgs don't leak in.
    await makeAgent({
      organizationId,
      name: "Custom Agent",
      accessAllTools: false,
    });
    const otherOrg = await makeOrganization();
    await makeAgent({
      organizationId: otherOrg.id,
      name: "Other Org Auto",
      accessAllTools: true,
    });

    // Several installs exist, but the auto-mode roster is served exactly once
    // by this endpoint rather than duplicated onto every server row.
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeMcpServer({ catalogId: catalog.id });
    await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "GET",
      url: "/api/mcp_server/auto_mode_agents",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ id: autoAgent.id, name: "Auto Agent" }),
    ]);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/mcp_server",
    });
    expect(listResponse.statusCode).toBe(200);
    for (const server of listResponse.json()) {
      expect(server).not.toHaveProperty("autoModeAgents");
    }
  });
});
