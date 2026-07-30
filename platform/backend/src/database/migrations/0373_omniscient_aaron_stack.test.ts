import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0373_omniscient_aaron_stack.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes("UPDATE"));

  if (statements.length === 0) {
    throw new Error("Migration statements not found");
  }

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function isPlaceholder(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ flag: schema.conversationsTable.titleIsPlaceholder })
    .from(schema.conversationsTable)
    .where(eq(schema.conversationsTable.id, conversationId));

  return row.flag;
}

/** A conversation row written straight to the table, bypassing model defaults. */
async function insertConversation(params: {
  userId: string;
  organizationId: string;
  agentId: string;
  title: string;
  origin: "user" | "app_open" | "schedule_trigger";
}): Promise<string> {
  const [row] = await db
    .insert(schema.conversationsTable)
    .values({ ...params, titleIsPlaceholder: false })
    .returning({ id: schema.conversationsTable.id });

  return row.id;
}

async function insertOwnedAppRender(conversationId: string, appName: string) {
  await db.insert(schema.messagesTable).values({
    conversationId,
    role: "assistant",
    content: {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "render_app",
          toolCallId: "call-1",
          state: "output-available",
          input: { appId: "app-1" },
          output: { structuredContent: { name: appName } },
        },
      ],
    },
  });
}

async function insertExternalAppRender(conversationId: string, label: string) {
  await db.insert(schema.messagesTable).values({
    conversationId,
    role: "assistant",
    content: {
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "some_ui_tool",
          toolCallId: "call-1",
          state: "output-available",
          input: {},
          output: {
            content: `${label}\nWill render inline when opened in chat.`,
          },
        },
      ],
    },
  });
}

async function insertUserMessage(conversationId: string, text: string) {
  await db.insert(schema.messagesTable).values({
    conversationId,
    role: "user",
    content: { role: "user", parts: [{ type: "text", text }] },
  });
}

describe("0373 migration: mark seeded app-chat titles as placeholders", () => {
  test("marks an app chat that has no user message yet", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Agent", teams: [] });

    const id = await insertConversation({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Expense Tracker",
      origin: "app_open",
    });
    await insertOwnedAppRender(id, "Expense Tracker");

    await runMigration();

    expect(await isPlaceholder(id)).toBe(true);
  });

  test("marks an owned app chat whose title still matches the seeded app name", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Agent", teams: [] });

    const id = await insertConversation({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Expense Tracker",
      origin: "app_open",
    });
    await insertOwnedAppRender(id, "Expense Tracker");
    await insertUserMessage(id, "Add a budget column");

    await runMigration();

    expect(await isPlaceholder(id)).toBe(true);
  });

  test("marks an external app chat titled with the seeded label", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Agent", teams: [] });

    const id = await insertConversation({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Weather Server",
      origin: "app_open",
    });
    await insertExternalAppRender(id, "Weather Server");
    await insertUserMessage(id, "Forecast for Berlin");

    await runMigration();

    expect(await isPlaceholder(id)).toBe(true);
  });

  test("leaves a renamed app chat alone", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    // The whole point of the two-branch predicate: a chat the user already
    // renamed must not be retitled out from under them.
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Agent", teams: [] });

    const id = await insertConversation({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Q3 budget planning",
      origin: "app_open",
    });
    await insertOwnedAppRender(id, "Expense Tracker");
    await insertUserMessage(id, "Add a budget column");

    await runMigration();

    expect(await isPlaceholder(id)).toBe(false);
  });

  test("leaves ordinary and scheduled-run conversations alone", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Agent", teams: [] });

    const ordinary = await insertConversation({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Some chat",
      origin: "user",
    });
    const scheduled = await insertConversation({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Daily digest",
      origin: "schedule_trigger",
    });

    await runMigration();

    expect(await isPlaceholder(ordinary)).toBe(false);
    expect(await isPlaceholder(scheduled)).toBe(false);
  });
});
