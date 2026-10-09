import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("tool routes", () => {
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

  test("returns a bounded page from the tools collection", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: catalog.id, name: "first-tool" });
    await makeTool({ catalogId: catalog.id, name: "second-tool" });

    const response = await app.inject({
      method: "GET",
      url: "/api/tools?limit=1&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [expect.objectContaining({ catalogId: catalog.id })],
      pagination: {
        currentPage: 1,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasNext: true,
        hasPrev: false,
      },
    });
  });
});
