import type { SupportedProvider } from "@archestra/shared";
import { and, asc, eq, getTableColumns, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ModelPool, ModelPoolInput, ModelPoolMember } from "@/types";

/** Model pools and their members (provider keys that serve the pool's model). */
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
   * The pool that serves `modelId` on `provider` when `providerApiKeyId` is
   * one of its enabled members, with its enabled members. Null when the key
   * is in no such pool, which leaves the request on that key alone.
   */
  static async findForMemberKey(params: {
    organizationId: string;
    provider: SupportedProvider;
    modelId: string;
    providerApiKeyId: string;
  }): Promise<ModelPool | null> {
    const [pool] = await db
      .select({ pool: schema.modelPoolsTable })
      .from(schema.modelPoolsTable)
      .innerJoin(
        schema.modelPoolMembersTable,
        eq(schema.modelPoolMembersTable.poolId, schema.modelPoolsTable.id),
      )
      .where(
        and(
          eq(schema.modelPoolsTable.organizationId, params.organizationId),
          eq(schema.modelPoolsTable.provider, params.provider),
          eq(schema.modelPoolsTable.modelId, params.modelId),
          eq(
            schema.modelPoolMembersTable.providerApiKeyId,
            params.providerApiKeyId,
          ),
          eq(schema.modelPoolMembersTable.enabled, true),
        ),
      );
    if (!pool) return null;
    const [withMembers] = await ModelPoolModel.withMembers([pool.pool], {
      enabledOnly: true,
    });
    return withMembers;
  }

  /** The id of the pool that already serves this model, if any. */
  static async findIdByModel(params: {
    organizationId: string;
    provider: SupportedProvider;
    modelId: string;
  }): Promise<string | null> {
    const [pool] = await db
      .select({ id: schema.modelPoolsTable.id })
      .from(schema.modelPoolsTable)
      .where(
        and(
          eq(schema.modelPoolsTable.organizationId, params.organizationId),
          eq(schema.modelPoolsTable.provider, params.provider),
          eq(schema.modelPoolsTable.modelId, params.modelId),
        ),
      );
    return pool?.id ?? null;
  }

  static async create(params: {
    organizationId: string;
    input: ModelPoolInput;
  }): Promise<ModelPool> {
    const { members, ...fields } = params.input;
    const id = await db.transaction(async (tx) => {
      const [pool] = await tx
        .insert(schema.modelPoolsTable)
        .values({ ...fields, organizationId: params.organizationId })
        .returning({ id: schema.modelPoolsTable.id });
      await tx
        .insert(schema.modelPoolMembersTable)
        .values(members.map((member) => ({ ...member, poolId: pool.id })));
      return pool.id;
    });
    return (await ModelPoolModel.findById({
      organizationId: params.organizationId,
      id,
    })) as ModelPool;
  }

  /** Replaces the pool's fields and its whole member list. */
  static async update(params: {
    organizationId: string;
    id: string;
    input: ModelPoolInput;
  }): Promise<ModelPool | null> {
    const { members, ...fields } = params.input;
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
      return true;
    });
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
    return pools.map((pool) => ({
      ...pool,
      members: byPool.get(pool.id) ?? [],
    }));
  }
}

export default ModelPoolModel;
