import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { AgentType, ToolExposureMode } from "@/types/agent";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0311_backfill_gateway_dynamic_tool_access.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length === 0) {
    throw new Error("Migration statement not found");
  }

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function insertAgent(params: {
  organizationId: string;
  agentType: AgentType;
  toolExposureMode: ToolExposureMode;
  accessAllTools: boolean;
  deleted?: boolean;
}): Promise<string> {
  // Insert directly to control the exact pre-migration row state, bypassing the
  // coercion AgentModel.create applies.
  const [agent] = await db
    .insert(schema.agentsTable)
    .values({
      organizationId: params.organizationId,
      name: `Migration test agent ${crypto.randomUUID().substring(0, 8)}`,
      agentType: params.agentType,
      toolExposureMode: params.toolExposureMode,
      accessAllTools: params.accessAllTools,
      deletedAt: params.deleted ? new Date() : null,
    })
    .returning({ id: schema.agentsTable.id });
  return agent.id;
}

async function getAccessAllTools(agentId: string): Promise<boolean> {
  const [agent] = await db
    .select({ accessAllTools: schema.agentsTable.accessAllTools })
    .from(schema.agentsTable)
    .where(eq(schema.agentsTable.id, agentId));
  return agent.accessAllTools;
}

describe("0311 migration: backfill gateway dynamic tool access", () => {
  test("flips only live search_and_run_only gateways, leaving other rows untouched", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // The one row the migration must flip.
    const targetGateway = await insertAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
      accessAllTools: false,
    });

    // Rows that must stay exactly as they are.
    const fullModeGateway = await insertAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "full",
      accessAllTools: false,
    });
    const alreadyOnGateway = await insertAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
      accessAllTools: true,
    });
    const internalAgent = await insertAgent({
      organizationId: org.id,
      agentType: "agent",
      toolExposureMode: "search_and_run_only",
      accessAllTools: false,
    });
    const llmProxy = await insertAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
      toolExposureMode: "search_and_run_only",
      accessAllTools: false,
    });
    const profile = await insertAgent({
      organizationId: org.id,
      agentType: "profile",
      toolExposureMode: "search_and_run_only",
      accessAllTools: false,
    });
    const deletedGateway = await insertAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
      accessAllTools: false,
      deleted: true,
    });

    await runMigration();

    expect(await getAccessAllTools(targetGateway)).toBe(true);

    expect(await getAccessAllTools(fullModeGateway)).toBe(false);
    expect(await getAccessAllTools(alreadyOnGateway)).toBe(true);
    expect(await getAccessAllTools(internalAgent)).toBe(false);
    expect(await getAccessAllTools(llmProxy)).toBe(false);
    expect(await getAccessAllTools(profile)).toBe(false);
    expect(await getAccessAllTools(deletedGateway)).toBe(false);

    // Re-running is a no-op: the access_all_tools=false predicate excludes
    // already-flipped rows, so nothing else changes.
    await runMigration();
    expect(await getAccessAllTools(targetGateway)).toBe(true);
    expect(await getAccessAllTools(fullModeGateway)).toBe(false);
    expect(await getAccessAllTools(deletedGateway)).toBe(false);
  });
});
