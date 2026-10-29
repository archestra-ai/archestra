import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0504_reflective_cargill.sql"),
  "utf-8",
);

describe("0504 progressive loading defaults", () => {
  test("backfills only disabled Manual agents and gateways and is idempotent", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    // Insert historical values directly: the model normalizes All-mode rows.
    const before = [];
    for (const agentType of ["agent", "mcp_gateway", "llm_proxy"] as const) {
      for (const accessAllTools of [false, true]) {
        for (const toolExposureMode of [
          "full",
          "search_and_run_only",
        ] as const) {
          const [agent] = await db
            .insert(schema.agentsTable)
            .values({
              name: `${agentType}-${accessAllTools}-${toolExposureMode}`,
              agentType,
              organizationId: organization.id,
              authorId: user.id,
              accessAllTools,
              toolExposureMode,
            })
            .returning();
          before.push(agent);
        }
      }
    }
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      await db.execute(sql.raw(statement));
    }
    const after = await db.select().from(schema.agentsTable);
    for (const agent of before) {
      expect(after.find((row) => row.id === agent.id)).toEqual({
        ...agent,
        toolExposureMode:
          agent.agentType !== "llm_proxy" && !agent.accessAllTools
            ? "search_and_run_only"
            : agent.toolExposureMode,
      });
    }
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      await db.execute(sql.raw(statement));
    }
    expect(await db.select().from(schema.agentsTable)).toEqual(after);
  });

  test.for([
    "agent",
    "mcp_gateway",
  ] as const)("defaults direct inserts of new Manual %s to progressive loading", async (agentType, {
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    // Exercise the database default independently of Drizzle's application default.
    await db.execute(
      sql`ALTER TABLE agents ALTER COLUMN tool_exposure_mode SET DEFAULT 'full'`,
    );
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      await db.execute(sql.raw(statement));
    }
    const result = await db.execute<{
      access_all_tools: boolean;
      tool_exposure_mode: string;
    }>(sql`INSERT INTO agents (name, agent_type, organization_id)
      VALUES (${`New ${agentType}`}, ${agentType}, ${organization.id})
      RETURNING access_all_tools, tool_exposure_mode`);
    expect(result.rows[0].access_all_tools).toBe(false);
    expect(result.rows[0].tool_exposure_mode).toBe("search_and_run_only");
  });
});
