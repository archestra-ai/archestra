import fs from "node:fs";
import path from "node:path";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0285_dedup_archestra_builtin_tools_by_short_name.sql"),
  "utf-8",
);

// Migration statements split on the breakpoint, with comment lines stripped.
const STATEMENTS = migrationSql
  .split("--> statement-breakpoint")
  .map((chunk) =>
    chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter((chunk) => chunk.length > 0);

async function runDedup(): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}

async function builtInRowsForShortName(shortName: string) {
  const rows = await db
    .select()
    .from(schema.toolsTable)
    .where(
      and(
        eq(schema.toolsTable.catalogId, ARCHESTRA_MCP_CATALOG_ID),
        isNull(schema.toolsTable.agentId),
      ),
    );
  return rows.filter((row) => row.name.replace(/^.*__/, "") === shortName);
}

describe("0285 migration: dedupe Archestra built-in tools by short name", () => {
  test("collapses legacy/branded prefix duplicates, repoints assignments, adopts latest description", async ({
    makeAgent,
    makeConversation,
  }) => {
    await db.insert(schema.internalMcpCatalogTable).values({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
    });

    // Two rows that share the short name "whoami" but differ in branded prefix.
    // Distinct full names, so they never tripped the (catalog_id, name) index.
    const [legacy] = await db
      .insert(schema.toolsTable)
      .values({
        name: "archestra__whoami",
        parameters: {},
        description: "stale description",
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    const [branded] = await db
      .insert(schema.toolsTable)
      .values({
        name: "acme__whoami",
        parameters: {},
        description: "current description",
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      })
      .returning();

    const agent = await makeAgent();
    // Assign the LOSER (branded) — dedup must repoint to the survivor (oldest).
    await db
      .insert(schema.agentToolsTable)
      .values({ agentId: agent.id, toolId: branded.id });
    const conversation = await makeConversation(agent.id);
    await db
      .insert(schema.conversationEnabledToolsTable)
      .values({ conversationId: conversation.id, toolId: branded.id });

    await runDedup();

    const survivors = await builtInRowsForShortName("whoami");
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe(legacy.id);
    expect(survivors[0].description).toBe("current description");

    const assignments = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agent.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].toolId).toBe(legacy.id);

    const enabled = await db
      .select()
      .from(schema.conversationEnabledToolsTable)
      .where(
        eq(
          schema.conversationEnabledToolsTable.conversationId,
          conversation.id,
        ),
      );
    expect(enabled).toHaveLength(1);
    expect(enabled[0].toolId).toBe(legacy.id);
  });

  test("collapses three+ prefix siblings when an agent/conversation holds multiple losers", async ({
    makeAgent,
    makeConversation,
  }) => {
    await db.insert(schema.internalMcpCatalogTable).values({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
    });

    const insertSibling = async (name: string, createdAt: string) => {
      const [row] = await db
        .insert(schema.toolsTable)
        .values({
          name,
          parameters: {},
          catalogId: ARCHESTRA_MCP_CATALOG_ID,
          agentId: null,
          createdAt: new Date(createdAt),
        })
        .returning();
      return row;
    };

    // Three prefixes for the same short name (install cycled white-label brands).
    const survivor = await insertSibling(
      "archestra__whoami",
      "2026-01-01T00:00:00Z",
    );
    const loserA = await insertSibling("acme__whoami", "2026-02-01T00:00:00Z");
    const loserB = await insertSibling("beta__whoami", "2026-03-01T00:00:00Z");

    const agent = await makeAgent();
    // Agent holds BOTH losers but not the survivor: naive repoint would rewrite
    // both to the survivor id and violate unique(agent_id, tool_id).
    await db.insert(schema.agentToolsTable).values([
      { agentId: agent.id, toolId: loserA.id },
      { agentId: agent.id, toolId: loserB.id },
    ]);
    const conversation = await makeConversation(agent.id);
    await db.insert(schema.conversationEnabledToolsTable).values([
      { conversationId: conversation.id, toolId: loserA.id },
      { conversationId: conversation.id, toolId: loserB.id },
    ]);

    await runDedup();

    const survivors = await builtInRowsForShortName("whoami");
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe(survivor.id);

    const assignments = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agent.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].toolId).toBe(survivor.id);

    const enabled = await db
      .select()
      .from(schema.conversationEnabledToolsTable)
      .where(
        eq(
          schema.conversationEnabledToolsTable.conversationId,
          conversation.id,
        ),
      );
    expect(enabled).toHaveLength(1);
    expect(enabled[0].toolId).toBe(survivor.id);
  });

  test("drops the redundant agent assignment when the agent already holds the survivor", async ({
    makeAgent,
  }) => {
    await db.insert(schema.internalMcpCatalogTable).values({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
    });

    const [legacy] = await db
      .insert(schema.toolsTable)
      .values({
        name: "archestra__whoami",
        parameters: {},
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    const [branded] = await db
      .insert(schema.toolsTable)
      .values({
        name: "acme__whoami",
        parameters: {},
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      })
      .returning();

    const agent = await makeAgent();
    // Agent holds BOTH copies; the loser assignment must be dropped, not duplicated.
    await db.insert(schema.agentToolsTable).values([
      { agentId: agent.id, toolId: legacy.id },
      { agentId: agent.id, toolId: branded.id },
    ]);

    await runDedup();

    const assignments = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agent.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].toolId).toBe(legacy.id);
  });
});
