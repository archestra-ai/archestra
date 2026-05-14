import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ARCHESTRA_TOKEN_PREFIX,
  type PaginationQuery,
  type SupportedProvider,
} from "@shared";
import { and, count, eq, ilike, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { PaginatedResult } from "@/database/utils/pagination";
import { createPaginatedResult } from "@/database/utils/pagination";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  ResourceVisibilityScope,
  SelectVirtualApiKey,
  VirtualApiKeyWithParentInfo,
} from "@/types";
import { escapeLikePattern } from "@/utils/sql-search";

/** Length of random part (32 bytes = 64 hex chars = 256 bits of entropy) */
const TOKEN_RANDOM_LENGTH = 32;

/** Length of token start to store (for display) */
const TOKEN_START_LENGTH = 14;

/** Always use DB storage (not BYOS Vault compatible) */
const FORCE_DB = true;

type TeamInfo = { id: string; name: string };
type ProviderApiKeyInput = {
  provider: SupportedProvider;
  providerApiKeyId: string;
};
type ProviderApiKeyInfo = ProviderApiKeyInput & {
  providerApiKeyName: string;
};
type ProviderApiKeyRoutingInfo = ProviderApiKeyInfo & {
  secretId: string | null;
  baseUrl: string | null;
};

type VirtualApiKeyAccessContext = {
  id: string;
  organizationId: string;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  teamIds: string[];
};

class VirtualApiKeyModel {
  /**
   * Create a new virtual API key.
   * Returns the full token value once at creation (never returned again).
   */
  static async create(params: {
    organizationId?: string;
    name: string;
    expiresAt?: Date | null;
    scope?: ResourceVisibilityScope;
    authorId?: string | null;
    teamIds?: string[];
    providerApiKeys?: ProviderApiKeyInput[];
  }): Promise<{
    virtualKey: SelectVirtualApiKey;
    value: string;
    teams: TeamInfo[];
    authorName: string | null;
    providerApiKeys: ProviderApiKeyInfo[];
  }> {
    const {
      organizationId: providedOrganizationId,
      name,
      expiresAt,
      scope = "org",
      authorId = null,
      teamIds = [],
      providerApiKeys = [],
    } = params;

    const tokenValue = generateToken();
    const tokenStart = getTokenStart(tokenValue);
    const resolvedOrganizationId =
      providedOrganizationId ??
      (await getOrganizationIdForProviderKeys(providerApiKeys));
    if (!resolvedOrganizationId) {
      throw new Error(
        "VirtualApiKeyModel.create requires organizationId or at least one provider API key",
      );
    }

    const secretName = `virtual-api-key-${resolvedOrganizationId}-${Date.now()}`;
    const secret = await secretManager().createSecret(
      { token: tokenValue },
      secretName,
      FORCE_DB,
    );

    const virtualKey = await db.transaction(async (tx) => {
      const [createdVirtualKey] = await tx
        .insert(schema.virtualApiKeysTable)
        .values({
          organizationId: resolvedOrganizationId,
          name,
          secretId: secret.id,
          tokenStart,
          scope,
          authorId,
          expiresAt: expiresAt ?? null,
        })
        .returning();

      await syncVirtualApiKeyTeams({
        tx,
        virtualApiKeyId: createdVirtualKey.id,
        scope,
        teamIds,
      });
      await syncProviderApiKeys({
        tx,
        virtualApiKeyId: createdVirtualKey.id,
        mappings: providerApiKeys,
      });

      return createdVirtualKey;
    });

    logger.info(
      {
        organizationId: resolvedOrganizationId,
        virtualKeyId: virtualKey.id,
        scope,
      },
      "VirtualApiKeyModel.create: virtual key created",
    );

    const { teams, authorName } =
      await VirtualApiKeyModel.getVisibilityMetadata([virtualKey.id]);
    const mappings = await VirtualApiKeyModel.getProviderApiKeys(virtualKey.id);

    return {
      virtualKey,
      value: tokenValue,
      teams: teams.get(virtualKey.id) ?? [],
      authorName: authorName.get(virtualKey.id) ?? null,
      providerApiKeys: mappings,
    };
  }

