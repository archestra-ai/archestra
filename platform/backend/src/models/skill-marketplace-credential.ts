import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import logger from "@/logging";
import type { SkillMarketplaceCredential } from "@/types";

/**
 * Read-only credentials for the static marketplace URL. See the table comment
 * in `database/schemas/skill-marketplace-credential.ts` for why these exist
 * instead of reusing the caller's personal token.
 */

/** Distinct from the personal-token and share-link prefixes, so it is obvious in a log or a git config what a leaked value can do. */
const SKILL_MARKETPLACE_TOKEN_PREFIX = "archestra_mkt_";

const TOKEN_RANDOM_BYTES = 24;
const TOKEN_START_LENGTH = 22;

/**
 * How stale `lastUsedAt` may get before a validation refreshes it. Every clone
 * validates, so an unconditional write would make the row a lock hot spot.
 */
const LAST_USED_REFRESH_INTERVAL_MS = 60_000;

class SkillMarketplaceCredentialModel {
  /**
   * Mint a credential for one user. The raw token is returned only here.
   *
   * Takes an optional transaction because the setup-script route mints inside
   * one: the credential and the rendered script must commit together, and on a
   * single-connection database a separate handle would deadlock against the
   * open transaction rather than just racing.
   */
  static async create(params: {
    organizationId: string;
    userId: string;
    tx?: Transaction;
  }): Promise<{ credential: SkillMarketplaceCredential; rawToken: string }> {
    const rawToken = generateToken();
    const [credential] = await (params.tx ?? db)
      .insert(schema.skillMarketplaceCredentialsTable)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        tokenHash: hashToken(rawToken),
        tokenStart: rawToken.slice(0, TOKEN_START_LENGTH),
      })
      .returning();
    return { credential, rawToken };
  }

  /**
   * Resolve a raw token to its owner. Returns null for anything unknown; the
   * caller's permissions are checked separately, so a valid token whose owner
   * has lost `skill:read` still resolves here and is refused downstream.
   */
  static async validateToken(
    rawToken: string,
  ): Promise<SkillMarketplaceCredential | null> {
    if (!rawToken.startsWith(SKILL_MARKETPLACE_TOKEN_PREFIX)) return null;

    const [credential] = await db
      .select()
      .from(schema.skillMarketplaceCredentialsTable)
      .where(
        eq(
          schema.skillMarketplaceCredentialsTable.tokenHash,
          hashToken(rawToken),
        ),
      )
      .limit(1);
    if (!credential) return null;

    touchLastUsed(credential).catch((error) => {
      logger.warn(
        { credentialId: credential.id, error: String(error) },
        "skill-marketplace: failed to update credential lastUsedAt",
      );
    });
    return credential;
  }

  /**
   * Drop every credential a user holds in one organization. Used when they
   * lose their membership — the row's FKs only cascade on user or org
   * deletion, which membership removal is not.
   */
  static async deleteForMember(params: {
    organizationId: string;
    userId: string;
  }): Promise<number> {
    const deleted = await db
      .delete(schema.skillMarketplaceCredentialsTable)
      .where(
        and(
          eq(
            schema.skillMarketplaceCredentialsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.skillMarketplaceCredentialsTable.userId, params.userId),
        ),
      )
      .returning({ id: schema.skillMarketplaceCredentialsTable.id });
    return deleted.length;
  }
}

export default SkillMarketplaceCredentialModel;

// ===== Internal helpers =====

function generateToken(): string {
  return `${SKILL_MARKETPLACE_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

/**
 * SHA-256, matching `skill-share-link.ts`. Deliberately not a slow KDF: the
 * input is 24 bytes from `randomBytes` (192 bits of machine-generated
 * entropy), not a user-chosen password, so there is nothing for an offline
 * attacker to brute-force at any hash speed. bcrypt/argon2 exist to stretch
 * low-entropy human secrets, and using one here would add latency to every
 * clone for no security gain.
 *
 * CodeQL's js/insufficient-password-hash flags this because the presented
 * credential reaches it from the Basic-auth `password` field; that field
 * carries this same random token, not a password.
 */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

async function touchLastUsed(
  credential: SkillMarketplaceCredential,
): Promise<void> {
  const lastUsed = credential.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - lastUsed < LAST_USED_REFRESH_INTERVAL_MS) return;
  await db
    .update(schema.skillMarketplaceCredentialsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.skillMarketplaceCredentialsTable.id, credential.id));
}
