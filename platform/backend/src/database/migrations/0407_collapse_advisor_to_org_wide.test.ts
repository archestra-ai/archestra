import fs from "node:fs";
import path from "node:path";
import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { InteractionRequest, InteractionResponse } from "@/types";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0407_collapse_advisor_to_org_wide.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(
      (statement) => statement.length > 0 && !statement.startsWith("SET"),
    );

  if (statements.length === 0) {
    throw new Error("Migration statements not found");
  }

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function makeAdvisorRow(params: {
  organizationId: string;
  environmentId?: string | null;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(schema.agentsTable)
    .values({
      organizationId: params.organizationId,
      name: "Advisor",
      agentType: "agent",
      scope: "org",
      systemPrompt: "advisor prompt",
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.ADVISOR },
      environmentId: params.environmentId ?? null,
    })
    .returning({ id: schema.agentsTable.id });
  return row;
}

async function makeEnvironment(organizationId: string, name: string) {
  const [row] = await db
    .insert(schema.environmentsTable)
    .values({ organizationId, name })
    .returning({ id: schema.environmentsTable.id });
  return row;
}

async function liveAdvisorIds(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.agentsTable.id })
    .from(schema.agentsTable)
    .where(
      and(
        eq(schema.agentsTable.organizationId, organizationId),
        sql`${schema.agentsTable.builtInAgentConfig}->>'name' = ${BUILT_IN_AGENT_IDS.ADVISOR}`,
        isNull(schema.agentsTable.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

async function agentIsRetired(id: string): Promise<boolean> {
  const [row] = await db
    .select({ deletedAt: schema.agentsTable.deletedAt })
    .from(schema.agentsTable)
    .where(eq(schema.agentsTable.id, id));
  return row?.deletedAt != null;
}

describe("0407 collapse advisor to org-wide", () => {
  test("soft-deletes every environment-scoped advisor and keeps the org-wide row", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const envA = await makeEnvironment(org.id, "env-a");
    const envB = await makeEnvironment(org.id, "env-b");

    const orgAdvisor = await makeAdvisorRow({ organizationId: org.id });
    const envAdvisorA = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: envA.id,
    });
    const envAdvisorB = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: envB.id,
    });

    await runMigration();

    expect(await liveAdvisorIds(org.id)).toEqual([orgAdvisor.id]);
    expect(await agentIsRetired(envAdvisorA.id)).toBe(true);
    expect(await agentIsRetired(envAdvisorB.id)).toBe(true);
  });

  test("leaves each retired row's interaction history attributed in place", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await makeEnvironment(org.id, "env");

    await makeAdvisorRow({ organizationId: org.id });
    const envAdvisor = await makeAdvisorRow({
      organizationId: org.id,
      environmentId: env.id,
    });

    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values({
        request: { model: "m", messages: [] } as unknown as InteractionRequest,
        response: { id: "r1" } as unknown as InteractionResponse,
        type: "anthropic:messages",
        profileId: envAdvisor.id,
        environmentId: env.id,
      })
      .returning({ id: schema.interactionsTable.id });

    await runMigration();

    expect(await agentIsRetired(envAdvisor.id)).toBe(true);
    // Soft delete keeps the row, so its history stays attributable — the
    // profile pointer and environment snapshot are untouched.
    const [row] = await db
      .select({
        profileId: schema.interactionsTable.profileId,
        environmentId: schema.interactionsTable.environmentId,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, interaction.id));
    expect(row.profileId).toBe(envAdvisor.id);
    expect(row.environmentId).toBe(env.id);
  });

  test("leaves other organizations and non-advisor agents untouched", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const envA = await makeEnvironment(orgA.id, "env-a");

    const advisorA = await makeAdvisorRow({ organizationId: orgA.id });
    const envAdvisorA = await makeAdvisorRow({
      organizationId: orgA.id,
      environmentId: envA.id,
    });
    const advisorB = await makeAdvisorRow({ organizationId: orgB.id });
    // An ordinary env-scoped agent must not be mistaken for an advisor.
    const regular = await makeAgent({
      organizationId: orgA.id,
      environmentId: envA.id,
      name: "Regular env agent",
    });

    await runMigration();

    expect(await liveAdvisorIds(orgA.id)).toEqual([advisorA.id]);
    expect(await liveAdvisorIds(orgB.id)).toEqual([advisorB.id]);
    expect(await agentIsRetired(envAdvisorA.id)).toBe(true);
    expect(await agentIsRetired(regular.id)).toBe(false);
  });
});
