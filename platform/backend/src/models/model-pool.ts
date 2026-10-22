import { TimeInMs } from "@archestra/shared";
import { and, asc, eq, getTableColumns, inArray } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema, type Transaction } from "@/database";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type { ModelPool, ModelPoolInput, ModelPoolMember } from "@/types";

/** Model pools and their members (provider keys, each with its own model id). */
class ModelPoolModel {
  static async list(organizationId: string): Promise<ModelPool[]> {
    const pools = await db
      .select()
      .from(schema.modelPoolsTable)
      .where(eq(schema.modelPoolsTable.organizationId, organizationId))
      .orderBy(asc(schema.modelPoolsTable.name));
    return ModelPoolModel.withMembers(pools);
  }

  static async findById(params: {
    organizationId: string;
    id: string;
  }): Promise<ModelPool | null> {
    const [pool] = await db
      .select()
      .from(schema.modelPoolsTable)
      .where(
        and(
          eq(schema.modelPoolsTable.id, params.id),
          eq(schema.modelPoolsTable.organizationId, params.organizationId),
        ),
      );
    if (!pool) return null;
    const [withMembers] = await ModelPoolModel.withMembers([pool]);
    return withMembers;
  }

  /** Snapshot for audit logs: the pool with its members. */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    return ModelPoolModel.findById({ organizationId, id });
  }

  /**
   * The pool clients reach by asking for `name`, with its enabled members.
   * Null when no pool has that name, which leaves the request as it is.
   *
   * The proxy asks this on every request, so answers (misses included) are
   * kept in a process-local cache. Writes in this process clear it at once;
   * other pods converge within the TTL.
   */
  static async findByName(params: {
    organizationId: string;
    name: string;
  }): Promise<ModelPool | null> {
    const key = `${params.organizationId}:${params.name}`;
    const cached = byNameCache.get(key);
    if (cached) return cached.pool;
    const pool = await ModelPoolModel.loadByName(params);
    byNameCache.set(key, { pool });
    return pool;
  }

  private static async loadByName(params: {
    organizationId: string;
    name: string;
  }): Promise<ModelPool | null> {
    const [pool] = await db
      .select()
      .from(schema.modelPoolsTable)
      .where(
        and(
          eq(schema.modelPoolsTable.organizationId, params.organizationId),
          eq(schema.modelPoolsTable.name, params.name),
        ),
      );
    if (!pool) return null;
    const [withMembers] = await ModelPoolModel.withMembers([pool], {
      enabledOnly: true,
    });
    return withMembers;
  }

  /** The id of the pool that already has this name, if any. */
  static async findIdByName(params: {
    organizationId: string;
    name: string;
  }): Promise<string | null> {
    const [pool] = await db
      .select({ id: schema.modelPoolsTable.id })
      .from(schema.modelPoolsTable)
      .where(
        and(
          eq(schema.modelPoolsTable.organizationId, params.organizationId),
          eq(schema.modelPoolsTable.name, params.name),
        ),
      );
    return pool?.id ?? null;
  }

  static async create(params: {
    organizationId: string;
    input: ModelPoolInput;
  }): Promise<ModelPool> {
    const { members, virtualApiKeyIds, ...fields } = params.input;
    const id = await db.transaction(async (tx) => {
      const [pool] = await tx
        .insert(schema.modelPoolsTable)
        .values({ ...fields, organizationId: params.organizationId })
        .returning({ id: schema.modelPoolsTable.id });
      await tx
        .insert(schema.modelPoolMembersTable)
        .values(members.map((member) => ({ ...member, poolId: pool.id })));
      await insertVirtualApiKeys(tx, pool.id, virtualApiKeyIds);
      return pool.id;
    });
    forgetOrganization(params.organizationId);
    return (await ModelPoolModel.findById({
      organizationId: params.organizationId,
      id,
    })) as ModelPool;
  }

  /** Replaces the pool's fields, its whole member list and its virtual keys. */
  static async update(params: {
    organizationId: string;
    id: string;
    input: ModelPoolInput;
  }): Promise<ModelPool | null> {
    const { members, virtualApiKeyIds, ...fields } = params.input;
    const updated = await db.transaction(async (tx) => {
      const [pool] = await tx
        .update(schema.modelPoolsTable)
        .set(fields)
        .where(
          and(
            eq(schema.modelPoolsTable.id, params.id),
            eq(schema.modelPoolsTable.organizationId, params.organizationId),
          ),
        )
        .returning({ id: schema.modelPoolsTable.id });
      if (!pool) return false;
      await tx
        .delete(schema.modelPoolMembersTable)
        .where(eq(schema.modelPoolMembersTable.poolId, pool.id));
      await tx
        .insert(schema.modelPoolMembersTable)
        .values(members.map((member) => ({ ...member, poolId: pool.id })));
      await tx
        .delete(schema.modelPoolVirtualApiKeysTable)
        .where(eq(schema.modelPoolVirtualApiKeysTable.poolId, pool.id));
      await insertVirtualApiKeys(tx, pool.id, virtualApiKeyIds);
      return true;
    });
    forgetOrganization(params.organizationId);
    return updated ? ModelPoolModel.findById(params) : null;
  }

  static async delete(params: {
    organizationId: string;
    id: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.modelPoolsTable)
      .where(
        and(
          eq(schema.modelPoolsTable.id, params.id),
          eq(schema.modelPoolsTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.modelPoolsTable.id });
    forgetOrganization(params.organizationId);
    return deleted.length > 0;
  }

  private static async withMembers(
    pools: Array<typeof schema.modelPoolsTable.$inferSelect>,
    options: { enabledOnly?: boolean } = {},
  ): Promise<ModelPool[]> {
    if (pools.length === 0) return [];
    const members = await db
      .select({
        ...getTableColumns(schema.modelPoolMembersTable),
        providerApiKeyName: schema.llmProviderApiKeysTable.name,
        provider: schema.llmProviderApiKeysTable.provider,
      })
      .from(schema.modelPoolMembersTable)
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.llmProviderApiKeysTable.id,
          schema.modelPoolMembersTable.providerApiKeyId,
        ),
      )
      .where(
        and(
          inArray(
            schema.modelPoolMembersTable.poolId,
            pools.map((pool) => pool.id),
          ),
          options.enabledOnly
            ? eq(schema.modelPoolMembersTable.enabled, true)
            : undefined,
        ),
      )
      .orderBy(
        asc(schema.modelPoolMembersTable.priority),
        asc(schema.modelPoolMembersTable.createdAt),
      );
    const byPool = new Map<string, ModelPoolMember[]>();
    for (const member of members) {
      const list = byPool.get(member.poolId) ?? [];
      list.push(member);
      byPool.set(member.poolId, list);
    }
    const grants = await db
      .select()
      .from(schema.modelPoolVirtualApiKeysTable)
      .where(
        inArray(
          schema.modelPoolVirtualApiKeysTable.poolId,
          pools.map((pool) => pool.id),
        ),
      );
    const keysByPool = new Map<string, string[]>();
    for (const grant of grants) {
      const list = keysByPool.get(grant.poolId) ?? [];
      list.push(grant.virtualApiKeyId);
      keysByPool.set(grant.poolId, list);
    }
    return pools.map((pool) => ({
      ...pool,
      members: byPool.get(pool.id) ?? [],
      virtualApiKeyIds: keysByPool.get(pool.id) ?? [],
    }));
  }
}

const byNameCache = registerProcessLocalCache(
  new LRUCacheManager<{ pool: ModelPool | null }>({
    maxSize: 5_000,
    defaultTtl: 30 * TimeInMs.Second,
  }),
);

function forgetOrganization(organizationId: string): void {
  byNameCache.deleteByPrefix(`${organizationId}:`);
}

async function insertVirtualApiKeys(
  tx: Transaction,
  poolId: string,
  virtualApiKeyIds: string[],
): Promise<void> {
  if (virtualApiKeyIds.length === 0) return;
  await tx.insert(schema.modelPoolVirtualApiKeysTable).values(
    [...new Set(virtualApiKeyIds)].map((virtualApiKeyId) => ({
      poolId,
      virtualApiKeyId,
    })),
  );
}

export default ModelPoolModel;
