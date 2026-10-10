import { eq, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import { drainBackgroundWork } from "@/utils/background-work";
import InteractionModel from "./interaction";

describe("session query budgets", () => {
  let profileId: string;
  beforeEach(async ({ makeAgent }) => {
    profileId = (await makeAgent()).id;
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
