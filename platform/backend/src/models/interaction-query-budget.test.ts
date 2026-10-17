import { eq, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import { drainBackgroundWork } from "@/utils/background-work";
import InteractionModel from "./interaction";
import InteractionDeltaManager from "./interaction-delta-manager";

describe("session query budgets", () => {
  let profileId: string;
  beforeEach(async ({ makeAgent }) => {
    profileId = (await makeAgent()).id;
  });

  test("derives a session preview without loading its response payload", async ({
    makeAdmin,
  }) => {
    const admin = await makeAdmin();
    await InteractionModel.create({
      profileId,
      sessionId: "preview-payload-budget",
      request: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Explain this example" }],
      },
      response: {
        id: "large-response",
        object: "chat.completion",
        created: 0,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "x".repeat(1_000_000) },
            finish_reason: "stop",
          },
        ],
      },
      type: "openai:chatCompletions",
    });
    await drainBackgroundWork();

    const { result, statements } = await recordQueries(() =>
      InteractionModel.getSessions({ limit: 100, offset: 0 }, admin.id, true, {
        sessionId: "preview-payload-budget",
      }),
    );

    expect(result.data[0].lastUserMessagePreview).toBe("Explain this example");
    // Response bodies can be megabytes. This is a physical read budget:
    // observing the real queries catches accidental payload expansion even
    // when the resulting preview text remains identical.
    expect(statements.some((statement) => /\bresponse\b/.test(statement))).toBe(
      false,
    );
  });
  test("cold delta previews avoid history reconstruction and legacy rows keep their preview", async ({
    makeAdmin,
  }) => {
    const admin = await makeAdmin();
    const messages = [
      {
        role: "user" as const,
        content: "Keep this human question as the preview",
      },
    ];
    const create = (requestMessages: unknown[]) =>
      InteractionModel.create({
        profileId,
        sessionId: "compact-delta-preview",
        sessionSource: "claude_metadata",
        type: "anthropic:messages",
        request: {
          model: "claude-test",
          max_tokens: 100,
          messages: requestMessages,
        } as never,
        response: {
          id: "synthetic",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "answer" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    await create(messages);
    const tip = await create([
      ...messages,
      { role: "assistant", content: "answer" },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool", content: "tool result" },
        ],
      },
    ]);
    await drainBackgroundWork();
    InteractionDeltaManager.reset();
    const list = () =>
      InteractionModel.getSessions({ limit: 10, offset: 0 }, admin.id, true, {
        sessionId: "compact-delta-preview",
      });
    const compact = await recordQueries(list);
    expect(compact.result.data[0].lastUserMessagePreview).toBe(
      messages[0].content,
    );
    expect(
      compact.statements.some((statement) =>
        /WITH RECURSIVE chain/.test(statement),
      ),
    ).toBe(false);

    // Old rows keep the historical reader, including a human message inherited
    // from the parent of a tool-result-only delta.
    await db
      .update(schema.interactionsTable)
      .set({ sessionPreview: null })
      .where(eq(schema.interactionsTable.id, tip.id));
    InteractionDeltaManager.reset();
    const legacy = await recordQueries(list);
    expect(legacy.result.data[0].lastUserMessagePreview).toBe(
      messages[0].content,
    );
    expect(
      legacy.statements.some((statement) =>
        /WITH RECURSIVE chain/.test(statement),
      ),
    ).toBe(true);
  });

  test("deep pages skip the scan that cannot reach them", async () => {
    for (let index = 0; index < 501; index++) {
      await InteractionModel.create({
        profileId,
        sessionId: `budget-session-${index}`,
        createdAt: new Date(Date.UTC(2021, 0, 1, 0, 0, index)),
        request: { model: "gpt-4", messages: [] },
        response: {
          id: `budget-response-${index}`,
          object: "chat.completion",
          created: index,
          model: "gpt-4",
          choices: [],
        },
        type: "openai:chatCompletions",
      });
    }
    await drainBackgroundWork();

    const findKeys = (
      InteractionModel as unknown as {
        findSessionKeysForPage: (
          where: SQL,
          pagination: { limit: number; offset: number },
          maxScanRows: number,
        ) => Promise<Array<{ sessionId: string | null }>>;
      }
    ).findSessionKeysForPage.bind(InteractionModel);
    const { result, statements } = await recordQueries(() =>
      findKeys(
        eq(schema.interactionsTable.profileId, profileId),
        { limit: 1, offset: 500 },
        500,
      ),
    );
    expect(result.map((row) => row.sessionId)).toEqual(["budget-session-0"]);
    expect(statements).toHaveLength(1);
  });

  test("session previews use the timestamp index at both ends", async () => {
    const fetchWindow = (
      InteractionModel as unknown as {
        fetchSessionWindowRows: (options: {
          sessionKeys: string[];
          uuidKeys: string[];
          newest: number;
          oldest: number;
        }) => Promise<unknown>;
      }
    ).fetchSessionWindowRows.bind(InteractionModel);
    const { statements } = await recordQueries(() =>
      fetchWindow({
        sessionKeys: ["index-preview-session"],
        uuidKeys: [],
        newest: 3,
        oldest: 3,
      }),
    );
    const statement = statements[0]
      .replaceAll("$1", "'index-preview-session'")
      .replaceAll("$2", "3")
      .replaceAll("$3", "3");
    await db.execute(sql`SET enable_seqscan = off`);
    await db.execute(sql`SET enable_bitmapscan = off`);
    try {
      const plan = await db.execute(
        sql.raw(`EXPLAIN (FORMAT JSON) ${statement}`),
      );
      const serialized = JSON.stringify(plan.rows);
      expect(serialized).toContain("interactions_session_created_at_idx");
      // Incremental Sort is bounded to timestamp ties. A full Sort before
      // either LIMIT scans all turns in the session and defeats the window.
      expect(serialized).not.toContain('"Node Type":"Sort"');
    } finally {
      await db.execute(sql`RESET enable_seqscan`);
      await db.execute(sql`RESET enable_bitmapscan`);
    }
  });

  test("cursor heads can use the timestamp index without sorting all history", async () => {
    const findHeads = (
      InteractionModel as unknown as {
        findSessionHeadsForCursor: (
          where: undefined,
          pagination: { limit: number },
        ) => Promise<unknown>;
      }
    ).findSessionHeadsForCursor.bind(InteractionModel);
    const { statements } = await recordQueries(() =>
      findHeads(undefined, { limit: 1 }),
    );
    // Small fixtures normally favor a sequential scan. Compare the available
    // index plan instead; restore the setting after explaining the query.
    await db.execute(sql`SET enable_seqscan = off`);
    // This unfiltered first page has only one parameter: its lookahead limit.
    const statement = statements[0].replace("$1", "2");
    try {
      const plan = await db.execute(
        sql.raw(`EXPLAIN (FORMAT JSON) ${statement}`),
      );
      const serialized = JSON.stringify(plan.rows);
      expect(serialized).toContain("interactions_created_at_idx");
      expect(serialized).not.toContain('"Node Type":"Sort"');
    } finally {
      await db.execute(sql`RESET enable_seqscan`);
    }
  });
});
