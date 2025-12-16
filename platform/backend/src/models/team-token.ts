import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { secretManager } from "@/secretsmanager";
import type {
  InsertTeamToken,
  SelectTeamToken,
  TeamTokenWithTeam,
  UpdateTeamToken,
} from "@/types";

/**
 * Team tokens always use DB storage (forceDB: true) because:
 * 1. They are seeded on archestra startup
 * 2. They might not work with BYOS Vault (which is read-only from customer's Vault)
 */
const FORCE_DB = true;

/** Token prefix for identification */
const TOKEN_PREFIX = "archestra_";

/**
 * Get the single organization ID from the database
 * Assumes there is only one organization in the environment
 */
async function getSingleOrganizationId(): Promise<string> {
  const [org] = await db
    .select({ id: schema.organizationsTable.id })
    .from(schema.organizationsTable)
    .limit(1);
  if (!org) throw new Error("No organization found");
  return org.id;
}

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

/**
 * Check if a value looks like a team token (starts with archestra_)
 */
export function isArchestraPrefixedToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

class TeamTokenModel {
  /**
   * Create a new team token
   * Returns the token with its full value (only returned once at creation)
   */
  static async create(
    input: Omit<InsertTeamToken, "secretId" | "tokenStart">,
  ): Promise<{ token: SelectTeamToken; value: string }> {
    // Generate a secure random token
    const tokenValue = generateToken();
    const tokenStart = getTokenStart(tokenValue);

    const secretName = input.teamId
      ? `team-token-${input.teamId}`
      : `org-token-${input.organizationId}`;
    const secret = await secretManager().createSecret(
      { token: tokenValue },
      secretName,
      FORCE_DB,
    );

    // Create token record
    const [token] = await db
      .insert(schema.teamTokensTable)
      .values({
        ...input,
        secretId: secret.id,
        tokenStart,
      })
      .returning();

    return { token, value: tokenValue };
  }

  /**
   * Find a token by ID
   */
  static async findById(id: string): Promise<SelectTeamToken | null> {
    const [token] = await db
      .select()
      .from(schema.teamTokensTable)
      .where(eq(schema.teamTokensTable.id, id))
      .limit(1);

    return token ?? null;
  }

  /**
   * Find a token by ID with team details
   */
  static async findByIdWithTeam(id: string): Promise<TeamTokenWithTeam | null> {
    const result = await db
      .select({
        token: schema.teamTokensTable,
        team: {
          id: schema.teamsTable.id,
          name: schema.teamsTable.name,
        },
      })
      .from(schema.teamTokensTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.teamTokensTable.teamId, schema.teamsTable.id),
      )
      .where(eq(schema.teamTokensTable.id, id))
      .limit(1);

    if (result.length === 0) return null;

