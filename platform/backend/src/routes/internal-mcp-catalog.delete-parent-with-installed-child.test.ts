import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * The preset feature is removed, but legacy child rows (non-NULL
 * `parentCatalogItemId`) may still exist in the DB. Deleting a parent catalog
 * item when one of those legacy children has an installed mcp_server must
 * still succeed and tear the child subtree down.
 *
 * Trap: `mcp_server.catalog_id` is `NOT NULL` but its FK declares
 * `ON DELETE SET NULL`. The parent's DB cascade tries to clear the column on
 * the child's server rows and aborts the whole DELETE with a NOT NULL
 * violation. The model must therefore remove servers for the WHOLE subtree
 * (parent + every legacy descendant) before issuing the catalog DELETE.
 */
describe("DELETE /api/internal_mcp_catalog/:id — parent with installed legacy child", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

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

  test("succeeds when a legacy child has an installed mcp_server", async ({
    makeMcpServer,
  }) => {
    const parent = await createCatalog({
      name: "parent-with-installed-child",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
      },
    });

    const child = await seedLegacyChild(parent.id);

    const installedServer = await makeMcpServer({
      catalogId: child.id,
      ownerId: user.id,
      scope: "personal",
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${parent.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);

    const parentRow = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, parent.id));
    expect(parentRow).toHaveLength(0);

    const childRow = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, child.id));
    expect(childRow).toHaveLength(0);

    const serverRow = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow).toHaveLength(0);
  });

  async function createCatalog(payload: Record<string, unknown>): Promise<{
    id: string;
  }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload,
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createCatalog failed: ${response.statusCode} ${response.body}`,
      );
    }
    return response.json();
  }

  // The preset CRUD routes are gone, so seed the legacy child row straight
  // into the table by cloning the parent and pointing it at the parent.
  async function seedLegacyChild(parentId: string): Promise<{ id: string }> {
    const [parentRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, parentId));
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = parentRow;
    const [child] = await db
      .insert(schema.internalMcpCatalogTable)
      .values({
        ...rest,
        name: `${parentRow.name}-prod`,
        childName: "prod",
        parentCatalogItemId: parentId,
      })
      .returning({ id: schema.internalMcpCatalogTable.id });
    return child;
  }
});
