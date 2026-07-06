import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/tools/:id", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    const org = await makeOrganization();
    organizationId = org.id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: toolRoutes } = await import("./tool");
    await app.register(toolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns id, name and parameters for a tool in the caller's org", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    // An org-scoped install makes the catalog accessible to the caller.
    await makeMcpServer({ catalogId: catalog.id, scope: "org" });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "workspace__export_data",
      parameters: { type: "object", properties: { destination: {} } },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/tools/${tool.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: tool.id,
      name: "workspace__export_data",
      parameters: { type: "object", properties: { destination: {} } },
    });
  });

  test("returns 404 for a tool in another organization", async ({
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const otherOrg = await makeOrganization();
    const otherCatalog = await makeInternalMcpCatalog({
      organizationId: otherOrg.id,
    });
    const tool = await makeTool({
      catalogId: otherCatalog.id,
      name: "other-org-tool",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/tools/${tool.id}`,
    });

    expect(response.statusCode).toBe(404);
  });
});
