import fs from "node:fs";
import path from "node:path";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const INDEX_NAME = "tools_archestra_catalog_name_uidx";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0283_safe_hemingway.sql"),
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

const CREATE_INDEX_STATEMENT = STATEMENTS.find((s) =>
  s.startsWith("CREATE UNIQUE INDEX"),
);
if (!CREATE_INDEX_STATEMENT) {
  throw new Error("CREATE UNIQUE INDEX statement not found in 0283");
}

async function runDedup(): Promise<void> {
  for (const statement of STATEMENTS) {
    if (statement.startsWith("CREATE UNIQUE INDEX")) {
      continue;
    }
    await db.execute(sql.raw(statement));
  }
}

async function recreateIndex(): Promise<void> {
  await db.execute(sql.raw(CREATE_INDEX_STATEMENT as string));
}

describe("0283 migration: dedupe Archestra built-in tools", () => {
  test("keeps the oldest row, repoints assignments, adopts the latest description", async ({
    makeAgent,
    makeConversation,
  }) => {
    // The index already exists (applied at suite setup); drop it so duplicates can be staged.
    await db.execute(sql.raw(`DROP INDEX "${INDEX_NAME}"`));

    await db.insert(schema.internalMcpCatalogTable).values({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
    });

    const name = "archestra__whoami";
    const [oldest] = await db
      .insert(schema.toolsTable)
      .values({
        name,
        parameters: {},
        description: "stale description",
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    const [newest] = await db
      .insert(schema.toolsTable)
      .values({
        name,
        parameters: {},
        description: "current description",
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      })
      .returning();

    const agent = await makeAgent();
    // Assign the LOSER (newest) to the agent — dedup must repoint this to the survivor.
    await db
      .insert(schema.agentToolsTable)
      .values({ agentId: agent.id, toolId: newest.id });
    // Enable the LOSER in a conversation — dedup must repoint this too.
    const conversation = await makeConversation(agent.id);
    await db
      .insert(schema.conversationEnabledToolsTable)
      .values({ conversationId: conversation.id, toolId: newest.id });

    // A catalog row with a non-null agent_id is outside the partial index scope and
    // must be left untouched by the dedup.
    const [scopedOut] = await db
      .insert(schema.toolsTable)
      .values({
        name,
        parameters: {},
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: agent.id,
        createdAt: new Date("2026-02-01T00:00:00Z"),
      })
      .returning();

    await runDedup();

    const rows = await db
      .select()
      .from(schema.toolsTable)
      .where(
        and(
          eq(schema.toolsTable.catalogId, ARCHESTRA_MCP_CATALOG_ID),
          eq(schema.toolsTable.name, name),
          isNull(schema.toolsTable.agentId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(oldest.id);
    expect(rows[0].description).toBe("current description");

    const assignments = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agent.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].toolId).toBe(oldest.id);

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
    expect(enabled[0].toolId).toBe(oldest.id);

    // The out-of-scope (non-null agent_id) row survives untouched.
    const scopedOutRow = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, scopedOut.id));
    expect(scopedOutRow).toHaveLength(1);

    // The unique index now builds cleanly against the deduplicated rows, and rejects
    // any further duplicate built-in row.
    await expect(recreateIndex()).resolves.not.toThrow();
    await expect(
      db.insert(schema.toolsTable).values({
        name,
        parameters: {},
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
      }),
    ).rejects.toThrow();
  });

  test("drops the redundant agent assignment when the agent already holds the survivor", async ({
    makeAgent,
  }) => {
    await db.execute(sql.raw(`DROP INDEX "${INDEX_NAME}"`));

    await db.insert(schema.internalMcpCatalogTable).values({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
    });

    const name = "archestra__whoami";
    const [oldest] = await db
      .insert(schema.toolsTable)
      .values({
        name,
        parameters: {},
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    const [newest] = await db
      .insert(schema.toolsTable)
      .values({
        name,
        parameters: {},
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        agentId: null,
        createdAt: new Date("2026-06-01T00:00:00Z"),
      })
      .returning();

    const agent = await makeAgent();
    // Agent holds BOTH copies; the loser assignment must be dropped, not duplicated onto survivor.
    await db.insert(schema.agentToolsTable).values([
      { agentId: agent.id, toolId: oldest.id },
      { agentId: agent.id, toolId: newest.id },
    ]);

    await runDedup();

    const assignments = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agent.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].toolId).toBe(oldest.id);

    await expect(recreateIndex()).resolves.not.toThrow();
  });
});
