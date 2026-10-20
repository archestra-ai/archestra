import { inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import InteractionModel from "@/models/interaction";
import InteractionDeltaManager from "@/models/interaction-delta-manager";
import { expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { interactionSessionPreviewBackfill } from "./interaction-session-preview-backfill";

test("stores the preview each row would have been written with", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const ids = await seedClaudeCodeSession({
    agentId: agent.id,
    sessionId: "backfill-session",
    turns: 4,
  });
  // Delta rows only store their new messages, so their last-user-message
  // preview has to come from the rebuilt request. Make sure this covers them.
  const stored = await readRows(ids);
  expect(stored.some((row) => row.threadId !== null)).toBe(true);

  const written = new Map(stored.map((row) => [row.id, row.sessionPreview]));
  await clearPreviews(ids);

  expect(await runToCompletion()).toEqual({ filled: ids.length, failed: 0 });
  const backfilled = await readRows(ids);
  expect(
    new Map(backfilled.map((row) => [row.id, row.sessionPreview])),
  ).toEqual(written);

  // Nothing left: the next run fills nothing.
  expect(await runToCompletion()).toEqual({ filled: 0, failed: 0 });
});

test("the session list reads the same before and after the backfill", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const ids: string[] = [];
  for (let session = 0; session < 3; session++) {
    ids.push(
      ...(await seedClaudeCodeSession({
        agentId: agent.id,
        sessionId: `list-session-${session}`,
        turns: 3,
      })),
    );
  }
  await clearPreviews(ids);

  const listSessions = async () => {
    InteractionDeltaManager.reset();
    return InteractionModel.getSessionsCursor(
      { limit: 10 },
      undefined,
      undefined,
      {
        organizationId: org.id,
      },
    );
  };
  const before = await listSessions();
  expect(before.data).toHaveLength(3);
  expect(
    before.data.every(
      (s) =>
        s.lastUserMessagePreview?.includes("turn 2") &&
        s.claudeCodeTitle === "Fixing the flaky test",
    ),
  ).toBe(true);

  await runToCompletion();

  expect(await listSessions()).toEqual(before);
});

test("leaves encrypted-chat rows alone", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const [id] = await seedClaudeCodeSession({
    agentId: agent.id,
    sessionId: "locked-session",
    turns: 1,
  });
  // Content keyed to a browser the server does not hold: nothing to derive.
  await db
    .update(schema.interactionsTable)
    .set({
      sessionPreview: null,
      encryptedChatConversationId: crypto.randomUUID(),
    })
    .where(inArray(schema.interactionsTable.id, [id]));

  expect(await runToCompletion()).toEqual({ filled: 0, failed: 0 });
  const [row] = await readRows([id]);
  expect(row.sessionPreview).toBeNull();
});

// ===== Helpers =====

/**
 * A Claude Code session: the title-generation call first, then turns whose
 * requests carry the conversation so far, so later turns are delta-encoded.
 */
async function seedClaudeCodeSession(params: {
  agentId: string;
  sessionId: string;
  turns: number;
}): Promise<string[]> {
  const base = {
    profileId: params.agentId,
    sessionId: params.sessionId,
    sessionSource: "claude_metadata" as const,
    type: "anthropic:messages" as const,
  };
  const answer = (text: string) => ({
    id: "msg",
    type: "message" as const,
    role: "assistant" as const,
    model: "claude-test",
    content: [{ type: "text" as const, text }],
    stop_reason: "end_turn" as const,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const ids: string[] = [];
  const title = await InteractionModel.create({
    ...base,
    request: {
      model: "claude-test",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: "Please write a 5-10 word title for this conversation",
        },
      ],
    },
    response: answer("Fixing the flaky test"),
  });
  ids.push(title.id);

  const messages: unknown[] = [];
  const send = async () => {
    const created = await InteractionModel.create({
      ...base,
      request: {
        model: "claude-test",
        max_tokens: 100,
        messages: [...messages],
      },
      response: answer("Looking into it"),
    });
    ids.push(created.id);
  };
  for (let turn = 0; turn < params.turns; turn++) {
    messages.push({
      role: "user",
      content: `${params.sessionId} turn ${turn}: please look at the failing test`,
    });
    await send();
    // A tool round-trip. The follow-up's newest user message is only a tool
    // result, so its preview text lives in the shared prefix its delta row
    // does not store.
    messages.push({
      role: "assistant",
      content: [
        { type: "tool_use", id: `tool-${turn}`, name: "Bash", input: {} },
      ],
    });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `tool-${turn}`, content: "ok" },
      ],
    });
    await send();
    messages.push({ role: "assistant", content: "Looking into it" });
  }
  await drainBackgroundWork();
  return ids;
}

/** What a row written before migration 0562 looks like. */
async function clearPreviews(ids: string[]): Promise<void> {
  await db
    .update(schema.interactionsTable)
    .set({ sessionPreview: null })
    .where(inArray(schema.interactionsTable.id, ids));
}

async function readRows(ids: string[]) {
  return db
    .select({
      id: schema.interactionsTable.id,
      threadId: schema.interactionsTable.threadId,
      sessionPreview: schema.interactionsTable.sessionPreview,
    })
    .from(schema.interactionsTable)
    .where(inArray(schema.interactionsTable.id, ids));
}

async function runToCompletion(): Promise<{ filled: number; failed: number }> {
  let filled = 0;
  let failed = 0;
  for (;;) {
    const result = await interactionSessionPreviewBackfill.run();
    filled += result.filled;
    failed += result.failed;
    if (result.complete) return { filled, failed };
  }
}
