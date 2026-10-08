import { ADMIN_ROLE_NAME, BUILT_IN_CATALOG_IDS } from "@archestra/shared";
import { and, asc, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  InternalMcpCatalogModel,
  McpServerModel,
  OrganizationModel,
  ToolModel,
} from "@/models";
import AgentSuggestedPromptModel from "@/models/agent-suggested-prompt";
import { openappaBatteriesService } from "@/openappa/batteries";
import type { McpServer } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * Installs the public Archestra and OpenAPPA docs MCP servers (list_docs,
 * read_doc, search_docs, …) on a fresh community instance, and adds their
 * suggested prompts ("What can Archestra do?", …) to the admin's personal
 * assistant, so a first chat can answer from the current docs.
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

    await addSuggestedPrompts({
      prompts: missing.map((server) => server.suggestedPrompt),
      organizationId: org.id,
      adminUserId: admin.userId,
    });
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

type DocsMcpServer = {
  catalogId: string;
  name: string;
  description: string;
  serverUrl: string;
  docsUrl: string;
  icon: string;
  suggestedPrompt: { summaryTitle: string; prompt: string };
};

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

/** Leaves an assistant whose prompts someone already set untouched. */
async function addSuggestedPrompts(params: {
  prompts: DocsMcpServer["suggestedPrompt"][];
  organizationId: string;
  adminUserId: string;
}): Promise<void> {
  const agentId = await AgentModel.ensurePersonalChatAgent({
    userId: params.adminUserId,
    organizationId: params.organizationId,
  });
  if (!agentId) return;
  if ((await AgentSuggestedPromptModel.getForAgent(agentId)).length > 0) {
    return;
  }
  await AgentSuggestedPromptModel.syncForAgent({
    agentId,
    prompts: params.prompts,
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

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const ARCHESTRA_LOGO_SVG = `<svg width="32" height="32" viewBox="0 0 994 953" xmlns="http://www.w3.org/2000/svg"><rect width="993.958" height="952.543" rx="204.92" fill="black"/><path fill-rule="evenodd" clip-rule="evenodd" d="M390.871 664.818C427.68 664.818 460.629 641.985 473.553 607.519L565.238 363.026C586.887 305.296 544.211 243.715 482.556 243.715C445.747 243.715 412.798 266.548 399.874 301.014L308.189 545.507C286.54 603.237 329.216 664.818 390.871 664.818Z" fill="white"/><ellipse cx="638.487" cy="577.095" rx="87.7298" ry="81.1501" fill="white"/></svg>`;

const OPENAPPA_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges"><rect width="32" height="32" rx="6.6" fill="#211e1b" shape-rendering="geometricPrecision"/><g transform="translate(4,5)"><rect x="5" y="0" width="2" height="2" fill="#efece6"/><rect x="17" y="0" width="2" height="2" fill="#efece6"/><rect x="4" y="2" width="16" height="1" fill="#efece6"/><rect x="3" y="3" width="18" height="3" fill="#efece6"/><rect x="3" y="6" width="3" height="3" fill="#efece6"/><rect x="9" y="6" width="6" height="3" fill="#efece6"/><rect x="18" y="6" width="3" height="3" fill="#efece6"/><rect x="6" y="6" width="3" height="3" fill="#211e1b"/><rect x="15" y="6" width="3" height="3" fill="#211e1b"/><rect x="3" y="9" width="18" height="1" fill="#efece6"/><rect x="3" y="10" width="7" height="2" fill="#efece6"/><rect x="14" y="10" width="7" height="2" fill="#efece6"/><rect x="10" y="10" width="4" height="1" fill="#8f8b86"/><rect x="10" y="11" width="1" height="1" fill="#8f8b86"/><rect x="11" y="11" width="2" height="1" fill="#211e1b"/><rect x="13" y="11" width="1" height="1" fill="#8f8b86"/><rect x="3" y="12" width="18" height="1" fill="#efece6"/><rect x="4" y="13" width="16" height="1" fill="#efece6"/><rect x="1" y="14" width="22" height="1" fill="#efece6"/><rect x="0" y="15" width="24" height="5" fill="#efece6"/><rect x="0" y="20" width="5" height="1" fill="#efece6"/><rect x="7" y="20" width="4" height="1" fill="#efece6"/><rect x="13" y="20" width="4" height="1" fill="#efece6"/><rect x="19" y="20" width="5" height="1" fill="#efece6"/><rect x="0" y="21" width="5" height="1" fill="#8f8b86"/><rect x="7" y="21" width="4" height="1" fill="#8f8b86"/><rect x="13" y="21" width="4" height="1" fill="#8f8b86"/><rect x="19" y="21" width="5" height="1" fill="#8f8b86"/></g></svg>`;

const DOCS_MCP_SERVERS: DocsMcpServer[] = [
  {
    catalogId: "00000000-0000-4000-8000-000000000003",
    name: "Archestra Docs",
    description: "The Archestra documentation.",
    serverUrl: "https://archestra.ai/mcp",
    docsUrl: "https://archestra.ai/docs",
    icon: svgDataUrl(ARCHESTRA_LOGO_SVG),
    suggestedPrompt: {
      summaryTitle: "What can Archestra do?",
      prompt:
        "What can Archestra do? Use the Archestra Docs tools to read the current documentation, then give me a short tour of the main features, with links to the docs pages.",
    },
  },
  {
    catalogId: "00000000-0000-4000-8000-000000000004",
    name: "OpenAPPA Docs",
    description: "The OpenAPPA documentation.",
    serverUrl: "https://www.openappa.com/mcp",
    docsUrl: "https://www.openappa.com",
    icon: svgDataUrl(OPENAPPA_LOGO_SVG),
    suggestedPrompt: {
      summaryTitle: "How does OpenAPPA protect agents?",
      prompt:
        "How does OpenAPPA keep my agents from leaking data? Use the OpenAPPA Docs tools to read the current documentation, then explain it in a few short points, with links to the docs pages.",
    },
  },
];

const DOCS_MCP_CATALOG_IDS = DOCS_MCP_SERVERS.map((server) => server.catalogId);