    const { token, team } = result[0];
    return {
      ...token,
      team: team?.id ? team : null,
    };
  }

  /**
   * Find all tokens (org token and all team tokens)
   */
  static async findAll(): Promise<SelectTeamToken[]> {
    return db
      .select()
      .from(schema.teamTokensTable)
      .orderBy(schema.teamTokensTable.createdAt);
  }

  /**
   * Find all tokens with team details
   */
  static async findAllWithTeam(): Promise<TeamTokenWithTeam[]> {
    const result = await db
      .select({
        token: schema.teamTokensTable,
        team: {
          id: schema.teamsTable.id,
          name: schema.teamsTable.name,
        },
      })
      .from(schema.teamTokensTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.teamTokensTable.teamId, schema.teamsTable.id),
      )
      .orderBy(
        desc(schema.teamTokensTable.isOrganizationToken),
        schema.teamTokensTable.createdAt,
      );

    return result.map(({ token, team }) => ({
      ...token,
      team: team?.id ? team : null,
    }));
  }

  /**
   * Find the Organization Token
   */
  static async findOrganizationToken(): Promise<SelectTeamToken | null> {
    const [token] = await db
      .select()
      .from(schema.teamTokensTable)
      .where(eq(schema.teamTokensTable.isOrganizationToken, true))
      .limit(1);

    return token ?? null;
  }

  /**
   * Find token for a specific team
   */
  static async findTeamToken(teamId: string): Promise<SelectTeamToken | null> {
    const [token] = await db
      .select()
      .from(schema.teamTokensTable)
      .where(eq(schema.teamTokensTable.teamId, teamId))
      .limit(1);

    return token ?? null;
  }

  /**
   * Update a token (name only)
   */
  static async update(
    id: string,
    input: UpdateTeamToken,
  ): Promise<SelectTeamToken | null> {
    const [updated] = await db
      .update(schema.teamTokensTable)
      .set(input)
      .where(eq(schema.teamTokensTable.id, id))
      .returning();

    return updated ?? null;
  }

  /**
   * Update last used timestamp for a token
   */
  static async updateLastUsed(id: string): Promise<void> {
    await db
      .update(schema.teamTokensTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.teamTokensTable.id, id));
  }

  /**
   * Delete a token and its associated secret
   */
  static async delete(id: string): Promise<boolean> {
    const token = await TeamTokenModel.findById(id);
    if (!token) return false;

    // Delete the token (secret will be cascade deleted)
    await db
      .delete(schema.teamTokensTable)
      .where(eq(schema.teamTokensTable.id, id));

    // Also delete the secret explicitly
    await secretManager().deleteSecret(token.secretId);

    return true;
  }

  /**
   * Rotate a token - generates new value while keeping other metadata
   * Returns the new token value (only returned once)
   */
  static async rotate(id: string): Promise<{ value: string } | null> {
    const token = await TeamTokenModel.findById(id);
    if (!token) return null;

    // Generate new token value
    const newTokenValue = generateToken();
    const newTokenStart = getTokenStart(newTokenValue);

    // Update secret with new value
    await secretManager().updateSecret(token.secretId, {
      token: newTokenValue,
    });

    // Update token start
    await db
      .update(schema.teamTokensTable)
      .set({ tokenStart: newTokenStart })
      .where(eq(schema.teamTokensTable.id, id));

    return { value: newTokenValue };
  }

  /**
   * Validate a token value and return token info
   * Returns the token with organizationId and teamId if valid
   */
  static async validateToken(
    tokenValue: string,
  ): Promise<SelectTeamToken | null> {
    // Get all team tokens (this is not ideal for scale, but works for now)
    const allTokens = await db.select().from(schema.teamTokensTable);

    // Check each token's secret
    for (const token of allTokens) {
      const secret = await secretManager().getSecret(token.secretId);
      if (
        secret?.secret &&
        (secret.secret as { token?: string }).token === tokenValue
      ) {
        // Update last used timestamp
        await TeamTokenModel.updateLastUsed(token.id);
        return token;
      }
    }

    return null;
  }

  /**
   * Create organization token
   */
  static async createOrganizationToken(): Promise<{
    token: SelectTeamToken;
    value: string;
  }> {
    const organizationId = await getSingleOrganizationId();
    return TeamTokenModel.create({
      organizationId,
      name: "Organization Token",
      teamId: null,
      isOrganizationToken: true,
    });
  }

  /**
   * Create a team-scoped token
   */
  static async createTeamToken(
    teamId: string,
    teamName: string,
  ): Promise<{ token: SelectTeamToken; value: string }> {
    const organizationId = await getSingleOrganizationId();
    return TeamTokenModel.create({
      organizationId,
      name: `${teamName} Token`,
      teamId,
      isOrganizationToken: false,
    });
  }

  /**
   * Ensure organization has an org token, create if missing
   * Returns the existing or newly created org token (without value for existing)
   */
  static async ensureOrganizationToken(): Promise<SelectTeamToken> {
    const existing = await TeamTokenModel.findOrganizationToken();
    if (existing) return existing;

    const { token } = await TeamTokenModel.createOrganizationToken();
    return token;
  }

  /**
   * Ensure team has a token, create if missing
   * Returns the existing or newly created team token (without value for existing)
   */
  static async ensureTeamToken(
    teamId: string,
    teamName: string,
  ): Promise<SelectTeamToken> {
    const existing = await TeamTokenModel.findTeamToken(teamId);
    if (existing) return existing;

    const { token } = await TeamTokenModel.createTeamToken(teamId, teamName);
    return token;
  }

  /**
   * Get token value by ID (for copying to clipboard)
   */
  static async getTokenValue(id: string): Promise<string | null> {
    const token = await TeamTokenModel.findById(id);
    if (!token) return null;

    const secret = await secretManager().getSecret(token.secretId);
    if (!secret?.secret) return null;

    return (secret.secret as { token?: string }).token ?? null;
  }
}

export default TeamTokenModel;
