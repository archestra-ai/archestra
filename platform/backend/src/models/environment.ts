import type { ResourcePermissionGrant } from "@archestra/shared";
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type {
  EnvironmentRow,
  LabelWithDetails,
  NetworkPolicy,
  TrustedImageRegistries,
} from "@/types";
import { EnvironmentLabelModel } from "./entity-labels";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

// === Public API ===

/** How many things of each kind still use an environment. */
interface EnvironmentUses {
  catalogItems: number;
  agents: number;
  workspaces: number;
}

/**
 * How long an operation's record of writing to an environment's cluster
 * counts. Every such operation ends well within it; an older record was left
 * by a process that stopped before it could remove it.
 */
export const ENVIRONMENT_CLUSTER_WRITE_LIFETIME_MS = 15 * 60 * 1000;

interface EnvironmentWithAssignedCount {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  namespace: string | null;
  networkPolicy: NetworkPolicy | null;
  validationRegex: string | null;
  trustedImageRegistries: TrustedImageRegistries | null;
  kubeconfigServer: string | null;
  agentRuntimePlatformBaseUrl: string | null;
  deletingAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  assignedCatalogCount: number;
  labels: LabelWithDetails[];
}

class EnvironmentModel {
  /** Bounded ownership evidence for engines created before runtime owner labels. */
  static async findHistoricalNamespaces(engineIds: string[]) {
    if (engineIds.length === 0) return [];
    return db
      .selectDistinct({
        id: schema.auditLogsTable.resourceId,
        beforeNamespace: sql<
          string | null
        >`${schema.auditLogsTable.before}->>'namespace'`,
        afterNamespace: sql<
          string | null
        >`${schema.auditLogsTable.after}->>'namespace'`,
        hasBeforeNamespace: sql<boolean>`${schema.auditLogsTable.before} ? 'namespace'`,
        hasAfterNamespace: sql<boolean>`${schema.auditLogsTable.after} ? 'namespace'`,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.resourceType, "environment"),
          eq(schema.auditLogsTable.outcome, "success"),
          inArray(schema.auditLogsTable.action, [
            "environment.created",
            "environment.updated",
            "environment.deleted",
          ]),
          inArray(schema.auditLogsTable.resourceId, engineIds),
        ),
      )
      .limit(1000);
  }

  /** Every environment across all organizations (control-plane reconcile sweep). */
  static async listAll(): Promise<EnvironmentRow[]> {
    return db.select().from(schema.environmentsTable);
  }

  /**
   * The kubeconfig version of every environment bound to a cluster of its
   * own, for replicas to notice a credential rotated elsewhere.
   */
  static async listKubeconfigVersions(): Promise<
    Pick<
      EnvironmentRow,
      | "id"
      | "kubeconfigSecretId"
      | "kubeconfigServer"
      | "kubeconfigVersion"
      | "deletingAt"
    >[]
  > {
    return db
      .select({
        id: schema.environmentsTable.id,
        kubeconfigSecretId: schema.environmentsTable.kubeconfigSecretId,
        kubeconfigServer: schema.environmentsTable.kubeconfigServer,
        kubeconfigVersion: schema.environmentsTable.kubeconfigVersion,
        deletingAt: schema.environmentsTable.deletingAt,
      })
      .from(schema.environmentsTable)
      .where(isNotNull(schema.environmentsTable.kubeconfigSecretId));
  }

  /**
   * The environment, of any organization, that deploys through a kubeconfig
   * into this namespace of the cluster at `server`; null when none does. A
   * namespace of such a cluster belongs to one environment.
   */
  static async findByClusterNamespace(params: {
    server: string;
    namespace: string;
  }): Promise<EnvironmentRow | null> {
    const [row] = await db
      .select()
      .from(schema.environmentsTable)
      .where(
        and(
          eq(schema.environmentsTable.kubeconfigServer, params.server),
          eq(schema.environmentsTable.namespace, params.namespace),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Environments bound to a cluster of their own. */
  static async listBoundToCluster(): Promise<EnvironmentRow[]> {
    return db
      .select()
      .from(schema.environmentsTable)
      .where(isNotNull(schema.environmentsTable.kubeconfigSecretId));
  }

  static async listForOrganization(
    organizationId: string,
    labels?: Record<string, string[]>,
  ): Promise<EnvironmentWithAssignedCount[]> {
    const labelFilteredIds = labels
      ? await EnvironmentLabelModel.getIdsMatchingLabels(labels)
      : null;
    if (labelFilteredIds?.length === 0) {
      return [];
    }

    const rows = await db
      .select({
        id: schema.environmentsTable.id,
        organizationId: schema.environmentsTable.organizationId,
        name: schema.environmentsTable.name,
        description: schema.environmentsTable.description,
        namespace: schema.environmentsTable.namespace,
        networkPolicy: schema.environmentsTable.networkPolicy,
        validationRegex: schema.environmentsTable.validationRegex,
        trustedImageRegistries: schema.environmentsTable.trustedImageRegistries,
        kubeconfigServer: schema.environmentsTable.kubeconfigServer,
        agentRuntimePlatformBaseUrl:
          schema.environmentsTable.agentRuntimePlatformBaseUrl,
        deletingAt: schema.environmentsTable.deletingAt,
        sortOrder: schema.environmentsTable.sortOrder,
        createdAt: schema.environmentsTable.createdAt,
        updatedAt: schema.environmentsTable.updatedAt,
        assignedCatalogCount: count(schema.internalMcpCatalogTable.id),
      })
      .from(schema.environmentsTable)
      .leftJoin(
        schema.internalMcpCatalogTable,
        // Soft-deleted catalogs must not inflate the count; keep the predicate in
        // the JOIN (not WHERE) so an environment with only deleted catalogs still
        // lists with a count of 0.
        and(
          eq(
            schema.internalMcpCatalogTable.environmentId,
            schema.environmentsTable.id,
          ),
          notDeleted(schema.internalMcpCatalogTable),
          isNull(schema.internalMcpCatalogTable.parentCatalogItemId),
        ),
      )
      .where(
        and(
          eq(schema.environmentsTable.organizationId, organizationId),
          ...(labelFilteredIds
            ? [inArray(schema.environmentsTable.id, labelFilteredIds)]
            : []),
        ),
      )
      .groupBy(schema.environmentsTable.id)
      .orderBy(
        asc(schema.environmentsTable.sortOrder),
        asc(schema.environmentsTable.createdAt),
      );

    const labelsById = await EnvironmentLabelModel.getLabelsForMany(
      rows.map((row) => row.id),
    );

    return rows.map((row) => ({
      ...row,
      labels: labelsById.get(row.id) ?? [],
    }));
  }

  static async findById(
    id: string,
  ): Promise<typeof schema.environmentsTable.$inferSelect | null> {
    const [row] = await db
      .select()
      .from(schema.environmentsTable)
      .where(eq(schema.environmentsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  static async findByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<typeof schema.environmentsTable.$inferSelect | null> {
    const [row] = await db
      .select()
      .from(schema.environmentsTable)
      .where(
        and(
          eq(schema.environmentsTable.id, id),
          eq(schema.environmentsTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const environment = await EnvironmentModel.findByIdForOrganization(
      id,
      organizationId,
    );
    if (!environment) return null;
    // The secret's id stays out of the audit trail. The version stays in, so
    // a credential rotation shows up as a change.
    const { kubeconfigSecretId: _kubeconfigSecretId, ...snapshot } =
      environment;
    return {
      ...snapshot,
      labels: await EnvironmentLabelModel.getLabelsFor(id),
    };
  }

  static async create(params: {
    /** A fixed id for a system-seeded environment; random otherwise. */
    id?: string;
    organizationId: string;
    name: string;
    description?: string | null;
    namespace?: string | null;
    networkPolicy?: NetworkPolicy | null;
    validationRegex?: string | null;
    trustedImageRegistries?: TrustedImageRegistries | null;
    /** The stored kubeconfig of the cluster to deploy into, and its API server. */
    kubeconfig?: { secretId: string; server: string } | null;
    agentRuntimePlatformBaseUrl?: string | null;
    /** The creator, who gets full access. */
    authorId?: string | null;
    /** Who else may use it; omitted opens it to the whole organization. */
    initialPermissionGrants?: ResourcePermissionGrant[];
  }): Promise<typeof schema.environmentsTable.$inferSelect> {
    const {
      organizationId,
      name,
      description,
      namespace,
      networkPolicy,
      validationRegex,
      trustedImageRegistries,
    } = params;
    const sortOrder = await EnvironmentModel.nextSortOrder(organizationId);
    return withDbTransaction(async (tx) => {
      const [row] = await tx
        .insert(schema.environmentsTable)
        .values({
          ...(params.id ? { id: params.id } : {}),
          organizationId,
          name,
          description: description ?? null,
          namespace: namespace ?? null,
          networkPolicy: networkPolicy ?? null,
          validationRegex: validationRegex ?? null,
          trustedImageRegistries: trustedImageRegistries ?? null,
          kubeconfigSecretId: params.kubeconfig?.secretId ?? null,
          kubeconfigServer: params.kubeconfig?.server ?? null,
          agentRuntimePlatformBaseUrl:
            params.agentRuntimePlatformBaseUrl ?? null,
          sortOrder,
        })
        .returning();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // A new environment is open to anyone who can create what is deployed
      // into it, as environments always were. Its Permissions tab narrows it.
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId,
        resource: "environment",
        scope: row.id,
        authorId: params.authorId ?? null,
        grants: params.initialPermissionGrants,
        publishToOrganization: params.initialPermissionGrants === undefined,
      });
      // SPDX-SnippetEnd
      return row;
    });
  }

  static async update(params: {
    id: string;
    organizationId: string;
    name?: string;
    description?: string | null;
    namespace?: string | null;
    networkPolicy?: NetworkPolicy | null;
    validationRegex?: string | null;
    trustedImageRegistries?: TrustedImageRegistries | null;
    agentRuntimePlatformBaseUrl?: string | null;
    /**
     * The secret holding a rotated credential for the environment's cluster.
     * It replaces the current one and bumps the version in the same write, so
     * no reader sees a version that does not match the secret it names.
     */
    rotatedKubeconfigSecretId?: string;
    /**
     * With a rotation: the secret the caller saw the environment use. The
     * write applies only while it is still the one in use, so of two
     * concurrent rotations one wins and the other changes nothing.
     */
    replacedKubeconfigSecretId?: string;
  }): Promise<typeof schema.environmentsTable.$inferSelect | null> {
    const {
      id,
      organizationId,
      name,
      description,
      namespace,
      networkPolicy,
      validationRegex,
      trustedImageRegistries,
      agentRuntimePlatformBaseUrl,
    } = params;
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (namespace !== undefined) patch.namespace = namespace;
    if (networkPolicy !== undefined) patch.networkPolicy = networkPolicy;
    if (validationRegex !== undefined) patch.validationRegex = validationRegex;
    if (trustedImageRegistries !== undefined)
      patch.trustedImageRegistries = trustedImageRegistries;
    if (agentRuntimePlatformBaseUrl !== undefined)
      patch.agentRuntimePlatformBaseUrl = agentRuntimePlatformBaseUrl;
    if (params.rotatedKubeconfigSecretId) {
      patch.kubeconfigSecretId = params.rotatedKubeconfigSecretId;
      patch.kubeconfigVersion = sql`${schema.environmentsTable.kubeconfigVersion} + 1`;
    }

    // Labels are updated separately; a labels-only request has no row fields.
    if (Object.keys(patch).length === 0) {
      return EnvironmentModel.findByIdForOrganization(id, organizationId);
    }

    // An environment that is being deleted does not change: the delete has
    // already read what it will remove.
    const [row] = await db
      .update(schema.environmentsTable)
      .set(patch)
      .where(
        and(
          eq(schema.environmentsTable.id, id),
          eq(schema.environmentsTable.organizationId, organizationId),
          isNull(schema.environmentsTable.deletingAt),
          params.replacedKubeconfigSecretId
            ? eq(
                schema.environmentsTable.kubeconfigSecretId,
                params.replacedKubeconfigSecretId,
              )
            : undefined,
        ),
      )
      .returning();
    return row ?? null;
  }

  static async countAssignedCatalogItems(
    environmentId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ count: count(schema.internalMcpCatalogTable.id) })
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(schema.internalMcpCatalogTable.environmentId, environmentId),
          notDeleted(schema.internalMcpCatalogTable),
          isNull(schema.internalMcpCatalogTable.parentCatalogItemId),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Count top-level catalog items with no environment assigned — these
   * implicitly belong to the org's default environment. Mirrors what's counted
   * per real environment: built-in catalogs (e.g. the Archestra tools) and
   * preset children are excluded. Catalog items can carry a null
   * organization_id (they're org-scoped via team membership), so we include
   * those alongside the org's own items.
   */
  static async countDefaultAssigned(organizationId: string): Promise<number> {
    const [row] = await db
      .select({ count: count(schema.internalMcpCatalogTable.id) })
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          isNull(schema.internalMcpCatalogTable.environmentId),
          isNull(schema.internalMcpCatalogTable.parentCatalogItemId),
          ne(schema.internalMcpCatalogTable.serverType, "builtin"),
          notDeleted(schema.internalMcpCatalogTable),
          or(
            eq(schema.internalMcpCatalogTable.organizationId, organizationId),
            isNull(schema.internalMcpCatalogTable.organizationId),
          ),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * What still uses an environment, as far as the database knows: catalog
   * items assigned to it, agents bound to it, and Agent Runtime workspaces
   * placed in its own cluster.
   */
  static async countUses(
    id: string,
    tx: Transaction | typeof db = db,
  ): Promise<EnvironmentUses> {
    const [[catalogItems], [agents], [workspaces]] = await Promise.all([
      tx
        .select({ count: count(schema.internalMcpCatalogTable.id) })
        .from(schema.internalMcpCatalogTable)
        .where(
          and(
            eq(schema.internalMcpCatalogTable.environmentId, id),
            notDeleted(schema.internalMcpCatalogTable),
            isNull(schema.internalMcpCatalogTable.parentCatalogItemId),
          ),
        ),
      tx
        .select({ count: count(schema.agentsTable.id) })
        .from(schema.agentsTable)
        .where(
          and(
            eq(schema.agentsTable.environmentId, id),
            notDeleted(schema.agentsTable),
          ),
        ),
      // A workspace in an environment's own cluster records the environment
      // in its scope, wherever its agent is bound now.
      tx
        .select({ count: count(schema.agentWorkspacesTable.id) })
        .from(schema.agentWorkspacesTable)
        .where(
          and(
            eq(schema.agentWorkspacesTable.backend, "kubernetes"),
            like(schema.agentWorkspacesTable.runtimeScope, `${id}/%`),
            ne(schema.agentWorkspacesTable.state, "deleted"),
          ),
        ),
    ]);
    return {
      catalogItems: catalogItems?.count ?? 0,
      agents: agents?.count ?? 0,
      workspaces: workspaces?.count ?? 0,
    };
  }

  /**
   * Record that an operation is about to create or change workloads in the
   * cluster of an environment that deploys into a cluster of its own.
   *
   * Resolves to the record's id, to hand to `endClusterWrite` when the
   * operation has ended, or to null when the environment is being deleted or
   * does not exist: the operation must then stop before it has any effect.
   *
   * Taking the record and marking the environment as being deleted lock the
   * same row, so one of them sees the other: a record is never added to a
   * marked environment, and an environment with a recent record is not marked.
   */
  static async beginClusterWrite(
    environmentId: string,
  ): Promise<string | null> {
    return withDbTransaction(async (tx) => {
      const [environment] = await tx
        .select({ deletingAt: schema.environmentsTable.deletingAt })
        .from(schema.environmentsTable)
        .where(eq(schema.environmentsTable.id, environmentId))
        .for("key share");
      if (!environment || environment.deletingAt) return null;
      const [write] = await tx
        .insert(schema.environmentClusterWritesTable)
        .values({ environmentId })
        .returning({ id: schema.environmentClusterWritesTable.id });
      return write.id;
    });
  }

  static async endClusterWrite(writeId: string): Promise<void> {
    await db
      .delete(schema.environmentClusterWritesTable)
      .where(eq(schema.environmentClusterWritesTable.id, writeId));
  }

  /**
   * Begin deleting an environment with its own cluster: unless something
   * still uses it or is still writing to its cluster, mark it as being
   * deleted, deciding and marking under one lock on its row. From the mark
   * on, no operation writes to its cluster (`beginClusterWrite` refuses), so
   * what the cleanup that follows removes cannot come back. An environment
   * already marked is left as is.
   *
   * `blocking` names the uses that stop the mark. A marked outcome carries the
   * environment as it was marked: a marked environment no longer changes, so
   * that is what the cleanup has to remove. Resolves to null when the
   * environment does not exist.
   */
  static async markDeleting(params: {
    id: string;
    organizationId: string;
    blocking: (keyof EnvironmentUses)[];
  }): Promise<
    | { outcome: "marked"; environment: EnvironmentRow }
    | { outcome: "in-use"; uses: EnvironmentUses }
    | { outcome: "busy"; writes: number }
    | null
  > {
    const { id, organizationId } = params;
    return withDbTransaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(schema.environmentsTable)
        .where(
          and(
            eq(schema.environmentsTable.id, id),
            eq(schema.environmentsTable.organizationId, organizationId),
          ),
        )
        .for("update");
      if (!locked) return null;
      if (locked.deletingAt) return { outcome: "marked", environment: locked };
      const uses = await EnvironmentModel.countUses(id, tx);
      if (params.blocking.some((use) => uses[use] > 0)) {
        return { outcome: "in-use", uses };
      }
      const liveSince = new Date(
        Date.now() - ENVIRONMENT_CLUSTER_WRITE_LIFETIME_MS,
      );
      const [writes] = await tx
        .select({ count: count(schema.environmentClusterWritesTable.id) })
        .from(schema.environmentClusterWritesTable)
        .where(
          and(
            eq(schema.environmentClusterWritesTable.environmentId, id),
            gt(schema.environmentClusterWritesTable.createdAt, liveSince),
          ),
        );
      if (writes && writes.count > 0) {
        return { outcome: "busy", writes: writes.count };
      }
      await tx
        .delete(schema.environmentClusterWritesTable)
        .where(
          and(
            eq(schema.environmentClusterWritesTable.environmentId, id),
            lt(schema.environmentClusterWritesTable.createdAt, liveSince),
          ),
        );
      const [marked] = await tx
        .update(schema.environmentsTable)
        .set({ deletingAt: new Date() })
        .where(eq(schema.environmentsTable.id, id))
        .returning();
      return { outcome: "marked", environment: marked };
    });
  }

  /**
   * Finish deleting an environment that was marked and whose cluster was
   * cleaned up, deciding under one lock on its row.
   *
   * An assignment made while it was marked stops the delete: the mark is
   * cleared and the environment is in service again. Otherwise the row is
   * deleted, and the kubeconfig secret it named when it was deleted is
   * returned for removal.
   *
   * Resolves to null when the environment does not exist.
   */
  static async deleteMarked(params: {
    id: string;
    organizationId: string;
    blocking: (keyof EnvironmentUses)[];
  }): Promise<
    | { outcome: "deleted"; kubeconfigSecretId: string | null }
    | { outcome: "restored"; uses: EnvironmentUses }
    | null
  > {
    const { id, organizationId } = params;
    const row = and(
      eq(schema.environmentsTable.id, id),
      eq(schema.environmentsTable.organizationId, organizationId),
    );
    return withDbTransaction(async (tx) => {
      const [locked] = await tx
        .select({ id: schema.environmentsTable.id })
        .from(schema.environmentsTable)
        .where(row)
        .for("update");
      if (!locked) return null;
      const uses = await EnvironmentModel.countUses(id, tx);
      if (params.blocking.some((use) => uses[use] > 0)) {
        await tx
          .update(schema.environmentsTable)
          .set({ deletingAt: null })
          .where(row);
        return { outcome: "restored", uses };
      }
      const [deleted] = await tx
        .delete(schema.environmentsTable)
        .where(row)
        .returning({
          kubeconfigSecretId: schema.environmentsTable.kubeconfigSecretId,
        });
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.deleteForTarget({
        tx,
        resources: ["environment"],
        scope: id,
      });
      // SPDX-SnippetEnd
      return {
        outcome: "deleted",
        kubeconfigSecretId: deleted.kubeconfigSecretId,
      };
    });
  }

  /**
   * Delete an environment unless something still uses it, deciding and
   * deleting under one lock on its row. An assignment to the environment
   * takes the foreign key's lock on the same row, so it either is counted
   * here or fails afterwards on the missing row; it cannot slip in between
   * the count and the delete and be moved to the default environment.
   *
   * `blocking` names the uses that stop the delete. Resolves to the uses
   * found when it was stopped, null when the environment does not exist, and
   * "deleted" otherwise.
   */
  static async deleteUnused(params: {
    id: string;
    organizationId: string;
    blocking: (keyof EnvironmentUses)[];
  }): Promise<"deleted" | EnvironmentUses | null> {
    const { id, organizationId } = params;
    return withDbTransaction(async (tx) => {
      const [locked] = await tx
        .select({ id: schema.environmentsTable.id })
        .from(schema.environmentsTable)
        .where(
          and(
            eq(schema.environmentsTable.id, id),
            eq(schema.environmentsTable.organizationId, organizationId),
          ),
        )
        .for("update");
      if (!locked) return null;
      const uses = await EnvironmentModel.countUses(id, tx);
      if (params.blocking.some((use) => uses[use] > 0)) return uses;

      const deleted = await tx
        .delete(schema.environmentsTable)
        .where(
          and(
            eq(schema.environmentsTable.id, id),
            eq(schema.environmentsTable.organizationId, organizationId),
          ),
        )
        .returning({ id: schema.environmentsTable.id });
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (deleted.length > 0)
        await ResourcePermissionPolicyModel.deleteForTarget({
          tx,
          resources: ["environment"],
          scope: id,
        });
      // SPDX-SnippetEnd
      return deleted.length > 0 ? "deleted" : null;
    });
  }

  // === Internal helpers ===

  private static async nextSortOrder(organizationId: string): Promise<number> {
    const [row] = await db
      .select({
        max: sql<number | null>`MAX(${schema.environmentsTable.sortOrder})`,
      })
      .from(schema.environmentsTable)
      .where(eq(schema.environmentsTable.organizationId, organizationId));
    return (row?.max ?? -1) + 1;
  }
}

export default EnvironmentModel;
