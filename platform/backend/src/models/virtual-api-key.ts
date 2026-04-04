import { randomBytes, timingSafeEqual } from "node:crypto";
import { ARCHESTRA_TOKEN_PREFIX, type PaginationQuery } from "@shared";
import { and, count, eq, ilike, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { PaginatedResult } from "@/database/utils/pagination";
import { createPaginatedResult } from "@/database/utils/pagination";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  LlmProviderApiKey,
  ResourceVisibilityScope,
  SelectVirtualApiKey,
  VirtualApiKeyWithParentInfo,
} from "@/types";

/** Length of random part (32 bytes = 64 hex chars = 256 bits of entropy) */
const TOKEN_RANDOM_LENGTH = 32;

/** Length of token start to store (for display) */
const TOKEN_START_LENGTH = 14;

/** Always use DB storage (not BYOS Vault compatible) */
const FORCE_DB = true;

type TeamInfo = { id: string; name: string };

type VirtualApiKeyAccessContext = {
  id: string;
  chatApiKeyId: string;
  organizationId: string;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  teamIds: string[];
};

class VirtualApiKeyModel {
  /**
   * Create a new virtual API key for a chat API key.
   * Returns the full token value once at creation (never returned again).
   */
  static async create(params: {
    chatApiKeyId: string;
    name: string;
    expiresAt?: Date | null;
    scope?: ResourceVisibilityScope;
    authorId?: string | null;
    teamIds?: string[];
  }): Promise<{
    virtualKey: SelectVirtualApiKey;
    value: string;
    teams: TeamInfo[];
    authorName: string | null;
  }> {
    const {
      chatApiKeyId,
      name,
      expiresAt,
      scope = "org",
      authorId = null,
      teamIds = [],
    } = params;

    const tokenValue = generateToken();
    const tokenStart = getTokenStart(tokenValue);

    const secretName = `virtual-api-key-${chatApiKeyId}-${Date.now()}`;
    const secret = await secretManager().createSecret(
      { token: tokenValue },
      secretName,
      FORCE_DB,
    );

    const virtualKey = await db.transaction(async (tx) => {
      const [createdVirtualKey] = await tx
        .insert(schema.virtualApiKeysTable)
        .values({
          chatApiKeyId,
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

      return createdVirtualKey;
    });

    logger.info(
      { chatApiKeyId, virtualKeyId: virtualKey.id, scope },
      "VirtualApiKeyModel.create: virtual key created",
    );

    const { teams, authorName } =
      await VirtualApiKeyModel.getVisibilityMetadata([virtualKey.id]);

    return {
      virtualKey,
      value: tokenValue,
      teams: teams.get(virtualKey.id) ?? [],
      authorName: authorName.get(virtualKey.id) ?? null,
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
  }): Promise<SelectVirtualApiKey | null> {
    const { id, name, expiresAt, scope, authorId, teamIds } = params;

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
   * List visible virtual keys for a chat API key.
   */
  static async findByChatApiKeyId(
    params:
      | {
          chatApiKeyId: string;
          organizationId: string;
          userId: string;
          userTeamIds: string[];
          isAdmin: boolean;
        }
      | string,
  ): Promise<SelectVirtualApiKey[]> {
    if (typeof params === "string") {
      return db
        .select()
        .from(schema.virtualApiKeysTable)
        .where(eq(schema.virtualApiKeysTable.chatApiKeyId, params))
        .orderBy(schema.virtualApiKeysTable.createdAt);
    }

    const accessibleIds = await VirtualApiKeyModel.getAccessibleIds({
      organizationId: params.organizationId,
      userId: params.userId,
      userTeamIds: params.userTeamIds,
      isAdmin: params.isAdmin,
      chatApiKeyId: params.chatApiKeyId,
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
        chatApiKeyId: schema.virtualApiKeysTable.chatApiKeyId,
        organizationId: schema.llmProviderApiKeysTable.organizationId,
        scope: schema.virtualApiKeysTable.scope,
        authorId: schema.virtualApiKeysTable.authorId,
      })
      .from(schema.virtualApiKeysTable)
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.virtualApiKeysTable.chatApiKeyId,
          schema.llmProviderApiKeysTable.id,
        ),
      )
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
   * Count virtual keys for a chat API key (for enforcing max limit).
   */
  static async countByChatApiKeyId(chatApiKeyId: string): Promise<number> {
    const [result] = await db
      .select({ total: count() })
      .from(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.chatApiKeyId, chatApiKeyId));

    return Number(result?.total ?? 0);
  }

  /**
   * Find visible virtual keys for an organization, joined with parent API key info.
   * Supports pagination.
   */
  static async findAllByOrganization(params: {
    organizationId: string;
    pagination: PaginationQuery;
    userId?: string;
    userTeamIds?: string[];
    isAdmin?: boolean;
    search?: string;
    chatApiKeyId?: string;
  }): Promise<PaginatedResult<VirtualApiKeyWithParentInfo>> {
    const {
      organizationId,
      pagination,
      userId = "",
      userTeamIds = [],
      isAdmin = true,
      search,
      chatApiKeyId,
    } = params;

    const accessibleIds = await VirtualApiKeyModel.getAccessibleIds({
      organizationId,
      userId,
      userTeamIds,
      isAdmin,
      chatApiKeyId,
    });

    if (!isAdmin && accessibleIds.length === 0) {
      return createPaginatedResult([], 0, pagination);
    }

    const whereConditions = [
      eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
    ];

    if (!isAdmin) {
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

    if (chatApiKeyId) {
      whereConditions.push(
        eq(schema.virtualApiKeysTable.chatApiKeyId, chatApiKeyId),
      );
    }

    const whereClause = and(...whereConditions);

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: schema.virtualApiKeysTable.id,
          chatApiKeyId: schema.virtualApiKeysTable.chatApiKeyId,
          name: schema.virtualApiKeysTable.name,
          secretId: schema.virtualApiKeysTable.secretId,
          tokenStart: schema.virtualApiKeysTable.tokenStart,
          scope: schema.virtualApiKeysTable.scope,
          authorId: schema.virtualApiKeysTable.authorId,
          expiresAt: schema.virtualApiKeysTable.expiresAt,
          lastUsedAt: schema.virtualApiKeysTable.lastUsedAt,
          createdAt: schema.virtualApiKeysTable.createdAt,
          parentKeyName: schema.llmProviderApiKeysTable.name,
          parentKeyProvider: schema.llmProviderApiKeysTable.provider,
          parentKeyBaseUrl: schema.llmProviderApiKeysTable.baseUrl,
        })
        .from(schema.virtualApiKeysTable)
        .innerJoin(
          schema.llmProviderApiKeysTable,
          eq(
            schema.virtualApiKeysTable.chatApiKeyId,
            schema.llmProviderApiKeysTable.id,
          ),
        )
        .where(whereClause)
        .orderBy(schema.virtualApiKeysTable.createdAt)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.virtualApiKeysTable)
        .innerJoin(
          schema.llmProviderApiKeysTable,
          eq(
            schema.virtualApiKeysTable.chatApiKeyId,
            schema.llmProviderApiKeysTable.id,
          ),
        )
        .where(whereClause),
    ]);

    const metadata = await VirtualApiKeyModel.getVisibilityMetadata(
      rows.map((row) => row.id),
    );

    const data = rows.map((row) => ({
      ...row,
      teams: metadata.teams.get(row.id) ?? [],
      authorName: metadata.authorName.get(row.id) ?? null,
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
   * Returns the virtual key and associated chat API key if valid.
   */
  static async validateToken(tokenValue: string): Promise<{
    virtualKey: SelectVirtualApiKey;
    chatApiKey: LlmProviderApiKey;
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
        const [chatApiKey] = await db
          .select()
          .from(schema.llmProviderApiKeysTable)
          .where(eq(schema.llmProviderApiKeysTable.id, virtualKey.chatApiKeyId))
          .limit(1);

        if (!chatApiKey) {
          logger.warn(
            {
              virtualKeyId: virtualKey.id,
              chatApiKeyId: virtualKey.chatApiKeyId,
            },
            "Virtual key references non-existent chat API key",
          );
          return null;
        }

        VirtualApiKeyModel.updateLastUsed(virtualKey.id).catch((error) => {
          logger.warn(
            { virtualKeyId: virtualKey.id, error: String(error) },
            "Failed to update virtual key lastUsedAt",
          );
        });

        return { virtualKey, chatApiKey };
      }
    }

    return null;
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
    chatApiKeyId?: string;
  }): Promise<string[]> {
    const { organizationId, userId, userTeamIds, isAdmin, chatApiKeyId } =
      params;

    if (isAdmin) {
      const conditions = [];
      if (organizationId) {
        conditions.push(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
        );
      }
      if (chatApiKeyId) {
        conditions.push(
          eq(schema.virtualApiKeysTable.chatApiKeyId, chatApiKeyId),
        );
      }

      const rows = await db
        .select({ id: schema.virtualApiKeysTable.id })
        .from(schema.virtualApiKeysTable)
        .innerJoin(
          schema.llmProviderApiKeysTable,
          eq(
            schema.virtualApiKeysTable.chatApiKeyId,
            schema.llmProviderApiKeysTable.id,
          ),
        )
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      return rows.map((row) => row.id);
    }

    const teamAccessCondition =
      userTeamIds.length > 0
        ? sql`
            SELECT DISTINCT vat.virtual_api_key_id AS id
            FROM virtual_api_key_team vat
            INNER JOIN virtual_api_keys vak ON vat.virtual_api_key_id = vak.id
            INNER JOIN chat_api_keys cak ON vak.chat_api_key_id = cak.id
            WHERE vak.scope = 'team'
              AND vat.team_id IN (${sql.join(
                userTeamIds.map((id) => sql`${id}`),
                sql`, `,
              )})
              ${organizationId ? sql`AND cak.organization_id = ${organizationId}` : sql``}
              ${chatApiKeyId ? sql`AND vak.chat_api_key_id = ${chatApiKeyId}` : sql``}
          `
        : null;

    const result = await db.execute<{ id: string }>(sql`
      SELECT vak.id
      FROM virtual_api_keys vak
      INNER JOIN chat_api_keys cak ON vak.chat_api_key_id = cak.id
      WHERE vak.scope = 'org'
        ${organizationId ? sql`AND cak.organization_id = ${organizationId}` : sql``}
        ${chatApiKeyId ? sql`AND vak.chat_api_key_id = ${chatApiKeyId}` : sql``}
      UNION
      SELECT vak.id
      FROM virtual_api_keys vak
      INNER JOIN chat_api_keys cak ON vak.chat_api_key_id = cak.id
      WHERE vak.scope = 'personal'
        AND vak.author_id = ${userId}
        ${organizationId ? sql`AND cak.organization_id = ${organizationId}` : sql``}
        ${chatApiKeyId ? sql`AND vak.chat_api_key_id = ${chatApiKeyId}` : sql``}
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

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
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