  /**
   * Update a virtual API key's mutable fields.
   */
  static async update(params: {
    id: string;
    name: string;
    expiresAt?: Date | null;
    scope: ResourceVisibilityScope;
    authorId: string;
    teamIds: string[];
    providerApiKeys: ProviderApiKeyInput[];
  }): Promise<SelectVirtualApiKey | null> {
    const { id, name, expiresAt, scope, authorId, teamIds, providerApiKeys } =
      params;

    const updatedVirtualKey = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.virtualApiKeysTable)
        .set({
          name,
          expiresAt: expiresAt ?? null,
          scope,
          authorId,
        })
        .where(eq(schema.virtualApiKeysTable.id, id))
        .returning();

      if (!updated) {
        return null;
      }

      await syncVirtualApiKeyTeams({
        tx,
        virtualApiKeyId: id,
        scope,
        teamIds,
      });
      await syncProviderApiKeys({
        tx,
        virtualApiKeyId: id,
        mappings: providerApiKeys,
      });

      return updated;
    });

    if (updatedVirtualKey) {
      logger.info(
        { virtualKeyId: id, scope },
        "VirtualApiKeyModel.update: virtual key updated",
      );
    }

    return updatedVirtualKey ?? null;
  }

  /**
   * List visible virtual keys for a provider API key.
   */
  static async findByProviderApiKeyId(
    params:
      | {
          providerApiKeyId: string;
          organizationId: string;
          userId: string;
          userTeamIds: string[];
          isAdmin: boolean;
        }
      | string,
  ): Promise<SelectVirtualApiKey[]> {
    if (typeof params === "string") {
      return db
        .select({
          id: schema.virtualApiKeysTable.id,
          organizationId: schema.virtualApiKeysTable.organizationId,
          name: schema.virtualApiKeysTable.name,
          secretId: schema.virtualApiKeysTable.secretId,
          tokenStart: schema.virtualApiKeysTable.tokenStart,
          scope: schema.virtualApiKeysTable.scope,
          authorId: schema.virtualApiKeysTable.authorId,
          expiresAt: schema.virtualApiKeysTable.expiresAt,
          createdAt: schema.virtualApiKeysTable.createdAt,
          lastUsedAt: schema.virtualApiKeysTable.lastUsedAt,
        })
        .from(schema.virtualApiKeysTable)
        .innerJoin(
          schema.virtualApiKeyProviderApiKeysTable,
          eq(
            schema.virtualApiKeysTable.id,
            schema.virtualApiKeyProviderApiKeysTable.virtualApiKeyId,
          ),
        )
        .where(
          eq(schema.virtualApiKeyProviderApiKeysTable.providerApiKeyId, params),
        )
        .orderBy(schema.virtualApiKeysTable.createdAt);
    }

    const accessibleIds = await VirtualApiKeyModel.getAccessibleIds({
      organizationId: params.organizationId,
      userId: params.userId,
      userTeamIds: params.userTeamIds,
      isAdmin: params.isAdmin,
      providerApiKeyId: params.providerApiKeyId,
    });

    if (accessibleIds.length === 0) {
      return [];
    }

    return db
      .select()
      .from(schema.virtualApiKeysTable)
      .where(inArray(schema.virtualApiKeysTable.id, accessibleIds))
      .orderBy(schema.virtualApiKeysTable.createdAt);
  }

  /**
   * Find a virtual key by ID.
   */
  static async findById(id: string): Promise<SelectVirtualApiKey | null> {
    const [result] = await db
      .select()
      .from(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.id, id))
      .limit(1);

    return result ?? null;
  }

  /**
   * Find access-related metadata for a virtual key.
   */
  static async findAccessContextById(
    id: string,
  ): Promise<VirtualApiKeyAccessContext | null> {
    const [virtualKey] = await db
      .select({
        id: schema.virtualApiKeysTable.id,
        organizationId: schema.virtualApiKeysTable.organizationId,
        scope: schema.virtualApiKeysTable.scope,
        authorId: schema.virtualApiKeysTable.authorId,
      })
      .from(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.id, id))
      .limit(1);

    if (!virtualKey) {
      return null;
    }

    const teamIds = await VirtualApiKeyModel.getTeamIdsForVirtualApiKey(id);

    return {
      ...virtualKey,
      teamIds,
    };
  }

  /**
   * Delete a virtual key and its associated secret.
   */
  static async delete(id: string): Promise<boolean> {
    const virtualKey = await VirtualApiKeyModel.findById(id);
    if (!virtualKey) return false;

    await db
      .delete(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.id, id));

    try {
      await secretManager().deleteSecret(virtualKey.secretId);
    } catch (error) {
      logger.warn(
        {
          virtualKeyId: id,
          secretId: virtualKey.secretId,
          error: String(error),
        },
        "VirtualApiKeyModel.delete: failed to delete secret (orphaned). DB record already removed.",
      );
    }

    logger.info(
      { virtualKeyId: id },
      "VirtualApiKeyModel.delete: virtual key deleted",
    );

    return true;
  }

  /**
   * Count virtual keys for a provider API key (for enforcing max limit).
   */
  static async countByProviderApiKeyId(
    providerApiKeyId: string,
  ): Promise<number> {
    const [result] = await db
      .select({ total: count() })
      .from(schema.virtualApiKeysTable)
      .innerJoin(
        schema.virtualApiKeyProviderApiKeysTable,
        eq(
          schema.virtualApiKeysTable.id,
          schema.virtualApiKeyProviderApiKeysTable.virtualApiKeyId,
        ),
      )
      .where(
        eq(
          schema.virtualApiKeyProviderApiKeysTable.providerApiKeyId,
          providerApiKeyId,
        ),
      );

    return Number(result?.total ?? 0);
  }

  /**
   * Find visible virtual keys for an organization.
   * Supports pagination.
   */
  static async findAllByOrganization(params: {
    organizationId: string;
    pagination: PaginationQuery;
    userId?: string;
    userTeamIds?: string[];
    isAdmin?: boolean;
    search?: string;
    providerApiKeyId?: string;
  }): Promise<PaginatedResult<VirtualApiKeyWithParentInfo>> {
    const {
      organizationId,
      pagination,
      userId = "",
      userTeamIds = [],
      isAdmin = true,
      search,
      providerApiKeyId,
    } = params;

    const accessibleIds = await VirtualApiKeyModel.getAccessibleIds({
      organizationId,
      userId,
      userTeamIds,
      isAdmin,
      providerApiKeyId,
    });

    if ((!isAdmin || providerApiKeyId) && accessibleIds.length === 0) {
      return createPaginatedResult([], 0, pagination);
    }

    const whereConditions = [
      eq(schema.virtualApiKeysTable.organizationId, organizationId),
    ];

    if (!isAdmin || providerApiKeyId) {
      whereConditions.push(
        inArray(schema.virtualApiKeysTable.id, accessibleIds),
      );
    }

    if (search) {
      whereConditions.push(
        ilike(
          schema.virtualApiKeysTable.name,
          `%${escapeLikePattern(search.trim())}%`,
        ),
      );
    }

    const whereClause = and(...whereConditions);

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: schema.virtualApiKeysTable.id,
          organizationId: schema.virtualApiKeysTable.organizationId,
          name: schema.virtualApiKeysTable.name,
          secretId: schema.virtualApiKeysTable.secretId,
          tokenStart: schema.virtualApiKeysTable.tokenStart,
          scope: schema.virtualApiKeysTable.scope,
          authorId: schema.virtualApiKeysTable.authorId,
          expiresAt: schema.virtualApiKeysTable.expiresAt,
          lastUsedAt: schema.virtualApiKeysTable.lastUsedAt,
          createdAt: schema.virtualApiKeysTable.createdAt,
        })
        .from(schema.virtualApiKeysTable)
        .where(whereClause)
        .orderBy(schema.virtualApiKeysTable.createdAt)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.virtualApiKeysTable)
        .where(whereClause),
    ]);

    const rowIds = rows.map((row) => row.id);
    const [metadata, mappings] = await Promise.all([
      VirtualApiKeyModel.getVisibilityMetadata(rowIds),
      VirtualApiKeyModel.getProviderApiKeysForVirtualKeys(rowIds),
    ]);

    const data = rows.map((row) => ({
      ...row,
      teams: metadata.teams.get(row.id) ?? [],
      authorName: metadata.authorName.get(row.id) ?? null,
      providerApiKeys: mappings.get(row.id) ?? [],
    }));

    return createPaginatedResult(data, Number(total), pagination);
  }

  /**
   * Update last used timestamp.
   */
  static async updateLastUsed(id: string): Promise<void> {
    await db
      .update(schema.virtualApiKeysTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.virtualApiKeysTable.id, id));
  }

  /**
   * Validate a virtual API key token value.
   * Returns the virtual key if valid.
   */
  static async validateToken(tokenValue: string): Promise<{
    virtualKey: SelectVirtualApiKey;
  } | null> {
    const tokenStart = getTokenStart(tokenValue);
    const candidates = await db
      .select()
      .from(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.tokenStart, tokenStart));

    for (const virtualKey of candidates) {
      const secret = await secretManager().getSecret(virtualKey.secretId);
      if (!secret) {
        logger.warn(
          {
            virtualKeyId: virtualKey.id,
            secretId: virtualKey.secretId,
          },
          "Virtual API key references a missing secret",
        );
        continue;
      }

      const storedToken = (secret.secret as { token?: string })?.token;
      if (storedToken && constantTimeEqual(storedToken, tokenValue)) {
        VirtualApiKeyModel.updateLastUsed(virtualKey.id).catch((error) => {
          logger.warn(
            { virtualKeyId: virtualKey.id, error: String(error) },
            "Failed to update virtual key lastUsedAt",
          );
        });

        return { virtualKey };
      }
    }

    return null;
  }

  static async getProviderApiKeysForRouting(
    virtualApiKeyId: string,
  ): Promise<ProviderApiKeyRoutingInfo[]> {
    const rows = await db
      .select({
        provider: schema.virtualApiKeyProviderApiKeysTable.provider,
        providerApiKeyId:
          schema.virtualApiKeyProviderApiKeysTable.providerApiKeyId,
        providerApiKeyName: schema.llmProviderApiKeysTable.name,
        secretId: schema.llmProviderApiKeysTable.secretId,
        baseUrl: schema.llmProviderApiKeysTable.baseUrl,
      })
      .from(schema.virtualApiKeyProviderApiKeysTable)
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.virtualApiKeyProviderApiKeysTable.providerApiKeyId,
          schema.llmProviderApiKeysTable.id,
        ),
      )
      .where(
        eq(
          schema.virtualApiKeyProviderApiKeysTable.virtualApiKeyId,
          virtualApiKeyId,
        ),
      )
      .orderBy(schema.virtualApiKeyProviderApiKeysTable.provider);

    return rows;
  }

  static async getProviderApiKeys(
    virtualApiKeyId: string,
  ): Promise<ProviderApiKeyInfo[]> {
    const result = await VirtualApiKeyModel.getProviderApiKeysForVirtualKeys([
      virtualApiKeyId,
    ]);
    return result.get(virtualApiKeyId) ?? [];
  }

  static async getProviderApiKeysForVirtualKeys(
    virtualApiKeyIds: string[],
  ): Promise<Map<string, ProviderApiKeyInfo[]>> {
    const result = new Map<string, ProviderApiKeyInfo[]>();
    if (virtualApiKeyIds.length === 0) {
      return result;
    }

    const rows = await db
      .select({
        virtualApiKeyId:
          schema.virtualApiKeyProviderApiKeysTable.virtualApiKeyId,
        provider: schema.virtualApiKeyProviderApiKeysTable.provider,
        providerApiKeyId:
          schema.virtualApiKeyProviderApiKeysTable.providerApiKeyId,
        providerApiKeyName: schema.llmProviderApiKeysTable.name,
      })
      .from(schema.virtualApiKeyProviderApiKeysTable)
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.virtualApiKeyProviderApiKeysTable.providerApiKeyId,
          schema.llmProviderApiKeysTable.id,
        ),
      )
      .where(
        inArray(
          schema.virtualApiKeyProviderApiKeysTable.virtualApiKeyId,
          virtualApiKeyIds,
        ),
      )
      .orderBy(schema.virtualApiKeyProviderApiKeysTable.provider);

    for (const row of rows) {
      const existing = result.get(row.virtualApiKeyId) ?? [];
      existing.push({
        provider: row.provider,
        providerApiKeyId: row.providerApiKeyId,
        providerApiKeyName: row.providerApiKeyName,
      });
      result.set(row.virtualApiKeyId, existing);
    }

    return result;
  }

  static async getTeamIdsForVirtualApiKey(
    virtualApiKeyId: string,
  ): Promise<string[]> {
    const rows = await db
      .select({ teamId: schema.virtualApiKeyTeamsTable.teamId })
      .from(schema.virtualApiKeyTeamsTable)
      .where(
        eq(schema.virtualApiKeyTeamsTable.virtualApiKeyId, virtualApiKeyId),
      );

    return rows.map((row) => row.teamId);
  }

  static async getVisibilityForVirtualApiKeyIds(
    virtualApiKeyIds: string[],
  ): Promise<{
    teams: Map<string, TeamInfo[]>;
    authorName: Map<string, string | null>;
  }> {
    return VirtualApiKeyModel.getVisibilityMetadata(virtualApiKeyIds);
  }

  private static async getAccessibleIds(params: {
    organizationId: string | null;
    userId: string;
    userTeamIds: string[];
    isAdmin: boolean;
    providerApiKeyId?: string;
  }): Promise<string[]> {
    const { organizationId, userId, userTeamIds, isAdmin, providerApiKeyId } =
      params;

    if (isAdmin) {
      const conditions = [];
      if (organizationId) {
        conditions.push(
          eq(schema.virtualApiKeysTable.organizationId, organizationId),
        );
      }
      const baseQuery = db
        .select({ id: schema.virtualApiKeysTable.id })
        .from(schema.virtualApiKeysTable);

      const rows = await (providerApiKeyId
        ? baseQuery
            .innerJoin(
              schema.virtualApiKeyProviderApiKeysTable,
              eq(
                schema.virtualApiKeysTable.id,
                schema.virtualApiKeyProviderApiKeysTable.virtualApiKeyId,
              ),
            )
            .where(
              and(
                ...conditions,
                eq(
                  schema.virtualApiKeyProviderApiKeysTable.providerApiKeyId,
                  providerApiKeyId,
                ),
              ),
            )
        : baseQuery.where(
            conditions.length > 0 ? and(...conditions) : undefined,
          ));

      return rows.map((row) => row.id);
    }

    const teamAccessCondition =
      userTeamIds.length > 0
        ? sql`
            SELECT DISTINCT vat.virtual_api_key_id AS id
            FROM virtual_api_key_team vat
            INNER JOIN virtual_api_keys vak ON vat.virtual_api_key_id = vak.id
            WHERE vak.scope = 'team'
              AND vat.team_id IN (${sql.join(
                userTeamIds.map((id) => sql`${id}`),
                sql`, `,
              )})
              ${organizationId ? sql`AND vak.organization_id = ${organizationId}` : sql``}
              ${providerApiKeyId ? sql`AND EXISTS (SELECT 1 FROM virtual_api_key_provider_api_key vakpak WHERE vakpak.virtual_api_key_id = vak.id AND vakpak.provider_api_key_id = ${providerApiKeyId})` : sql``}
          `
        : null;

    const result = await db.execute<{ id: string }>(sql`
      SELECT vak.id
      FROM virtual_api_keys vak
      WHERE vak.scope = 'org'
        ${organizationId ? sql`AND vak.organization_id = ${organizationId}` : sql``}
        ${providerApiKeyId ? sql`AND EXISTS (SELECT 1 FROM virtual_api_key_provider_api_key vakpak WHERE vakpak.virtual_api_key_id = vak.id AND vakpak.provider_api_key_id = ${providerApiKeyId})` : sql``}
      UNION
      SELECT vak.id
      FROM virtual_api_keys vak
      WHERE vak.scope = 'personal'
        AND vak.author_id = ${userId}
        ${organizationId ? sql`AND vak.organization_id = ${organizationId}` : sql``}
        ${providerApiKeyId ? sql`AND EXISTS (SELECT 1 FROM virtual_api_key_provider_api_key vakpak WHERE vakpak.virtual_api_key_id = vak.id AND vakpak.provider_api_key_id = ${providerApiKeyId})` : sql``}
      ${teamAccessCondition ? sql`UNION ${teamAccessCondition}` : sql``}
    `);

    return result.rows.map((row) => row.id);
  }

  private static async getVisibilityMetadata(
    virtualApiKeyIds: string[],
  ): Promise<{
    teams: Map<string, TeamInfo[]>;
    authorName: Map<string, string | null>;
  }> {
    if (virtualApiKeyIds.length === 0) {
      return {
        teams: new Map(),
        authorName: new Map(),
      };
    }

    const [teams, authors] = await Promise.all([
      db
        .select({
          virtualApiKeyId: schema.virtualApiKeyTeamsTable.virtualApiKeyId,
          teamId: schema.virtualApiKeyTeamsTable.teamId,
          teamName: schema.teamsTable.name,
        })
        .from(schema.virtualApiKeyTeamsTable)
        .innerJoin(
          schema.teamsTable,
          eq(schema.virtualApiKeyTeamsTable.teamId, schema.teamsTable.id),
        )
        .where(
          inArray(
            schema.virtualApiKeyTeamsTable.virtualApiKeyId,
            virtualApiKeyIds,
          ),
        ),
      db
        .select({
          virtualApiKeyId: schema.virtualApiKeysTable.id,
          authorName: schema.usersTable.name,
        })
        .from(schema.virtualApiKeysTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.virtualApiKeysTable.authorId, schema.usersTable.id),
        )
        .where(inArray(schema.virtualApiKeysTable.id, virtualApiKeyIds)),
    ]);

    const teamsByVirtualApiKeyId = new Map<string, TeamInfo[]>();
    for (const team of teams) {
      const existing = teamsByVirtualApiKeyId.get(team.virtualApiKeyId) ?? [];
      existing.push({ id: team.teamId, name: team.teamName });
      teamsByVirtualApiKeyId.set(team.virtualApiKeyId, existing);
    }

    const authorNameByVirtualApiKeyId = new Map<string, string | null>();
    for (const author of authors) {
      authorNameByVirtualApiKeyId.set(
        author.virtualApiKeyId,
        author.authorName ?? null,
      );
    }

    return {
      teams: teamsByVirtualApiKeyId,
      authorName: authorNameByVirtualApiKeyId,
    };
  }
}

