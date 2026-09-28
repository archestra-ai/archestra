import fs from "node:fs";
import path from "node:path";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const statements = fs
  .readFileSync(
    path.join(__dirname, "0493_assign-openappa-recovery-tools.sql"),
    "utf8",
  )
  .split("--> statement-breakpoint")
  .map((part) =>
    part
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim(),
  );

test("backfills recovery assignments and clears existing exclusions", async ({
  makeOrganization,
}) => {
  await db.insert(schema.internalMcpCatalogTable).values({
    id: ARCHESTRA_MCP_CATALOG_ID,
    name: "Archestra",
    serverType: "builtin",
  });
  const org = await makeOrganization();
  const [agent, gateway] = await db
    .insert(schema.agentsTable)
    .values([
      {
        organizationId: org.id,
        name: "Test agent",
        agentType: "agent",
        scope: "org",
      },
      {
        organizationId: org.id,
        name: "Test gateway",
        agentType: "mcp_gateway",
        scope: "org",
      },
    ])
    .returning();
  const tools = await db
    .insert(schema.toolsTable)
    .values(
      ["get_remedy_plans", "execute_remedy_plan", "yell"].map((name) => ({
        name: `branded__${name}`,
        parameters: {},
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
      })),
    )
    .returning();
  await db.insert(schema.agentExcludedToolsTable).values({
    agentId: gateway.id,
    toolId: tools[0].id,
  });

  for (const statement of statements) await db.execute(sql.raw(statement));
  for (const statement of statements) await db.execute(sql.raw(statement));

  for (const resource of [agent, gateway]) {
    const assignments = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, resource.id));
    expect(assignments.map((row) => row.toolId).sort()).toEqual(
      tools.map((tool) => tool.id).sort(),
    );
  }
  const exclusions = await db
    .select()
    .from(schema.agentExcludedToolsTable)
    .where(eq(schema.agentExcludedToolsTable.agentId, gateway.id));
  expect(exclusions).toEqual([]);
});
