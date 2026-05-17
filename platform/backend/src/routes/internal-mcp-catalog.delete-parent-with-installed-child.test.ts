import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { McpPresetEntryModel } from "@/models";
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
 * Deleting a parent catalog item when one of its children has an installed
 * mcp_server must succeed.
 *
 * Trap: `mcp_server.catalog_id` is `NOT NULL` but its FK declares
 * `ON DELETE SET NULL`. The parent's DB cascade tries to clear the column on
 * the child's server rows and aborts the whole DELETE with a NOT NULL
 * violation. The model must therefore remove servers for the WHOLE subtree
 * (parent + every descendant) before issuing the catalog DELETE.
 */
describe("DELETE /api/internal_mcp_catalog/:id — parent with installed child", () => {
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

  test("succeeds when a child has an installed mcp_server", async ({
    makeMcpServer,
  }) => {
    const parent = await createCatalog({
      name: "parent-with-installed-child",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "PRESET_PASSWORD",
            type: "secret",
            promptOnInstallation: false,
            promptOnPreset: true,
          },
        ],
      },
    });

    const child = await createChild(parent.id, {
      childName: "prod",
      presetFieldValues: { PRESET_PASSWORD: "child-secret" },
    });

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

  async function createChild(
    parentId: string,
    body: { childName: string; presetFieldValues: Record<string, unknown> },
  ): Promise<{ id: string }> {
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: body.childName,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parentId}/children`,
      payload: {
        presetEntryId: entry.id,
        presetFieldValues: body.presetFieldValues,
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createChild failed: ${response.statusCode} ${response.body}`,
      );
    }
    return response.json();
  }
});
