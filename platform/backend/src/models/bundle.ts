import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { Bundle, CreateBundle, UpdateBundle } from "@/types";

interface CreateBundleParams extends CreateBundle {
  organizationId: string;
}

interface UpdateBundleParams extends UpdateBundle {
  id: string;
  organizationId: string;
}

class BundleModel {
  static async create(params: CreateBundleParams): Promise<Bundle> {
    const { skillIds, pluginIds, localMcpServers, ...values } = params;
    return withDbTransaction(async (tx) => {
      const [created] = await tx
        .insert(schema.bundlesTable)
        .values({
          ...values,
          localMcpServers: localMcpServers.map((server) => ({
            ...server,
            id: server.id ?? randomUUID(),
          })),
        })
        .returning();
      await replaceResources({
        tx,
        bundleId: created.id,
        skillIds,
        pluginIds,
      });
      return hydrateBundle(created, tx);
    });
  }

  static async findAllByOrganization(
    organizationId: string,
  ): Promise<Bundle[]> {
    const rows = await db
      .select()
      .from(schema.bundlesTable)
      .where(eq(schema.bundlesTable.organizationId, organizationId))
      .orderBy(asc(schema.bundlesTable.name));
    return hydrateBundles(rows);
  }

  static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<Bundle | null> {
    const [row] = await db
      .select()
      .from(schema.bundlesTable)
      .where(
        and(
          eq(schema.bundlesTable.id, params.id),
          eq(schema.bundlesTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row ? hydrateBundle(row) : null;
  }

  static async update(params: UpdateBundleParams): Promise<Bundle | null> {
    const {
      id,
      organizationId,
      skillIds,
      pluginIds,
      localMcpServers,
      ...values
    } = params;
    return withDbTransaction(async (tx) => {
      const [updated] = await tx
        .update(schema.bundlesTable)
        .set({
          ...values,
          ...(localMcpServers
            ? {
                localMcpServers: localMcpServers.map((server) => ({
                  ...server,
                  id: server.id ?? randomUUID(),
                })),
              }
            : {}),
        })
        .where(
          and(
            eq(schema.bundlesTable.id, id),
            eq(schema.bundlesTable.organizationId, organizationId),
          ),
        )
        .returning();
      if (!updated) return null;

      if (skillIds !== undefined || pluginIds !== undefined) {
        const current = await hydrateBundle(updated, tx);
        await replaceResources({
          tx,
          bundleId: id,
          skillIds: skillIds ?? current.skillIds,
          pluginIds: pluginIds ?? current.pluginIds,
        });
      }
      return hydrateBundle(updated, tx);
    });
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const [deleted] = await db
      .delete(schema.bundlesTable)
      .where(
        and(
          eq(schema.bundlesTable.id, params.id),
          eq(schema.bundlesTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.bundlesTable.id });
    return deleted !== undefined;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    return BundleModel.findById({ id, organizationId });
  }
}

export default BundleModel;

async function hydrateBundle(
  row: typeof schema.bundlesTable.$inferSelect,
  tx?: Transaction,
): Promise<Bundle> {
  const [bundle] = await hydrateBundles([row], tx);
  return bundle;
}

async function hydrateBundles(
  rows: (typeof schema.bundlesTable.$inferSelect)[],
  tx?: Transaction,
): Promise<Bundle[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const executor = tx ?? db;
  const [skillRows, pluginRows] = await Promise.all([
    executor
      .select()
      .from(schema.bundleSkillsTable)
      .where(inArray(schema.bundleSkillsTable.bundleId, ids)),
    executor
      .select()
      .from(schema.bundlePluginsTable)
      .where(inArray(schema.bundlePluginsTable.bundleId, ids)),
  ]);

  const skillIdsByBundle = new Map<string, string[]>();
  for (const row of skillRows) {
    const list = skillIdsByBundle.get(row.bundleId) ?? [];
    list.push(row.skillId);
    skillIdsByBundle.set(row.bundleId, list);
  }
  const pluginIdsByBundle = new Map<string, string[]>();
  for (const row of pluginRows) {
    const list = pluginIdsByBundle.get(row.bundleId) ?? [];
    list.push(row.pluginId);
    pluginIdsByBundle.set(row.bundleId, list);
  }

  return rows.map((row) => ({
    ...row,
    skillIds: (skillIdsByBundle.get(row.id) ?? []).sort(),
    pluginIds: (pluginIdsByBundle.get(row.id) ?? []).sort(),
  }));
}

async function replaceResources(params: {
  tx: Transaction;
  bundleId: string;
  skillIds: string[];
  pluginIds: string[];
}): Promise<void> {
  await Promise.all([
    params.tx
      .delete(schema.bundleSkillsTable)
      .where(eq(schema.bundleSkillsTable.bundleId, params.bundleId)),
    params.tx
      .delete(schema.bundlePluginsTable)
      .where(eq(schema.bundlePluginsTable.bundleId, params.bundleId)),
  ]);

  const skillIds = [...new Set(params.skillIds)];
  const pluginIds = [...new Set(params.pluginIds)];
  if (skillIds.length > 0) {
    await params.tx.insert(schema.bundleSkillsTable).values(
      skillIds.map((skillId) => ({
        bundleId: params.bundleId,
        skillId,
      })),
    );
  }
  if (pluginIds.length > 0) {
    await params.tx.insert(schema.bundlePluginsTable).values(
      pluginIds.map((pluginId) => ({
        bundleId: params.bundleId,
        pluginId,
      })),
    );
  }
}
