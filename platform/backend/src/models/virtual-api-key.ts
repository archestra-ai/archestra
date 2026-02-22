import { randomBytes, timingSafeEqual } from "node:crypto";
import { ARCHESTRA_TOKEN_PREFIX } from "@shared";
import { count, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { PaginatedResult } from "@/database/utils/pagination";
import { createPaginatedResult } from "@/database/utils/pagination";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  ChatApiKey,
  PaginationQuery,
  SelectVirtualApiKey,
  VirtualApiKeyWithParentInfo,
} from "@/types";

/** Length of random part (32 bytes = 64 hex chars = 256 bits of entropy) */
const TOKEN_RANDOM_LENGTH = 32;

/** Length of token start to store (for display) */
const TOKEN_START_LENGTH = 14;

/** Always use DB storage (not BYOS Vault compatible) */
const FORCE_DB = true;

class VirtualApiKeyModel {
  /**
   * Create a new virtual API key for a chat API key.
   * Returns the full token value once at creation (never returned again).
   */
  static async create(params: {
    chatApiKeyId: string;
    name: string;
    expiresAt?: Date | null;
  }): Promise<{ virtualKey: SelectVirtualApiKey; value: string }> {
    const { chatApiKeyId, name, expiresAt } = params;

    const tokenValue = generateToken();
    const tokenStart = getTokenStart(tokenValue);

    const secretName = `virtual-api-key-${chatApiKeyId}-${Date.now()}`;
    const secret = await secretManager().createSecret(
      { token: tokenValue },
      secretName,
      FORCE_DB,
    );

    const [virtualKey] = await db
      .insert(schema.virtualApiKeysTable)
      .values({
        chatApiKeyId,
        name,
        secretId: secret.id,
        tokenStart,
        expiresAt: expiresAt ?? null,
      })
      .returning();

    logger.info(
      { chatApiKeyId, virtualKeyId: virtualKey.id },
      "VirtualApiKeyModel.create: virtual key created",
    );

    return { virtualKey, value: tokenValue };
  }

  /**
   * List all virtual keys for a chat API key.
   */
  static async findByChatApiKeyId(
    chatApiKeyId: string,
  ): Promise<SelectVirtualApiKey[]> {
    return db
      .select()
      .from(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.chatApiKeyId, chatApiKeyId))
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
   * Delete a virtual key and its associated secret.
   */
  static async delete(id: string): Promise<boolean> {
    const virtualKey = await VirtualApiKeyModel.findById(id);
    if (!virtualKey) return false;

    // Delete the virtual key record first, then clean up the secret.
    // The FK has ON DELETE CASCADE on the secret side, but we also call
    // deleteSecret explicitly to handle non-DB secret backends (Vault).
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
   * Find all virtual keys for an organization, joined with parent API key info.
   * Supports pagination.
   */
  static async findAllByOrganization(params: {
    organizationId: string;
    pagination: PaginationQuery;
  }): Promise<PaginatedResult<VirtualApiKeyWithParentInfo>> {
    const { organizationId, pagination } = params;

    const whereClause = eq(
      schema.chatApiKeysTable.organizationId,
      organizationId,
    );

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: schema.virtualApiKeysTable.id,
          chatApiKeyId: schema.virtualApiKeysTable.chatApiKeyId,
          name: schema.virtualApiKeysTable.name,
          secretId: schema.virtualApiKeysTable.secretId,
          tokenStart: schema.virtualApiKeysTable.tokenStart,
          expiresAt: schema.virtualApiKeysTable.expiresAt,
          lastUsedAt: schema.virtualApiKeysTable.lastUsedAt,
          createdAt: schema.virtualApiKeysTable.createdAt,
          parentKeyName: schema.chatApiKeysTable.name,
          parentKeyProvider: schema.chatApiKeysTable.provider,
          parentKeyBaseUrl: schema.chatApiKeysTable.baseUrl,
        })
        .from(schema.virtualApiKeysTable)
        .innerJoin(
          schema.chatApiKeysTable,
          eq(
            schema.virtualApiKeysTable.chatApiKeyId,
            schema.chatApiKeysTable.id,
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
          schema.chatApiKeysTable,
          eq(
            schema.virtualApiKeysTable.chatApiKeyId,
            schema.chatApiKeysTable.id,
          ),
        )
        .where(whereClause),
    ]);

    return createPaginatedResult(rows, Number(total), pagination);
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
   *
   * Uses `tokenStart` (first 14 chars) to narrow candidates to typically 1 row,
   * then verifies the full token via the secret manager.
   *
   * **Note:** This method does NOT check `expiresAt`. Callers must verify
   * expiration themselves so they can return an appropriate error
   * (e.g. 401 "Virtual API key expired").
   */
  static async validateToken(tokenValue: string): Promise<{
    virtualKey: SelectVirtualApiKey;
    chatApiKey: ChatApiKey;
  } | null> {
    // Filter by tokenStart to avoid a full table scan — narrows to typically 1 candidate
    const tokenStart = getTokenStart(tokenValue);
    const candidates = await db
      .select()
      .from(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.tokenStart, tokenStart));

    for (const virtualKey of candidates) {
      const secret = await secretManager().getSecret(virtualKey.secretId);
      const storedToken = (secret?.secret as { token?: string })?.token;
      if (storedToken && constantTimeEqual(storedToken, tokenValue)) {
        // Found the match — look up the parent chat API key
        const [chatApiKey] = await db
          .select()
          .from(schema.chatApiKeysTable)
          .where(eq(schema.chatApiKeysTable.id, virtualKey.chatApiKeyId))
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

        // Update last used (fire and forget)
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
