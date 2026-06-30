import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_METADATA_SESSION_SOURCE,
  LEGACY_CLAUDE_CODE_SESSION_SOURCE,
  LEGACY_CLAUDE_DESKTOP_SESSION_SOURCE,
} from "@archestra/shared";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0321_backfill-claude-client-external-agent-id.sql"),
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

async function insertInteraction(params: {
  sessionSource: string | null;
  externalAgentId: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(schema.interactionsTable)
    .values({
      type: "anthropic:messages",
      sessionSource: params.sessionSource,
      externalAgentId: params.externalAgentId,
      request: {} as never,
      response: {} as never,
    })
    .returning({ id: schema.interactionsTable.id });
  return row.id;
}

async function getExternalAgentId(id: string): Promise<string | null> {
  const [row] = await db
    .select({ externalAgentId: schema.interactionsTable.externalAgentId })
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, id));
  return row.externalAgentId;
}

describe("0321 migration: backfill Claude client external_agent_id", () => {
  test("backfills legacy claude_code / claude_desktop rows to the generic Claude client id", async () => {
    const codeId = await insertInteraction({
      sessionSource: LEGACY_CLAUDE_CODE_SESSION_SOURCE,
      externalAgentId: null,
    });
    const desktopId = await insertInteraction({
      sessionSource: LEGACY_CLAUDE_DESKTOP_SESSION_SOURCE,
      externalAgentId: null,
    });

    await runMigration();

    expect(await getExternalAgentId(codeId)).toBe(CLAUDE_CLIENT_ID);
    expect(await getExternalAgentId(desktopId)).toBe(CLAUDE_CLIENT_ID);
  });

  test("never overwrites a caller-supplied external_agent_id", async () => {
    const labelledId = await insertInteraction({
      sessionSource: LEGACY_CLAUDE_CODE_SESSION_SOURCE,
      externalAgentId: "my-agent",
    });

    await runMigration();

    expect(await getExternalAgentId(labelledId)).toBe("my-agent");
  });

  test("leaves non-legacy and non-Claude session sources untouched", async () => {
    // claude_metadata is introduced by this change and, in practice, is never
    // written with a null external_agent_id: the proxy sets session_source and
    // external_agent_id in the same pass, and a claude_metadata match implies a
    // Claude client id (auto-discovery returns anthropic_claude for the same
    // metadata.user_id). So the row below is synthetic — the backfill is scoped
    // to the legacy values and correctly leaves it untouched.
    const metadataId = await insertInteraction({
      sessionSource: CLAUDE_METADATA_SESSION_SOURCE,
      externalAgentId: null,
    });
    const headerId = await insertInteraction({
      sessionSource: "header",
      externalAgentId: null,
    });

    await runMigration();

    expect(await getExternalAgentId(metadataId)).toBeNull();
    expect(await getExternalAgentId(headerId)).toBeNull();
  });
});
