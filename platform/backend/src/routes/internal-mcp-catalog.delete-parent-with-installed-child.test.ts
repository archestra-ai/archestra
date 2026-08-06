import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * The preset feature is removed, but legacy child rows (non-NULL
 * `parentCatalogItemId`) may still exist in the DB. Deleting a parent catalog
 * item when one of those legacy children has an installed mcp_server must
 * still succeed and soft-delete the child subtree.
 *
 * Delete is now SOFT: the catalog rows, their installs, and their tools survive
 * with a shared `deletedAt` stamp (the restore correlation key), and the DB
 * secret rows are RETAINED so a restore + reinstall recovers stored credentials.
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

  test("soft-deletes the subtree when a legacy child has an installed mcp_server", async ({
    makeMcpServer,
    makeTool,
    makeSecret,
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

    // The install carries a DB secret that soft-delete must RETAIN.
    const secret = await makeSecret();
    const installedServer = await makeMcpServer({
      catalogId: child.id,
      ownerId: user.id,
      scope: "personal",
    });
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: secret.id })
      .where(eq(schema.mcpServersTable.id, installedServer.id));

    // A tool on the child catalog must be soft-deleted by the cascade.
    const tool = await makeTool({ catalogId: child.id });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${parent.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);

    // Rows survive (soft-deleted), each carrying a deletedAt stamp.
    const [parentRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, parent.id));
    expect(parentRow?.deletedAt).not.toBeNull();

    const [childRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, child.id));
    expect(childRow?.deletedAt).not.toBeNull();

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow?.deletedAt).not.toBeNull();

    const [toolRow] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, tool.id));
    expect(toolRow?.deletedAt).not.toBeNull();

    // The whole cascade shares ONE timestamp (the restore correlation key).
    const at = parentRow?.deletedAt?.getTime();
    expect(childRow?.deletedAt?.getTime()).toBe(at);
    expect(serverRow?.deletedAt?.getTime()).toBe(at);
    expect(toolRow?.deletedAt?.getTime()).toBe(at);

    // Secret retention: the DB secret row is NOT deleted on soft-delete.
    const secretRow = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, secret.id));
    expect(secretRow).toHaveLength(1);
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
