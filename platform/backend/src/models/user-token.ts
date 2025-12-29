import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { secretManager } from "@/secretsmanager";
import type { SelectUserToken } from "@/types";

/**
 * User tokens always use DB storage (forceDB: true) because:
 * 1. They are auto-created on user joining an organization
 * 2. They might not work with BYOS Vault (which is read-only from customer's Vault)
 */
const FORCE_DB = true;

/** Token prefix for identification */
const TOKEN_PREFIX = "archestra_";

/** Length of random part (16 bytes = 32 hex chars) */
const TOKEN_RANDOM_LENGTH = 16;

/** Length of token start to store (for display) */
const TOKEN_START_LENGTH = 14;

/**
 * Generate a secure random token with archestra_ prefix
 * Format: archestra_<32 hex characters>
 * Total length: 42 characters
 */
function generateToken(): string {
  const randomPart = randomBytes(TOKEN_RANDOM_LENGTH).toString("hex");
  return `${TOKEN_PREFIX}${randomPart}`;
}

/**
 * Get the display prefix from a token
 */
function getTokenStart(token: string): string {
  return token.substring(0, TOKEN_START_LENGTH);
}

class UserTokenModel {
  /**
   * Create a new user token
   * Returns the token with its full value (only returned once at creation)
   */
  static async create(
    userId: string,
    organizationId: string,
    name = "Personal Token",
  ): Promise<{ token: SelectUserToken; value: string }> {
    logger.debug(
      { userId, organizationId },
      "UserTokenModel.create: creating token",
    );

    // Generate a secure random token
    const tokenValue = generateToken();
    const tokenStart = getTokenStart(tokenValue);

    const secretName = `user-token-${userId}-${organizationId}`;
    const secret = await secretManager().createSecret(
      { token: tokenValue },
      secretName,
      FORCE_DB,
    );

    // Create token record
    const [token] = await db
      .insert(schema.userTokensTable)
      .values({
        userId,
        organizationId,
        name,
        secretId: secret.id,
        tokenStart,
      })
      .returning();

    logger.info(
      { userId, organizationId, tokenId: token.id },
      "UserTokenModel.create: token created successfully",
    );

    return { token, value: tokenValue };
  }

  /**
   * Find a token by ID
   */
  static async findById(id: string): Promise<SelectUserToken | null> {
    const [token] = await db
      .select()
      .from(schema.userTokensTable)
      .where(eq(schema.userTokensTable.id, id))
      .limit(1);

    return token ?? null;
  }

  /**
   * Find a user's token for a specific organization
   */
  static async findByUserAndOrg(
    userId: string,
    organizationId: string,
  ): Promise<SelectUserToken | null> {
    const [token] = await db
      .select()
      .from(schema.userTokensTable)
      .where(
        and(
          eq(schema.userTokensTable.userId, userId),
          eq(schema.userTokensTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    return token ?? null;
  }

  /**
   * Update last used timestamp for a token
   */
  static async updateLastUsed(id: string): Promise<void> {
    await db
      .update(schema.userTokensTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.userTokensTable.id, id));
  }

  /**
   * Delete a token and its associated secret
   */
  static async delete(id: string): Promise<boolean> {
    const token = await UserTokenModel.findById(id);
    if (!token) return false;

    logger.debug({ tokenId: id }, "UserTokenModel.delete: deleting token");

    // Delete the token (secret will be cascade deleted)
    await db
      .delete(schema.userTokensTable)
      .where(eq(schema.userTokensTable.id, id));

    // Also delete the secret explicitly
    await secretManager().deleteSecret(token.secretId);

    logger.info({ tokenId: id }, "UserTokenModel.delete: token deleted");

    return true;
  }

  /**
   * Delete all tokens for a user in an organization
   */
  static async deleteByUserAndOrg(
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const token = await UserTokenModel.findByUserAndOrg(userId, organizationId);
    if (!token) return false;

    return UserTokenModel.delete(token.id);
  }

  /**
   * Rotate a token - generates new value while keeping other metadata
   * Returns the new token value (only returned once)
   */
  static async rotate(id: string): Promise<{ value: string } | null> {
    const token = await UserTokenModel.findById(id);
    if (!token) return null;

    logger.debug({ tokenId: id }, "UserTokenModel.rotate: rotating token");

    // Generate new token value
    const newTokenValue = generateToken();
    const newTokenStart = getTokenStart(newTokenValue);

    // Update secret with new value
    await secretManager().updateSecret(token.secretId, {
      token: newTokenValue,
    });

    // Update token start
    await db
      .update(schema.userTokensTable)
      .set({ tokenStart: newTokenStart })
      .where(eq(schema.userTokensTable.id, id));

    logger.info({ tokenId: id }, "UserTokenModel.rotate: token rotated");

    return { value: newTokenValue };
  }

  /**
   * Validate a token value and return token info
   * Returns the token with userId and organizationId if valid
   */
  static async validateToken(
    tokenValue: string,
  ): Promise<SelectUserToken | null> {
    // Get all user tokens (this is not ideal for scale, but matches team token pattern)
    const allTokens = await db.select().from(schema.userTokensTable);

    // Check each token's secret
    for (const token of allTokens) {
      const secret = await secretManager().getSecret(token.secretId);
      if (
        secret?.secret &&
        (secret.secret as { token?: string }).token === tokenValue
      ) {
        // Update last used timestamp
        await UserTokenModel.updateLastUsed(token.id);
        return token;
      }
    }

    return null;
  }

  /**
   * Get token value by ID (for copying to clipboard)
   */
  static async getTokenValue(id: string): Promise<string | null> {
    const token = await UserTokenModel.findById(id);
    if (!token) return null;

    const secret = await secretManager().getSecret(token.secretId);
    if (!secret?.secret) return null;

    return (secret.secret as { token?: string }).token ?? null;
  }

  /**
   * Ensure user has a token for the organization, create if missing
   */
  static async ensureUserToken(
    userId: string,
    organizationId: string,
  ): Promise<SelectUserToken> {
    const existing = await UserTokenModel.findByUserAndOrg(
      userId,
      organizationId,
    );
    if (existing) return existing;

    const { token } = await UserTokenModel.create(userId, organizationId);
    return token;
  }
}

export default UserTokenModel;
