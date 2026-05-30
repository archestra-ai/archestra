import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import logger from "@/logging";
import type {
  SkillShareLink,
  SkillShareLinkSkillSummary,
  SkillShareLinkWithSkills,
} from "@/types";

/**
 * Token prefix is share-link specific; deliberately distinct from team-token prefix.
 * @public — exported for testability
 */
export const SKILL_SHARE_LINK_TOKEN_PREFIX = "archestra_skl_";

/** Length of random bytes (24 → 32 url-safe base64 chars without padding). */
const TOKEN_RANDOM_BYTES = 24;

/** Display prefix length: prefix (14) + 8 random chars for UI distinguishability. */
const TOKEN_START_LENGTH = 22;

interface CreateSkillShareLinkParams {
  organizationId: string;
  createdByUserId: string;
  skillIds: string[];
  marketplaceName: string;
  name?: string | null;
  expiresAt?: Date | null;
}

interface CreateSkillShareLinkResult {
  link: SkillShareLinkWithSkills;
  rawToken: string;
}

interface ValidateSkillShareLinkResult {
  link: SkillShareLink;
  skills: SkillShareLinkSkillSummary[];
}

class SkillShareLinkModel {
  static async create(
    params: CreateSkillShareLinkParams,
  ): Promise<CreateSkillShareLinkResult> {
    if (params.skillIds.length === 0) {
      throw new Error("skillIds must be non-empty");
    }

    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);
    const tokenStart = rawToken.slice(0, TOKEN_START_LENGTH);

    const link = await withDbTransaction(async (tx) => {
      const [created] = await tx
        .insert(schema.skillShareLinksTable)
        .values({
          organizationId: params.organizationId,
          createdByUserId: params.createdByUserId,
          tokenHash,
          tokenStart,
          name: params.name ?? null,
          marketplaceName: params.marketplaceName,
          expiresAt: params.expiresAt ?? null,
        })
        .returning();

      const uniqueSkillIds = Array.from(new Set(params.skillIds));
      await tx.insert(schema.skillShareLinkSkillsTable).values(
        uniqueSkillIds.map((skillId) => ({
          shareLinkId: created.id,
          skillId,
        })),
      );

      return created;
    });

