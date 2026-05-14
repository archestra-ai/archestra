import fs from "node:fs";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import LimitModel from "@/models/limit";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0237_regular_goblin_queen.sql"),
  "utf-8",
);

async function runLimitCleanupIntervalBackfill() {
  const statement = migrationSql
    .split("--> statement-breakpoint")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith('UPDATE "limits"'));

  if (!statement) {
    throw new Error("Could not find limits cleanup interval backfill");
  }

  await db.execute(sql.raw(statement));
}

describe("0237 migration: limit cleanup interval backfill", () => {
  test("backfills limit cleanup intervals from the owning organization", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
    makeVirtualApiKey,
  }) => {
    await db.execute(
      sql.raw(`
      ALTER TABLE "organization"
      ADD COLUMN IF NOT EXISTS "limit_cleanup_interval" varchar DEFAULT '1w' NOT NULL
    `),
    );

    try {
      const firstOrg = await makeOrganization();
      const secondOrg = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, firstOrg.id);
      const team = await makeTeam(firstOrg.id, user.id);
      const agent = await makeAgent({ organizationId: firstOrg.id });
      const virtualKey = await makeVirtualApiKey(firstOrg.id);

      await db.execute(sql`
        UPDATE "organization"
        SET "limit_cleanup_interval" = '12h'
        WHERE "id" = ${firstOrg.id}
      `);
      await db.execute(sql`
        UPDATE "organization"
        SET "limit_cleanup_interval" = '1m'
        WHERE "id" = ${secondOrg.id}
      `);

      const organizationLimit = await LimitModel.create({
        entityType: "organization",
        entityId: firstOrg.id,
        limitType: "token_cost",
        limitValue: 100,
        model: null,
        cleanupInterval: "1w",
      });
      const teamLimit = await LimitModel.create({
        entityType: "team",
        entityId: team.id,
        limitType: "token_cost",
        limitValue: 100,
        model: null,
        cleanupInterval: "1w",
      });
      const agentLimit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 100,
        model: null,
        cleanupInterval: "1w",
      });
      const userLimit = await LimitModel.create({
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 100,
        model: null,
        cleanupInterval: "1w",
      });
      const virtualKeyLimit = await LimitModel.create({
        entityType: "virtual_key",
        entityId: virtualKey.id,
        limitType: "token_cost",
        limitValue: 100,
        model: null,
        cleanupInterval: "1w",
      });
      const secondOrganizationLimit = await LimitModel.create({
        entityType: "organization",
        entityId: secondOrg.id,
        limitType: "token_cost",
        limitValue: 100,
        model: null,
        cleanupInterval: "1w",
      });

      await runLimitCleanupIntervalBackfill();

      const limits = await db
        .select({
          id: schema.limitsTable.id,
          cleanupInterval: schema.limitsTable.cleanupInterval,
        })
        .from(schema.limitsTable)
        .where(
          inArray(schema.limitsTable.id, [
            organizationLimit.id,
            teamLimit.id,
            agentLimit.id,
            userLimit.id,
            virtualKeyLimit.id,
            secondOrganizationLimit.id,
          ]),
        );
      const cleanupIntervalByLimitId = new Map(
        limits.map((limit) => [limit.id, limit.cleanupInterval]),
      );

      expect(cleanupIntervalByLimitId.get(organizationLimit.id)).toBe("12h");
      expect(cleanupIntervalByLimitId.get(teamLimit.id)).toBe("12h");
      expect(cleanupIntervalByLimitId.get(agentLimit.id)).toBe("12h");
      expect(cleanupIntervalByLimitId.get(userLimit.id)).toBe("12h");
      expect(cleanupIntervalByLimitId.get(virtualKeyLimit.id)).toBe("12h");
      expect(cleanupIntervalByLimitId.get(secondOrganizationLimit.id)).toBe(
        "1m",
      );
    } finally {
      await db.execute(
        sql.raw(`
        ALTER TABLE "organization"
        DROP COLUMN IF EXISTS "limit_cleanup_interval"
      `),
      );
    }
  });
});
