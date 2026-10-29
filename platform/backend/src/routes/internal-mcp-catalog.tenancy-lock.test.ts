import { vi } from "vitest";
import { betterAuth } from "@/auth";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * Tenancy is locked once a catalog item exists. An update that tries to flip
 * it must be refused, not silently dropped with a 200.
 */
describe("PUT /api/internal_mcp_catalog/:id — tenancy lock", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: user.id } }) as never,
    );

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("refuses to change tenancy after creation", async () => {
    const catalog = await createCatalog();

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { multitenant: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/Tenancy can't be changed/);

    const after = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
    });
    expect(after.json().multitenant).toBe(false);
  });

  test("accepts the unchanged tenancy an edit form sends back", async () => {
    const catalog = await createCatalog();

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { multitenant: false, description: "updated" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().description).toBe("updated");
  });

  async function createCatalog(): Promise<{ id: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "tenancy-lock",
        serverType: "local",
        multitenant: false,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [],
        },
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createCatalog failed: ${response.statusCode} ${response.body}`,
      );
    }
    return response.json();
  }
});
