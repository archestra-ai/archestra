import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { secretManager } from "@/secretsmanager";
import type {
  InsertProfileToken,
  ProfileTokenWithTeams,
  SelectProfileToken,
  UpdateProfileToken,
} from "@/types";

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

/**
 * Check if a value looks like a profile token (starts with archestra_)
 */
export function isArchestraPrefixedProfileToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}

class ProfileTokenModel {
  /**
   * Create a new profile token
   * Returns the token with its full value (only returned once at creation)
   */
  static async create(
    input: Omit<InsertProfileToken, "secretId" | "tokenStart">,
    teamIds?: string[],
  ): Promise<{ token: SelectProfileToken; value: string }> {
    // Generate a secure random token
    const tokenValue = generateToken();
    const tokenStart = getTokenStart(tokenValue);

    // Store token value in secret table via secretsManager
    const secret = await secretManager.createSecret(
      { token: tokenValue },
      `profile-token-${input.profileId}-${input.name}`,
    );

    // Create token record
    const [token] = await db
      .insert(schema.profileTokensTable)
      .values({
        ...input,
        secretId: secret.id,
        tokenStart,
      })
      .returning();

    // Add team associations if provided
    if (teamIds && teamIds.length > 0) {
      await db.insert(schema.profileTokenTeamsTable).values(
        teamIds.map((teamId) => ({
          tokenId: token.id,
          teamId,
        })),
      );
    }

    return { token, value: tokenValue };
  }

  /**
   * Find a token by ID
   */
  static async findById(id: string): Promise<SelectProfileToken | null> {
    const [token] = await db
      .select()
      .from(schema.profileTokensTable)
      .where(eq(schema.profileTokensTable.id, id))
      .limit(1);

    return token ?? null;
  }

  /**
   * Find a token by ID with team details
   */
  static async findByIdWithTeams(
    id: string,
  ): Promise<ProfileTokenWithTeams | null> {
    const token = await ProfileTokenModel.findById(id);
    if (!token) return null;

    const teams = await ProfileTokenModel.getTeamsForToken(id);
    return { ...token, teams };
  }

  /**
   * Find all tokens for a profile
   */
  static async findByProfileId(
    profileId: string,
  ): Promise<SelectProfileToken[]> {
    return db
      .select()
      .from(schema.profileTokensTable)
      .where(eq(schema.profileTokensTable.profileId, profileId))
      .orderBy(schema.profileTokensTable.createdAt);
  }

  /**
   * Find all tokens for a profile with team details
   */
  static async findByProfileIdWithTeams(
    profileId: string,
  ): Promise<ProfileTokenWithTeams[]> {
    const tokens = await ProfileTokenModel.findByProfileId(profileId);
    if (tokens.length === 0) return [];

    const tokenIds = tokens.map((t) => t.id);
    const teamsMap = await ProfileTokenModel.getTeamsForTokens(tokenIds);

    return tokens.map((token) => ({
      ...token,
      teams: teamsMap.get(token.id) ?? [],
    }));
  }

  /**
   * Update a token (name, isOrganizationToken)
   */
  static async update(
    id: string,
    input: UpdateProfileToken,
  ): Promise<SelectProfileToken | null> {
    const [updated] = await db
      .update(schema.profileTokensTable)
      .set(input)
      .where(eq(schema.profileTokensTable.id, id))
      .returning();

    return updated ?? null;
  }

