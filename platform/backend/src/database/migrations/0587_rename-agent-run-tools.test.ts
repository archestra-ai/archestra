import fs from "node:fs";
import path from "node:path";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const statements = fs
  .readFileSync(path.join(__dirname, "0587_rename-agent-run-tools.sql"), "utf8")
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

// The mapping is a session-scoped temp table, and the suite shares one PGlite
// connection, so drop it after each replay as the migrator's disconnect would.
async function migrate() {
  for (const statement of statements) await db.execute(sql.raw(statement));
  await db.execute(sql.raw('DROP TABLE IF EXISTS "_agent_run_tool_renames"'));
}

async function insertBuiltinTools(names: string[]) {
  await db
    .insert(schema.internalMcpCatalogTable)
    .values({
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: "Archestra",
      serverType: "builtin",
    })
    .onConflictDoNothing();
  const rows = await db
    .insert(schema.toolsTable)
    .values(
      names.map((name) => ({
        name,
        parameters: {},
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
      })),
    )
    .returning();
  return Object.fromEntries(rows.map((row) => [row.name, row.id]));
}

async function toolNames(ids: string[]) {
  const rows = await db
    .select({ id: schema.toolsTable.id, name: schema.toolsTable.name })
    .from(schema.toolsTable)
    .where(inArray(schema.toolsTable.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

async function agentToolIds(agentId: string) {
  return (
    await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agentId))
  ).map((row) => row.toolId);
}

async function excludedToolIds(agentId: string) {
  return (
    await db
      .select({ toolId: schema.agentExcludedToolsTable.toolId })
      .from(schema.agentExcludedToolsTable)
      .where(eq(schema.agentExcludedToolsTable.agentId, agentId))
  ).map((row) => row.toolId);
}

describe("0586 renames the agent-run tools", () => {
  test("renames each tool in place under its own prefix, keeping its id and assignments", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const ids = await insertBuiltinTools([
      "archestra__start_run",
      "archestra__get_run",
      "acme__steer_run",
      "archestra__cancel_run",
      "archestra__post_run_message",
      "acme__post_run_file",
    ]);
    await db.insert(schema.agentToolsTable).values({
      agentId: agent.id,
      toolId: ids.archestra__start_run,
    });
    await db.insert(schema.agentExcludedToolsTable).values({
      agentId: agent.id,
      toolId: ids.acme__steer_run,
    });

    await migrate();

    expect(await toolNames(Object.values(ids))).toEqual({
      [ids.archestra__start_run]: "archestra__start_agent_run",
      [ids.archestra__get_run]: "archestra__get_agent_run",
      [ids.acme__steer_run]: "acme__steer_agent_run",
      [ids.archestra__cancel_run]: "archestra__cancel_agent_run",
      [ids.archestra__post_run_message]: "archestra__post_agent_run_message",
      [ids.acme__post_run_file]: "acme__post_agent_run_file",
    });
    expect(await agentToolIds(agent.id)).toEqual([ids.archestra__start_run]);
    expect(await excludedToolIds(agent.id)).toEqual([ids.acme__steer_run]);
  });

  test("folds list_runs into list_agent_runs and deletes it", async ({
    makeAgent,
    makeApp,
    makeConversation,
  }) => {
    const both = await makeAgent();
    const onlyOld = await makeAgent();
    const excludedOld = await makeAgent();
    const excludedNew = await makeAgent();
    const excludedBoth = await makeAgent();
    const app = await makeApp();
    const conversation = await makeConversation(both.id);
    const ids = await insertBuiltinTools([
      "archestra__list_runs",
      "archestra__list_agent_runs",
    ]);
    const oldId = ids.archestra__list_runs;
    const newId = ids.archestra__list_agent_runs;
    await db.insert(schema.agentToolsTable).values([
      { agentId: both.id, toolId: oldId },
      { agentId: both.id, toolId: newId },
      { agentId: onlyOld.id, toolId: oldId },
    ]);
    await db.insert(schema.appToolsTable).values({
      appId: app.id,
      toolId: oldId,
    });
    await db.insert(schema.conversationEnabledToolsTable).values([
      { conversationId: conversation.id, toolId: oldId },
      { conversationId: conversation.id, toolId: newId },
    ]);
    await db.insert(schema.agentExcludedToolsTable).values([
      { agentId: excludedOld.id, toolId: oldId },
      { agentId: excludedNew.id, toolId: newId },
      { agentId: excludedBoth.id, toolId: oldId },
      { agentId: excludedBoth.id, toolId: newId },
    ]);

    await migrate();

    expect(await toolNames([oldId, newId])).toEqual({
      [newId]: "archestra__list_agent_runs",
    });
    expect(await agentToolIds(both.id)).toEqual([newId]);
    expect(await agentToolIds(onlyOld.id)).toEqual([newId]);
    expect(
      (
        await db
          .select({ toolId: schema.appToolsTable.toolId })
          .from(schema.appToolsTable)
          .where(eq(schema.appToolsTable.appId, app.id))
      ).map((row) => row.toolId),
    ).toEqual([newId]);
    expect(
      (
        await db
          .select({ toolId: schema.conversationEnabledToolsTable.toolId })
          .from(schema.conversationEnabledToolsTable)
          .where(
            eq(
              schema.conversationEnabledToolsTable.conversationId,
              conversation.id,
            ),
          )
      ).map((row) => row.toolId),
    ).toEqual([newId]);
    expect({
      excludedOld: await excludedToolIds(excludedOld.id),
      excludedNew: await excludedToolIds(excludedNew.id),
      excludedBoth: await excludedToolIds(excludedBoth.id),
    }).toEqual({ excludedOld: [], excludedNew: [], excludedBoth: [newId] });
  });

  test("renames list_runs in place when list_agent_runs does not exist yet", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    const ids = await insertBuiltinTools(["acme__list_runs"]);
    await db.insert(schema.agentToolsTable).values({
      agentId: agent.id,
      toolId: ids.acme__list_runs,
    });

    await migrate();

    expect(await toolNames([ids.acme__list_runs])).toEqual({
      [ids.acme__list_runs]: "acme__list_agent_runs",
    });
    expect(await agentToolIds(agent.id)).toEqual([ids.acme__list_runs]);
  });

  test("rewrites tool-call limits to the new names, keeping an existing list_agent_runs limit", async ({
    makeAgent,
  }) => {
    const renamed = await makeAgent();
    const merged = await makeAgent();
    await insertBuiltinTools([
      "archestra__start_run",
      "archestra__list_runs",
      "archestra__list_agent_runs",
    ]);
    const toolCalls = (
      entityId: string,
      toolName: string,
      limitValue: number,
      mcpServerName = "archestra",
    ) => ({
      entityType: "agent" as const,
      entityId,
      limitType: "tool_calls" as const,
      limitValue,
      mcpServerName,
      toolName,
    });
    await db
      .insert(schema.limitsTable)
      .values([
        toolCalls(renamed.id, "archestra__start_run", 1),
        toolCalls(renamed.id, "archestra__list_runs", 2),
        toolCalls(merged.id, "archestra__list_runs", 3),
        toolCalls(merged.id, "archestra__list_agent_runs", 4),
        toolCalls(merged.id, "github__list_runs", 5, "github"),
      ]);

    await migrate();

    const rows = await db
      .select({
        entityId: schema.limitsTable.entityId,
        toolName: schema.limitsTable.toolName,
        limitValue: schema.limitsTable.limitValue,
      })
      .from(schema.limitsTable);
    expect(rows.sort((a, b) => a.limitValue - b.limitValue)).toEqual([
      {
        entityId: renamed.id,
        toolName: "archestra__start_agent_run",
        limitValue: 1,
      },
      {
        entityId: renamed.id,
        toolName: "archestra__list_agent_runs",
        limitValue: 2,
      },
      {
        entityId: merged.id,
        toolName: "archestra__list_agent_runs",
        limitValue: 4,
      },
      { entityId: merged.id, toolName: "github__list_runs", limitValue: 5 },
    ]);
  });
});
