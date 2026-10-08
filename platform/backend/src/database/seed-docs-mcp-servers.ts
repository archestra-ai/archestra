import { ADMIN_ROLE_NAME, BUILT_IN_CATALOG_IDS } from "@archestra/shared";
import { and, asc, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  InternalMcpCatalogModel,
  McpServerModel,
  OrganizationModel,
  ToolModel,
} from "@/models";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  DOCS_MCP_CATALOG_IDS,
  DOCS_MCP_SERVERS,
  type DocsMcpServer,
} from "@/services/docs-mcp-servers";
import type { McpServer } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * Installs the public Archestra and OpenAPPA docs MCP servers (list_docs,
 * read_doc, search_docs, …) on a fresh community instance, so a first chat can
 * answer from the current docs. Their suggested prompts are not stored: chat
 * shows them at read time (see getDocsSuggestedPrompts).
 *
 * Seeded once per server. Each catalog row has a fixed id and deleting it only
 * soft-deletes it, so the row is the durable marker: an admin who deletes a
 * server never sees it come back. Uninstalling a server (deleting its install)
 * is honored the same way.
 *
 * Skipped on instances with an enterprise license (the raw env flag, not the
 * effective tier, which also covers small teams), and on instances whose MCP
 * registry is not pristine, so upgrades do not add the servers to registries
 * an admin already curates. Tool discovery calls the public sites, so it runs
 * in the background: an offline or air-gapped instance still starts, and
 * discovery is retried on the next start while an install has no tools.
 */
export async function seedDocsMcpServers(): Promise<void> {
  if (config.enterpriseFeatures.core) return;

  try {
    // Deliberately includes soft-deleted rows (see above).
    const existingRows = await db
      .select({
        id: schema.internalMcpCatalogTable.id,
        deletedAt: schema.internalMcpCatalogTable.deletedAt,
      })
      .from(schema.internalMcpCatalogTable)
      .where(inArray(schema.internalMcpCatalogTable.id, DOCS_MCP_CATALOG_IDS));
    const existing = new Map(existingRows.map((row) => [row.id, row]));

    for (const row of existingRows) {
      if (!row.deletedAt) await retryToolDiscovery(row.id);
    }

    const missing = DOCS_MCP_SERVERS.filter(
      (server) => !existing.has(server.catalogId),
    );
    if (missing.length === 0 || !(await isMcpRegistryPristine())) return;

    const org = await OrganizationModel.getOrCreateDefaultOrganization();
    // The catalog rows and installs need an author: the org's earliest admin.
    const [admin] = await db
      .select({ userId: schema.membersTable.userId })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.organizationId, org.id),
          eq(schema.membersTable.role, ADMIN_ROLE_NAME),
        ),
      )
      .orderBy(asc(schema.membersTable.createdAt))
      .limit(1);
    if (!admin) return;

    for (const server of missing) {
      const mcpServer = await installDocsMcpServer({
        server,
        organizationId: org.id,
        adminUserId: admin.userId,
      });
      trackBackgroundWork(discoverTools(mcpServer));
    }

    logger.info(
      {
        organizationId: org.id,
        servers: missing.map((server) => server.name),
      },
      "Seeded the docs MCP servers",
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to seed the docs MCP servers");
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

// Seeded only in development and CI (see seedTestMcpServer in seed.ts).
const TEST_MCP_SERVER_NAME = "internal-dev-test-server";

async function installDocsMcpServer(params: {
  server: DocsMcpServer;
  organizationId: string;
  adminUserId: string;
}): Promise<McpServer> {
  const { server, organizationId, adminUserId } = params;
  const catalogItem = await InternalMcpCatalogModel.create(
    {
      id: server.catalogId,
      name: server.name,
      description: server.description,
      serverType: "remote",
      serverUrl: server.serverUrl,
      docsUrl: server.docsUrl,
      icon: server.icon,
      requiresAuth: false,
    },
    { organizationId, authorId: adminUserId, publishToOrganization: true },
  );

  // One org-wide install: the server needs no credentials, so every member
  // (and every agent with access to all tools) can use it.
  return McpServerModel.create({
    name: catalogItem.name,
    catalogId: catalogItem.id,
    serverType: "remote",
    scope: "org",
    ownerId: adminUserId,
    teamId: null,
  });
}

/** No MCP server was ever added to the registry, deleted ones included. */
async function isMcpRegistryPristine(): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.internalMcpCatalogTable.id })
    .from(schema.internalMcpCatalogTable)
    .where(
      and(
        inArray(schema.internalMcpCatalogTable.serverType, ["local", "remote"]),
        notInArray(schema.internalMcpCatalogTable.id, [
          ...BUILT_IN_CATALOG_IDS,
          ...DOCS_MCP_CATALOG_IDS,
        ]),
        ne(schema.internalMcpCatalogTable.name, TEST_MCP_SERVER_NAME),
      ),
    )
    .limit(1);
  return !row;
}

/** Re-runs discovery when an earlier start could not reach the server. */
async function retryToolDiscovery(catalogId: string): Promise<void> {
  const [tool] = await db
    .select({ id: schema.toolsTable.id })
    .from(schema.toolsTable)
    .where(
      and(
        eq(schema.toolsTable.catalogId, catalogId),
        isNull(schema.toolsTable.deletedAt),
      ),
    )
    .limit(1);
  if (tool) return;

  const [mcpServer] = await db
    .select()
    .from(schema.mcpServersTable)
    .where(
      and(
        eq(schema.mcpServersTable.catalogId, catalogId),
        isNull(schema.mcpServersTable.deletedAt),
      ),
    )
    .limit(1);
  // No live install: an admin uninstalled it, which must stick.
  if (!mcpServer) return;

  trackBackgroundWork(discoverTools(mcpServer));
}

async function discoverTools(mcpServer: McpServer): Promise<void> {
  const catalogId = mcpServer.catalogId;
  try {
    const tools = await McpServerModel.getToolsFromServer(mcpServer);
    await ToolModel.bulkCreateToolsIfNotExists(
      tools.map((tool) => ({
        name: ToolModel.slugifyName(mcpServer.name, tool.name),
        rawToolName: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        meta: { _meta: tool._meta, annotations: tool.annotations },
        catalogId,
      })),
    );
    await McpServerModel.update(mcpServer.id, {
      localInstallationStatus: "success",
      localInstallationError: null,
    });
    trackBackgroundWork(
      openappaBatteriesService.onCatalogToolsChanged(catalogId),
    );
  } catch (error) {
    logger.warn(
      { err: error, mcpServerId: mcpServer.id },
      "Could not discover the docs MCP server's tools; retrying on next start",
    );
    await McpServerModel.update(mcpServer.id, {
      localInstallationStatus: "error",
      localInstallationError:
        error instanceof Error ? error.message : "Unknown error",
    });
  }
}
