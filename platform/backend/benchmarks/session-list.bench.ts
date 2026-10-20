/**
 * Manual, synthetic PGlite benchmark for the session list's cursor page — the
 * read a polling client makes when it pages through every session. Run from
 * platform/:
 * ARCHESTRA_DATABASE_URL=postgresql://test:test@localhost:5432/test pnpm --dir backend benchmark:queries benchmarks/session-list.bench.ts
 *
 * Seeds Claude Code sessions whose requests grow turn by turn (so most rows are
 * delta-encoded), then reads one 100-session page twice: with every row's
 * session_preview cleared, as rows written before migration 0562 are, and after
 * the session-preview backfill has filled them. Seven samples each after warmup,
 * with the delta reconstruction cache cleared before each sample. These are
 * local model timings, not deployed latency.
 */
import { inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import InteractionModel from "@/models/interaction";
import InteractionDeltaManager from "@/models/interaction-delta-manager";
import { interactionSessionPreviewBackfill } from "@/services/interaction-session-preview-backfill";
import { expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";

const SESSIONS = 100;
const TURNS = 12;

test("session list cursor page synthetic benchmark", async ({
  makeOrganization,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  // Claude Code sends its system prompt and tool definitions on every turn.
  const system = "You are Claude Code. ".repeat(2_000);
  const tools = Array.from({ length: 40 }, (_, n) => ({
    name: `tool_${n}`,
    description: "Synthetic tool description. ".repeat(40),
    input_schema: { type: "object", properties: {} },
  }));
  const ids: string[] = [];
  for (let session = 0; session < SESSIONS; session++) {
    const messages: unknown[] = [];
    for (let turn = 0; turn < TURNS; turn++) {
      messages.push({
        role: "user",
        content: `Session ${session} turn ${turn} ${"context ".repeat(400)}`,
      });
      messages.push(
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: `t${turn}`, name: "Bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `t${turn}`,
              content: "output ".repeat(600),
            },
          ],
        },
      );
      const created = await InteractionModel.create({
        profileId: agent.id,
        sessionId: `bench-session-${session}`,
        sessionSource: "claude_metadata",
        type: "anthropic:messages",
        request: {
          model: "claude-test",
          max_tokens: 100,
          system,
          tools,
          messages: [...messages],
        },
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
      ids.push(created.id);
      messages.push({ role: "assistant", content: "answer" });
    }
  }
  await drainBackgroundWork();

  const runs: Record<string, number[]> = {};
  const measure = async (name: string, fn: () => Promise<unknown>) => {
    await fn();
    runs[name] = [];
    for (let n = 0; n < 7; n++) {
      InteractionDeltaManager.reset();
      const start = performance.now();
      await fn();
      runs[name].push(performance.now() - start);
    }
  };
  const page = async () => {
    const result = await InteractionModel.getSessionsCursor(
      { limit: 100 },
      undefined,
      undefined,
      { organizationId: org.id },
    );
    expect(result.data).toHaveLength(SESSIONS);
    expect(
      result.data.every((s) =>
        s.lastUserMessagePreview?.includes(`turn ${TURNS - 1}`),
      ),
    ).toBe(true);
    return result;
  };

  for (let offset = 0; offset < ids.length; offset += 500) {
    await db
      .update(schema.interactionsTable)
      .set({ sessionPreview: null })
      .where(
        inArray(schema.interactionsTable.id, ids.slice(offset, offset + 500)),
      );
  }
  await measure("page-without-previews", page);
  const legacy = await page();

  InteractionDeltaManager.reset();
  const backfillStart = performance.now();
  let filled = 0;
  for (;;) {
    const result = await interactionSessionPreviewBackfill.run();
    filled += result.filled;
    if (result.complete) break;
  }
  const backfillMs = performance.now() - backfillStart;
  expect(filled).toBe(ids.length);

  await measure("page-with-previews", page);
  expect(await page()).toEqual(legacy);

  process.stdout.write(
    `SYNTHETIC_BENCHMARK ${JSON.stringify({
      sessions: SESSIONS,
      rows: ids.length,
      milliseconds: runs,
      backfill: { rows: filled, milliseconds: Math.round(backfillMs) },
    })}\n`,
  );
}, 600_000);
