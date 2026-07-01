import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { ConnectionSetup, InsertConnectionSetup } from "@/types";

/**
 * Setup tokens are connection-setup specific; deliberately distinct from
 * team-token and skill-share-link prefixes.
 * @public — exported for testability
 */
export const CONNECTION_SETUP_TOKEN_PREFIX = "archestra_con_";

/** Length of random bytes (24 → 32 url-safe base64 chars without padding). */
const TOKEN_RANDOM_BYTES = 24;

/** Display prefix length: prefix (14) + 8 random chars for UI distinguishability. */
const TOKEN_START_LENGTH = 22;

/** Setup tokens are render tickets, not credentials — keep them short-lived. */
export const CONNECTION_SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;

interface CreateConnectionSetupParams
  extends Omit<InsertConnectionSetup, "tokenHash" | "tokenStart"> {
  skillIds?: string[];
}

class ConnectionSetupModel {
  static async create(params: CreateConnectionSetupParams): Promise<{
    setup: ConnectionSetup;
    rawToken: string;
  }> {
    const { skillIds = [], ...values } = params;

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const tokenStart = rawToken.slice(0, TOKEN_START_LENGTH);

    const setup = await withDbTransaction(async (tx) => {
      const [created] = await tx
        .insert(schema.connectionSetupsTable)
        .values({ ...values, tokenHash, tokenStart })
        .returning();

      const uniqueSkillIds = Array.from(new Set(skillIds));
      if (uniqueSkillIds.length > 0) {
        await tx.insert(schema.connectionSetupSkillsTable).values(
          uniqueSkillIds.map((skillId) => ({
            connectionSetupId: created.id,
            skillId,
          })),
        );
      }

      return created;
    });

    return { setup: setup as ConnectionSetup, rawToken };
  }

  /**
   * Atomically claims an unconsumed, unexpired setup by raw token: sets
   * `consumedAt` and returns the row, or returns null if the token is
   * unknown, already consumed, or expired. Concurrent claims serialize on
   * the row — exactly one caller wins.
   *
   * Accepts an optional transaction; with one, a rollback un-consumes the
   * token. The script endpoint instead claims first (own statement) and
   * compensates with {@link unclaim} on failure, so its re-validation reads
   * observe any revocation committed before the claim.
   */
  static async claimByToken(params: {
    rawToken: string;
    tx?: Transaction;
  }): Promise<ConnectionSetup | null> {
    const [claimed] = await (params.tx ?? db)
      .update(schema.connectionSetupsTable)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(
            schema.connectionSetupsTable.tokenHash,
            hashToken(params.rawToken),
          ),
          isNull(schema.connectionSetupsTable.consumedAt),
          gt(schema.connectionSetupsTable.expiresAt, sql`now()`),
        ),
      )
      .returning();

    return (claimed as ConnectionSetup | undefined) ?? null;
  }

  /**
   * Compensating action for {@link claimByToken}: restores the token after a
   * post-claim failure (failed re-validation or render) so a server-side
   * error doesn't burn the one-time command. Expiry still applies — a later
   * claim re-checks `expiresAt`.
   */
  static async unclaim(id: string): Promise<void> {
    await db
      .update(schema.connectionSetupsTable)
      .set({ consumedAt: null })
      .where(eq(schema.connectionSetupsTable.id, id));
  }

  /** Existence probe so the script endpoint can pick 404 vs 410. */
  static async findByToken(rawToken: string): Promise<ConnectionSetup | null> {
    const [row] = await db
      .select()
      .from(schema.connectionSetupsTable)
      .where(eq(schema.connectionSetupsTable.tokenHash, hashToken(rawToken)))
      .limit(1);

    return (row as ConnectionSetup | undefined) ?? null;
  }

  static async getSkillIds(params: {
    connectionSetupId: string;
    tx?: Transaction;
  }): Promise<string[]> {
    const executor = params.tx ?? db;
    const rows = await executor
      .select({ skillId: schema.connectionSetupSkillsTable.skillId })
      .from(schema.connectionSetupSkillsTable)
      .where(
        eq(
          schema.connectionSetupSkillsTable.connectionSetupId,
          params.connectionSetupId,
        ),
      );

    return rows.map((row) => row.skillId);
  }

  /** Records the lazily-created share link on the setup row (audit/revocation). */
  static async attachSkillShareLink(params: {
    connectionSetupId: string;
    skillShareLinkId: string;
    tx: Transaction;
  }): Promise<void> {
    await params.tx
      .update(schema.connectionSetupsTable)
      .set({ skillShareLinkId: params.skillShareLinkId })
      .where(eq(schema.connectionSetupsTable.id, params.connectionSetupId));
  }
}

export default ConnectionSetupModel;

// ===================================================================
// Internal helpers
// ===================================================================

function generateRawToken(): string {
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  return `${CONNECTION_SETUP_TOKEN_PREFIX}${random}`;
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}