  /**
   * Update last used timestamp for a token
   */
  static async updateLastUsed(id: string): Promise<void> {
    await db
      .update(schema.profileTokensTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.profileTokensTable.id, id));
  }

  /**
   * Delete a token and its associated secret
   */
  static async delete(id: string): Promise<boolean> {
    const token = await ProfileTokenModel.findById(id);
    if (!token) return false;

    // Delete the token (cascade will delete team associations)
    await db
      .delete(schema.profileTokensTable)
      .where(eq(schema.profileTokensTable.id, id));

    // Delete the secret
    await secretManager.deleteSecret(token.secretId);

    return true;
  }

  /**
   * Rotate a token - generates new value while keeping other metadata
   * Returns the new token value (only returned once)
   */
  static async rotate(id: string): Promise<{ value: string } | null> {
    const token = await ProfileTokenModel.findById(id);
    if (!token) return null;

    // Generate new token value
    const newTokenValue = generateToken();
    const newTokenStart = getTokenStart(newTokenValue);

    // Update secret with new value
    await secretManager.updateSecret(token.secretId, { token: newTokenValue });

    // Update token start
    await db
      .update(schema.profileTokensTable)
      .set({ tokenStart: newTokenStart })
      .where(eq(schema.profileTokensTable.id, id));

    return { value: newTokenValue };
  }

  /**
   * Validate a token value against stored tokens for a profile
   * Returns the token if valid, null otherwise
   */
  static async validateToken(
    profileId: string,
    tokenValue: string,
  ): Promise<SelectProfileToken | null> {
    // Get all tokens for the profile
    const tokens = await ProfileTokenModel.findByProfileId(profileId);

    // Check each token's secret
    for (const token of tokens) {
      const secret = await secretManager.getSecret(token.secretId);
      if (
        secret?.secret &&
        (secret.secret as { token?: string }).token === tokenValue
      ) {
        // Update last used timestamp
        await ProfileTokenModel.updateLastUsed(token.id);
        return token;
      }
    }

    return null;
  }

  /**
   * Get team IDs for a token
   */
  static async getTeamIdsForToken(tokenId: string): Promise<string[]> {
    const result = await db
      .select({ teamId: schema.profileTokenTeamsTable.teamId })
      .from(schema.profileTokenTeamsTable)
      .where(eq(schema.profileTokenTeamsTable.tokenId, tokenId));

    return result.map((r) => r.teamId);
  }

  /**
   * Get team details for a token
   */
  static async getTeamsForToken(
    tokenId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const result = await db
      .select({
        id: schema.teamsTable.id,
        name: schema.teamsTable.name,
      })
      .from(schema.profileTokenTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.profileTokenTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(eq(schema.profileTokenTeamsTable.tokenId, tokenId));

    return result;
  }

  /**
   * Get team details for multiple tokens (batch)
   */
  static async getTeamsForTokens(
    tokenIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    if (tokenIds.length === 0) return new Map();

    const result = await db
      .select({
        tokenId: schema.profileTokenTeamsTable.tokenId,
        teamId: schema.teamsTable.id,
        teamName: schema.teamsTable.name,
      })
      .from(schema.profileTokenTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.profileTokenTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(inArray(schema.profileTokenTeamsTable.tokenId, tokenIds));

    const teamsMap = new Map<string, Array<{ id: string; name: string }>>();

    // Initialize all token IDs with empty arrays
    for (const tokenId of tokenIds) {
      teamsMap.set(tokenId, []);
    }

    // Populate with results
    for (const row of result) {
      const teams = teamsMap.get(row.tokenId) ?? [];
      teams.push({ id: row.teamId, name: row.teamName });
      teamsMap.set(row.tokenId, teams);
    }

    return teamsMap;
  }

  /**
   * Sync team associations for a token (replace all)
   */
  static async syncTeams(tokenId: string, teamIds: string[]): Promise<void> {
    await db.transaction(async (tx) => {
      // Delete existing team associations
      await tx
        .delete(schema.profileTokenTeamsTable)
        .where(eq(schema.profileTokenTeamsTable.tokenId, tokenId));

      // Insert new associations
      if (teamIds.length > 0) {
        await tx.insert(schema.profileTokenTeamsTable).values(
          teamIds.map((teamId) => ({
            tokenId,
            teamId,
          })),
        );
      }
    });
  }

  /**
   * Find a token by its stored value (for authentication)
   * This is less efficient than validateToken() as it checks all tokens
   */
  static async findByTokenValue(
    tokenValue: string,
  ): Promise<SelectProfileToken | null> {
    // Get all profile tokens
    const allTokens = await db.select().from(schema.profileTokensTable);

    // Check each token's secret
    for (const token of allTokens) {
      const secret = await secretManager.getSecret(token.secretId);
      if (
        secret?.secret &&
        (secret.secret as { token?: string }).token === tokenValue
      ) {
        return token;
      }
    }

    return null;
  }

  /**
   * Create default "organization" token for a profile
   */
  static async createDefaultToken(
    profileId: string,
  ): Promise<{ token: SelectProfileToken; value: string }> {
    return ProfileTokenModel.create(
      {
        profileId,
        name: "Default",
        isOrganizationToken: true,
      },
      [],
    );
  }

  /**
   * Create a team-scoped token for a profile
   */
  static async createTeamToken(
    profileId: string,
    teamId: string,
    teamName: string,
  ): Promise<{ token: SelectProfileToken; value: string }> {
    return ProfileTokenModel.create(
      {
        profileId,
        name: `${teamName} Token`,
        isOrganizationToken: false,
      },
      [teamId],
    );
  }

  /**
   * Check if a profile has any tokens
   */
  static async hasTokens(profileId: string): Promise<boolean> {
    const [result] = await db
      .select({ count: schema.profileTokensTable.id })
      .from(schema.profileTokensTable)
      .where(eq(schema.profileTokensTable.profileId, profileId))
      .limit(1);

    return !!result;
  }
}

export default ProfileTokenModel;