export default VirtualApiKeyModel;

// ===================================================================
// Internal helpers
// ===================================================================

function generateToken(): string {
  const randomPart = randomBytes(TOKEN_RANDOM_LENGTH).toString("hex");
  return `${ARCHESTRA_TOKEN_PREFIX}${randomPart}`;
}

function getTokenStart(token: string): string {
  return token.substring(0, TOKEN_START_LENGTH);
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function getOrganizationIdForProviderKeys(
  providerApiKeys: ProviderApiKeyInput[],
): Promise<string | null> {
  const firstProviderKey = providerApiKeys[0];
  if (!firstProviderKey) {
    return null;
  }

  const [providerKey] = await db
    .select({ organizationId: schema.llmProviderApiKeysTable.organizationId })
    .from(schema.llmProviderApiKeysTable)
    .where(
      eq(schema.llmProviderApiKeysTable.id, firstProviderKey.providerApiKeyId),
    )
    .limit(1);

  return providerKey?.organizationId ?? null;
}

async function syncVirtualApiKeyTeams(params: {
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
  virtualApiKeyId: string;
  scope: ResourceVisibilityScope;
  teamIds: string[];
}) {
  const { tx, virtualApiKeyId, scope, teamIds } = params;

  await tx
    .delete(schema.virtualApiKeyTeamsTable)
    .where(eq(schema.virtualApiKeyTeamsTable.virtualApiKeyId, virtualApiKeyId));

  if (scope !== "team" || teamIds.length === 0) {
    return;
  }

  await tx.insert(schema.virtualApiKeyTeamsTable).values(
    teamIds.map((teamId) => ({
      virtualApiKeyId,
      teamId,
    })),
  );
}

async function syncProviderApiKeys(params: {
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
  virtualApiKeyId: string;
  mappings: ProviderApiKeyInput[];
}): Promise<void> {
  const { tx, virtualApiKeyId, mappings } = params;

  await tx
    .delete(schema.virtualApiKeyProviderApiKeysTable)
    .where(
      eq(
        schema.virtualApiKeyProviderApiKeysTable.virtualApiKeyId,
        virtualApiKeyId,
      ),
    );

  if (mappings.length === 0) {
    return;
  }

  await tx.insert(schema.virtualApiKeyProviderApiKeysTable).values(
    mappings.map((mapping) => ({
      virtualApiKeyId,
      provider: mapping.provider,
      providerApiKeyId: mapping.providerApiKeyId,
    })),
  );
}
