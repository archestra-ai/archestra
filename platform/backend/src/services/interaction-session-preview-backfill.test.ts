import { inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import InteractionModel from "@/models/interaction";
import InteractionDeltaManager from "@/models/interaction-delta-manager";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
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

test("fills a delta thread from its stored rows in one pass, with the previews each row was written with", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const ids = await seedEditedClaudeCodeSession({
    agentId: agent.id,
    sessionId: "edited-session",
  });
  const stored = await readRows(ids);
  // Two threads: the conversation and the head the compaction started.
  expect(new Set(stored.map((row) => row.threadId)).size).toBe(2);
  const written = new Map(stored.map((row) => [row.id, row.sessionPreview]));
  await clearPreviews(ids);
  // Fold from the stored rows, not from what the writes left in the cache.
  InteractionDeltaManager.reset();

  const { result, statements } = await recordQueries(() => runToCompletion());
  expect(result).toEqual({ filled: ids.length, failed: 0 });
  // Each thread's rows are listed once; no row loads its own chain through
  // the delta manager.
  expect(statements.filter((s) => /thread_id = \$/.test(s))).toHaveLength(2);
  expect(
    statements.filter((s) => s.includes("processed_request_shared_prefix")),
  ).toHaveLength(0);

  const backfilled = await readRows(ids);
  expect(
    new Map(backfilled.map((row) => [row.id, row.sessionPreview])),
  ).toEqual(written);
});

test("folds a missing row through an ancestor that already has a preview", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const ids = await seedClaudeCodeSession({
    agentId: agent.id,
    sessionId: "rollout-session",
    turns: 3,
  });
  const stored = await readRows(ids);
  const written = new Map(stored.map((row) => [row.id, row.sessionPreview]));
  // As during the rollout that introduced previews: a row written by a pod on
  // the new build sits between rows written by a pod on the old one. The
  // row after it only stores a tool result, so its preview text lives in the
  // ancestor that keeps its preview.
  const keep = ids[3];
  await clearPreviews(ids.filter((id) => id !== keep));
  InteractionDeltaManager.reset();

  expect(await runToCompletion()).toEqual({
    filled: ids.length - 1,
    failed: 0,
  });
  const backfilled = await readRows(ids);
  expect(
    new Map(backfilled.map((row) => [row.id, row.sessionPreview])),
  ).toEqual(written);
});

test("fills a thread longer than one chunk, chunk by chunk", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const ids = await seedClaudeCodeSession({
    agentId: agent.id,
    sessionId: "long-session",
    turns: 5,
  });
  const stored = await readRows(ids);
  const written = new Map(stored.map((row) => [row.id, row.sessionPreview]));
  await clearPreviews(ids);
  InteractionDeltaManager.reset();

  // Eleven rows in the conversation thread, three per chunk: every chunk
  // after the first folds from a parent loaded by an earlier one.
  const { result, statements } = await recordQueries(() =>
    interactionSessionPreviewBackfill.run({ chunkRows: 3 }),
  );
  expect(result).toEqual({ filled: ids.length, failed: 0, complete: true });
  expect(
    statements.filter((s) =>
      /from "interactions" where "interactions"\."id" in \(/i.test(s),
    ),
  ).not.toHaveLength(0);
  expect(
    statements.filter((s) =>
      /from "interactions" where "interactions"\."id" in \(/i.test(s),
    ).length,
  ).toBeGreaterThanOrEqual(4);

  const backfilled = await readRows(ids);
  expect(
    new Map(backfilled.map((row) => [row.id, row.sessionPreview])),
  ).toEqual(written);
});

test("fills a row that stores its whole request", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  // Sessionless, so it is never delta-encoded.
  const created = await InteractionModel.create({
    profileId: agent.id,
    sessionId: null,
    sessionSource: null,
    type: "anthropic:messages",
    request: {
      model: "claude-test",
      max_tokens: 100,
      messages: [{ role: "user", content: "a single whole request" }],
    },
    response: {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "noted" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  await drainBackgroundWork();
  const [stored] = await readRows([created.id]);
  expect(stored.threadId).toBeNull();
  await clearPreviews([created.id]);

  expect(await runToCompletion()).toEqual({ filled: 1, failed: 0 });
  const [backfilled] = await readRows([created.id]);
  expect(backfilled.sessionPreview).toEqual(stored.sessionPreview);
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

/**
 * A Claude Code session with every fold shape the write path produces: a
 * string-content turn, a tool round-trip whose tip holds only a tool result,
 * a text-block turn, a history the client rewrote (its request chains to an
 * older row than the last one), and a compaction that starts a new head.
 */
async function seedEditedClaudeCodeSession(params: {
  agentId: string;
  sessionId: string;
}): Promise<string[]> {
  const base = {
    profileId: params.agentId,
    sessionId: params.sessionId,
    sessionSource: "claude_metadata" as const,
    type: "anthropic:messages" as const,
  };
  const ids: string[] = [];
  let messages: unknown[] = [];
  const send = async () => {
    const created = await InteractionModel.create({
      ...base,
      request: {
        model: "claude-test",
        max_tokens: 100,
        messages: [...messages],
      },
      response: {
        id: "msg",
        type: "message" as const,
        role: "assistant" as const,
        model: "claude-test",
        content: [{ type: "text" as const, text: "Looking into it" }],
        stop_reason: "end_turn" as const,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    ids.push(created.id);
  };
  const toolRoundTrip = (n: number) => {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `tool-${n}`, name: "Bash", input: {} }],
    });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `tool-${n}`, content: "ok" },
      ],
    });
  };

  messages.push({
    role: "user",
    content: `${params.sessionId} turn 0: a string ask`,
  });
  await send();
  toolRoundTrip(0);
  await send();
  messages.push({ role: "assistant", content: "Looking into it" });
  messages.push({
    role: "user",
    content: [
      { type: "text", text: `${params.sessionId} turn 1: a block ask` },
    ],
  });
  await send();
  // The client rewrites the history: the last exchange is dropped and the
  // question asked again, so this request chains to the earlier row.
  messages = messages.slice(0, -2);
  messages.push({
    role: "user",
    content: `${params.sessionId} turn 1: asked again`,
  });
  await send();
  toolRoundTrip(1);
  await send();
  // Compaction: a new first message starts a new thread in the same session.
  messages = [
    {
      role: "user",
      content: [{ type: "text", text: `${params.sessionId} summary` }],
    },
  ];
  await send();
  toolRoundTrip(2);
  await send();
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
