import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
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
 * Deleting a preset entry must also tear down everything installed against
 * the per-entry catalog rows it owns. The route currently performs a raw SQL
 * DELETE that relies on the FK cascade, which bypasses
 * `InternalMcpCatalogModel.delete()` / `McpServerModel.delete()` — so K8s
 * pods, agent_tools, and `mcp_server` rows survive an entry deletion, and the
 * `mcp_server.catalog_id` `NOT NULL` constraint can make the cascade fail
 * outright when servers are present.
 */
describe("Delete preset entry cascade", () => {
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

    const { default: catalogRoutes } = await import("./internal-mcp-catalog");
    const { default: presetEntryRoutes } = await import("./mcp-preset-entry");
    await app.register(catalogRoutes);
    await app.register(presetEntryRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("deleting a preset entry uninstalls servers tied to its per-entry catalog rows", async ({
    makeMcpServer,
  }) => {
    const removeMcpServerSpy = vi
      .spyOn(McpServerRuntimeManager, "removeMcpServer")
      .mockResolvedValue(undefined);

    const parent = await createCatalog({
      name: "preset-entry-cascade-parent",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
      },
    });

    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "production",
    });

    const childResponse = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parent.id}/children`,
      payload: {
        presetEntryId: entry.id,
        presetFieldValues: {},
      },
    });
    expect(childResponse.statusCode).toBe(200);
    const child = childResponse.json<{ id: string }>();

    // Simulate an installed MCP server tied to the per-entry catalog row.
    const installedServer = await makeMcpServer({
      catalogId: child.id,
      ownerId: user.id,
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/organization/mcp-preset-entries/${entry.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);

    // The preset entry must be gone.
    const remainingEntry = await db
      .select()
      .from(schema.mcpPresetEntriesTable)
      .where(eq(schema.mcpPresetEntriesTable.id, entry.id));
    expect(remainingEntry).toHaveLength(0);

    // The per-entry catalog row must be gone.
    const remainingChild = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, child.id));
    expect(remainingChild).toHaveLength(0);

    // The installed MCP server must be uninstalled — row removed and K8s
    // deployment teardown invoked. Today the route bypasses
    // McpServerModel.delete(), so neither happens.
    const remainingServer = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(remainingServer).toHaveLength(0);

    expect(removeMcpServerSpy).toHaveBeenCalledWith(installedServer.id);
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
});