    const skills = await loadSkillsForLinks([link.id]);
    return {
      link: { ...link, skills: skills.get(link.id) ?? [] },
      rawToken,
    };
  }

  static async findById(id: string): Promise<SkillShareLink | null> {
    const [row] = await db
      .select()
      .from(schema.skillShareLinksTable)
      .where(eq(schema.skillShareLinksTable.id, id))
      .limit(1);
    return row ?? null;
  }

  static async listByOrganization(params: {
    organizationId: string;
    skillId?: string;
  }): Promise<SkillShareLinkWithSkills[]> {
    const filters = [
      eq(schema.skillShareLinksTable.organizationId, params.organizationId),
    ];

    if (params.skillId) {
      const matching = await db
        .selectDistinct({
          shareLinkId: schema.skillShareLinkSkillsTable.shareLinkId,
        })
        .from(schema.skillShareLinkSkillsTable)
        .where(eq(schema.skillShareLinkSkillsTable.skillId, params.skillId));

      if (matching.length === 0) return [];
      filters.push(
        inArray(
          schema.skillShareLinksTable.id,
          matching.map((row) => row.shareLinkId),
        ),
      );
    }

    const links = await db
      .select()
      .from(schema.skillShareLinksTable)
      .where(and(...filters))
      .orderBy(desc(schema.skillShareLinksTable.createdAt));

    if (links.length === 0) return [];

    const skillsByLink = await loadSkillsForLinks(links.map((row) => row.id));
    return links.map((link) => ({
      ...link,
      skills: skillsByLink.get(link.id) ?? [],
    }));
  }

  /**
   * Looks up a link by the raw token. Returns null on miss, revocation, or
   * expiration — callers cannot tell those cases apart from the result.
   * `lastUsedAt` is updated fire-and-forget; do not await the response.
   */
  static async validate(params: {
    rawToken: string;
  }): Promise<ValidateSkillShareLinkResult | null> {
    const tokenHash = hashToken(params.rawToken);
    const [link] = await db
      .select()
      .from(schema.skillShareLinksTable)
      .where(eq(schema.skillShareLinksTable.tokenHash, tokenHash))
      .limit(1);

    if (!link) return null;
    if (link.revokedAt) return null;
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) return null;

    const skillsByLink = await loadSkillsForLinks([link.id]);

    // fire-and-forget last-used bookkeeping; do not block the response.
    // explicitly preserve updatedAt to prevent drizzle's $onUpdate hook from
    // bumping it on a non-admin access. WHERE re-checks revokedAt so a
    // racing revoke between SELECT and UPDATE doesn't push lastUsedAt past
    // revokedAt and break the audit invariant.
    void db
      .update(schema.skillShareLinksTable)
      .set({ lastUsedAt: new Date(), updatedAt: link.updatedAt })
      .where(
        and(
          eq(schema.skillShareLinksTable.id, link.id),
          isNull(schema.skillShareLinksTable.revokedAt),
        ),
      )
      .catch((err: unknown) => {
        logger.warn(
          { err, shareLinkId: link.id },
          "skillShareLink.validate: failed to update lastUsedAt",
        );
      });

    return { link, skills: skillsByLink.get(link.id) ?? [] };
  }

  /** Returns IDs of non-revoked, non-expired links. Used for orphan repo sweeps at startup. */
  static async listActiveIds(): Promise<string[]> {
    const now = new Date();
    const rows = await db
      .select({ id: schema.skillShareLinksTable.id })
      .from(schema.skillShareLinksTable)
      .where(
        and(
          isNull(schema.skillShareLinksTable.revokedAt),
          or(
            isNull(schema.skillShareLinksTable.expiresAt),
            gt(schema.skillShareLinksTable.expiresAt, now),
          ),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** Idempotent: revoking an already-revoked link is a no-op. */
  static async revoke(params: {
    id: string;
    organizationId: string;
  }): Promise<SkillShareLink | null> {
    const [updated] = await db
      .update(schema.skillShareLinksTable)
      .set({
        revokedAt: sql`COALESCE(${schema.skillShareLinksTable.revokedAt}, NOW())`,
      })
      .where(
        and(
          eq(schema.skillShareLinksTable.id, params.id),
          eq(schema.skillShareLinksTable.organizationId, params.organizationId),
        ),
      )
      .returning();

    return updated ?? null;
  }
}

export default SkillShareLinkModel;

function generateRawToken(): string {
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  return `${SKILL_SHARE_LINK_TOKEN_PREFIX}${random}`;
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

async function loadSkillsForLinks(
  linkIds: string[],
): Promise<Map<string, SkillShareLinkSkillSummary[]>> {
  const map = new Map<string, SkillShareLinkSkillSummary[]>();
  if (linkIds.length === 0) return map;

  const rows = await db
    .select({
      shareLinkId: schema.skillShareLinkSkillsTable.shareLinkId,
      id: schema.skillsTable.id,
      name: schema.skillsTable.name,
      description: schema.skillsTable.description,
    })
    .from(schema.skillShareLinkSkillsTable)
    .innerJoin(
      schema.skillsTable,
      eq(schema.skillShareLinkSkillsTable.skillId, schema.skillsTable.id),
    )
    .where(inArray(schema.skillShareLinkSkillsTable.shareLinkId, linkIds))
    .orderBy(schema.skillsTable.name);

  for (const row of rows) {
    const list = map.get(row.shareLinkId);
    if (list) {
      list.push({ id: row.id, name: row.name, description: row.description });
    } else {
      map.set(row.shareLinkId, [
        { id: row.id, name: row.name, description: row.description },
      ]);
    }
  }
  return map;
}
