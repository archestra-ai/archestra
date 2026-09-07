import { createHash } from "node:crypto";
import {
  PLAYWRIGHT_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_SERVER_NAME,
} from "@archestra/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { constructFrozenMcpDeploymentName } from "@/k8s/shared";
import type { McpServer, ToolOwner } from "@/types";
import AgentModel from "./agent";
import AppModel from "./app";
import McpServerModel from "./mcp-server";

// === Public API ===

class PlaywrightRuntimeModel {
  static async isManagedCatalog(catalogId: string): Promise<boolean> {
    if (catalogId === PLAYWRIGHT_MCP_CATALOG_ID) return true;
    const [catalog] = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(schema.internalMcpCatalogTable.id, catalogId),
          eq(
            schema.internalMcpCatalogTable.parentCatalogItemId,
            PLAYWRIGHT_MCP_CATALOG_ID,
          ),
        ),
      )
      .limit(1);
    return !!catalog;
  }

  /**
   * Ensure exactly one active, system-owned Playwright runtime exists for the
   * Default environment and for every explicit Environment. Safe to run from
   * every backend replica: stable UUIDs make concurrent reconciliation
   * idempotent.
   */
  static async reconcileAll(): Promise<McpServer[]> {
    const rootCatalog = await PlaywrightRuntimeModel.findRootCatalog();
    if (!rootCatalog) return [];

    const environments = await db.select().from(schema.environmentsTable);

    await withDbTransaction(async (tx) => {
      await PlaywrightRuntimeModel.ensureServer({
        catalogId: rootCatalog.id,
        environmentId: null,
        tx,
      });

      for (const environment of environments) {
        const catalogId = await PlaywrightRuntimeModel.ensureEnvironmentCatalog(
          {
            environmentId: environment.id,
            organizationId: environment.organizationId,
            rootCatalog,
            tx,
          },
        );
        await PlaywrightRuntimeModel.ensureServer({
          catalogId,
          environmentId: environment.id,
          tx,
        });
      }
    });

    return PlaywrightRuntimeModel.findAllActive();
  }

  /**
   * Tear down pre-managed installs after the K8s runtime has adopted them.
   * Keeping them active until runtime startup lets normal uninstall cleanup
   * remove their existing deployments instead of stranding pods.
   */
  static async retireLegacyInstallations(): Promise<void> {
    const environments = await db
      .select({ id: schema.environmentsTable.id })
      .from(schema.environmentsTable);
    const activeEnvironmentIds = new Set(environments.map(({ id }) => id));
    const activeCatalogIds = new Set(
      environments.map(({ id }) => managedCatalogId(id)),
    );
    const rows = await db
      .select({
        server: schema.mcpServersTable,
        catalogId: schema.internalMcpCatalogTable.id,
        environmentId: schema.internalMcpCatalogTable.environmentId,
      })
      .from(schema.mcpServersTable)
      .innerJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          or(
            eq(schema.internalMcpCatalogTable.id, PLAYWRIGHT_MCP_CATALOG_ID),
            eq(
              schema.internalMcpCatalogTable.parentCatalogItemId,
              PLAYWRIGHT_MCP_CATALOG_ID,
            ),
          ),
          notDeleted(schema.mcpServersTable),
          notDeleted(schema.internalMcpCatalogTable),
        ),
      );

    for (const row of rows) {
      const expectedId = managedServerId(
        row.catalogId === PLAYWRIGHT_MCP_CATALOG_ID ? null : row.environmentId,
      );
      const belongsToRemovedEnvironment =
        row.catalogId !== PLAYWRIGHT_MCP_CATALOG_ID &&
        (!row.environmentId || !activeEnvironmentIds.has(row.environmentId));
      if (row.server.id !== expectedId || belongsToRemovedEnvironment) {
        await McpServerModel.delete(row.server.id);
        await db
          .delete(schema.mcpServerUsersTable)
          .where(eq(schema.mcpServerUsersTable.mcpServerId, row.server.id));
      }
    }

    const childCatalogs = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(
            schema.internalMcpCatalogTable.parentCatalogItemId,
            PLAYWRIGHT_MCP_CATALOG_ID,
          ),
          notDeleted(schema.internalMcpCatalogTable),
        ),
      );
    const staleCatalogIds = childCatalogs
      .map(({ id }) => id)
      .filter((id) => !activeCatalogIds.has(id));
    if (staleCatalogIds.length > 0) {
      await db
        .update(schema.internalMcpCatalogTable)
        .set({ deletedAt: new Date() })
        .where(inArray(schema.internalMcpCatalogTable.id, staleCatalogIds));
    }
  }

  static async ensureForEnvironment(params: {
    environmentId: string;
    organizationId: string;
  }): Promise<McpServer | null> {
    const rootCatalog = await PlaywrightRuntimeModel.findRootCatalog();
    if (!rootCatalog) return null;

    return withDbTransaction(async (tx) => {
      const catalogId = await PlaywrightRuntimeModel.ensureEnvironmentCatalog({
        ...params,
        rootCatalog,
        tx,
      });
      return PlaywrightRuntimeModel.ensureServer({
        catalogId,
        environmentId: params.environmentId,
        tx,
      });
    });
  }

  static async findForOwner(owner: ToolOwner): Promise<McpServer | null> {
    const environmentId =
      owner.type === "agent"
        ? await AgentModel.findEnvironmentId(owner.id)
        : ((await AppModel.findById(owner.id))?.environmentId ?? null);
    return PlaywrightRuntimeModel.findForEnvironment(environmentId);
  }

  static async findForAgent(agentId: string): Promise<McpServer | null> {
    const environmentId = await AgentModel.findEnvironmentId(agentId);
    return PlaywrightRuntimeModel.findForEnvironment(environmentId);
  }

  static async findForEnvironment(
    environmentId: string | null,
  ): Promise<McpServer | null> {
    const id = managedServerId(environmentId);
    const [server] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(
        and(
          eq(schema.mcpServersTable.id, id),
          notDeleted(schema.mcpServersTable),
        ),
      )
      .limit(1);
    return server ?? null;
  }

  static async findCatalogForEnvironment(environmentId: string): Promise<{
    id: string;
  } | null> {
    const [catalog] = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(
            schema.internalMcpCatalogTable.id,
            managedCatalogId(environmentId),
          ),
          eq(
            schema.internalMcpCatalogTable.parentCatalogItemId,
            PLAYWRIGHT_MCP_CATALOG_ID,
          ),
          notDeleted(schema.internalMcpCatalogTable),
        ),
      )
      .limit(1);
    return catalog ?? null;
  }

  // === Internal helpers ===

  private static async findRootCatalog() {
    const [catalog] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(schema.internalMcpCatalogTable.id, PLAYWRIGHT_MCP_CATALOG_ID),
          isNull(schema.internalMcpCatalogTable.parentCatalogItemId),
          notDeleted(schema.internalMcpCatalogTable),
        ),
      )
      .limit(1);
    return catalog ?? null;
  }

  private static async findAllActive(): Promise<McpServer[]> {
    const environments = await db
      .select({ id: schema.environmentsTable.id })
      .from(schema.environmentsTable);
    return db
      .select()
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(
            schema.mcpServersTable.id,
            [managedServerId(null)].concat(
              environments.map(({ id }) => managedServerId(id)),
            ),
          ),
          notDeleted(schema.mcpServersTable),
        ),
      );
  }

  private static async ensureEnvironmentCatalog(params: {
    environmentId: string;
    organizationId: string;
    rootCatalog: typeof schema.internalMcpCatalogTable.$inferSelect;
    tx: Transaction;
  }): Promise<string> {
    const { environmentId, organizationId, rootCatalog, tx } = params;
    const id = managedCatalogId(environmentId);
    await tx
      .insert(schema.internalMcpCatalogTable)
      .values({
        ...rootCatalog,
        id,
        name: `${PLAYWRIGHT_MCP_SERVER_NAME}-${environmentId}`,
        organizationId,
        parentCatalogItemId: PLAYWRIGHT_MCP_CATALOG_ID,
        childName: environmentId,
        environmentId,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: schema.internalMcpCatalogTable.id,
        set: {
          localConfig: rootCatalog.localConfig,
          environmentId,
          organizationId,
          deletedAt: null,
          updatedAt: new Date(),
        },
      });
    return id;
  }

  private static async ensureServer(params: {
    catalogId: string;
    environmentId: string | null;
    tx: Transaction;
  }): Promise<McpServer> {
    const { catalogId, environmentId, tx } = params;
    const id = managedServerId(environmentId);
    const name = environmentId
      ? `${PLAYWRIGHT_MCP_SERVER_NAME}-${environmentId}`
      : PLAYWRIGHT_MCP_SERVER_NAME;
    const [server] = await tx
      .insert(schema.mcpServersTable)
      .values({
        id,
        name,
        deploymentName: constructFrozenMcpDeploymentName(name, id),
        catalogId,
        serverType: "local",
        scope: "org",
        ownerId: null,
        teamId: null,
        localInstallationStatus: "idle",
      })
      .onConflictDoUpdate({
        target: schema.mcpServersTable.id,
        set: {
          catalogId,
          scope: "org",
          ownerId: null,
          teamId: null,
          deletedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return server;
  }
}

export default PlaywrightRuntimeModel;

function deterministicUuid(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function managedCatalogId(environmentId: string): string {
  return deterministicUuid(`archestra:playwright:catalog:${environmentId}`);
}

function managedServerId(environmentId: string | null): string {
  return deterministicUuid(
    `archestra:playwright:server:${environmentId ?? "default"}`,
  );
}
