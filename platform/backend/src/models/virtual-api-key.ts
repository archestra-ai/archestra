import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type { ChatApiKey, SelectVirtualApiKey } from "@/types";

/** Token prefix for identification */
const TOKEN_PREFIX = "archestra_";

/** Length of random part (16 bytes = 32 hex chars) */
const TOKEN_RANDOM_LENGTH = 16;

/** Length of token start to store (for display) */
const TOKEN_START_LENGTH = 14;

/** Always use DB storage (not BYOS Vault compatible) */
const FORCE_DB = true;

/** Default maximum virtual keys per chat API key */
const DEFAULT_MAX_VIRTUAL_KEYS = 10;

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

    await secretManager().deleteSecret(virtualKey.secretId);

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
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.virtualApiKeysTable)
      .where(eq(schema.virtualApiKeysTable.chatApiKeyId, chatApiKeyId));

    return result?.count ?? 0;
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
      if (
        secret?.secret &&
        (secret.secret as { token?: string }).token === tokenValue
      ) {
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
        VirtualApiKeyModel.updateLastUsed(virtualKey.id).catch(() => {});

        return { virtualKey, chatApiKey };
      }
    }

    return null;
  }

  /**
   * Get the maximum number of virtual keys allowed per chat API key.
   */
  static getMaxVirtualKeysPerApiKey(): number {
    const envValue = process.env.ARCHESTRA_LLM_PROXY_MAX_VIRTUAL_KEYS;
    if (envValue) {
      const parsed = Number.parseInt(envValue, 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_MAX_VIRTUAL_KEYS;
  }
}

export default VirtualApiKeyModel;

// ===================================================================
// Internal helpers
// ===================================================================

function generateToken(): string {
  const randomPart = randomBytes(TOKEN_RANDOM_LENGTH).toString("hex");
  return `${TOKEN_PREFIX}${randomPart}`;
}

function getTokenStart(token: string): string {
  return token.substring(0, TOKEN_START_LENGTH);
}
