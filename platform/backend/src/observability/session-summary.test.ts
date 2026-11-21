import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import InteractionModel from "@/models/interaction";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import { drainBackgroundWork } from "@/utils/background-work";
import { SessionSummaryExport } from "./session-summary";
import { sessionTraceId } from "./tracing/session";

test("persisted session snapshots match UI totals across billing modes without exporting content or key values", async ({
  makeOrganization,
  makeAgent,
  makeUser,
  makeVirtualApiKey,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const user = await makeUser();
  const key = await makeVirtualApiKey(org.id, { name: "Test credential" });
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  logs.disable();
  logs.setGlobalLoggerProvider(provider);
  try {
    for (const [index, billingMode] of (
      ["metered", "subscription"] as const
    ).entries())
      await InteractionModel.create({
        profileId: agent.id,
        userId: user.id,
        sessionId: "snapshot-session",
        source: "api",
        type: "openai:chatCompletions",
        model: "test-model",
        billingMode,
        cost: index ? "0.2" : "0.3",
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100 + index * 100,
        authMethod: "virtual_key",
        virtualKeyId: key.id,
        request: {
          model: "test-model",
          messages: [{ role: "user", content: "private-message-payload" }],
        },
        response: {
          id: "test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [],
        },
      });
    await drainBackgroundWork();
    await provider.forceFlush();
    const snapshots = exporter
      .getFinishedLogRecords()
      .filter((r) => r.attributes.event_name === "archestra.session.summary")
      .map((r) => JSON.parse(String(r.body)));
    const snapshot = snapshots.find((s) => s.requests === 2);
    expect(snapshot).toMatchObject({
      session_id: "snapshot-session",
      trace_id: sessionTraceId("snapshot-session"),
      requests: 2,
      request_duration_ms: 300,
      estimated_cost: 0.5,
      billed_cost: 0.3,
      subscription_cost: 0.2,
      input_tokens: 20,
      output_tokens: 10,
      credentials: "Test credential",
    });
    const ui = await InteractionModel.getSessions(
      { limit: 10, offset: 0 },
      undefined,
      true,
      { organizationId: org.id, sessionId: "snapshot-session" },
    );
    expect(ui.data[0]).toMatchObject({
      requestCount: snapshot.requests,
      totalDurationMs: snapshot.request_duration_ms,
      totalInputTokens: snapshot.input_tokens,
      totalOutputTokens: snapshot.output_tokens,
    });
    expect(Number(ui.data[0].totalCost)).toBe(snapshot.estimated_cost);
    expect(JSON.stringify(snapshots)).not.toContain("private-message-payload");
    expect(JSON.stringify(snapshots)).not.toContain(key.secretId);
  } finally {
    await drainBackgroundWork();
    await provider.shutdown();
    logs.disable();
  }
});

test("concurrent writes each export their own summary from shared aggregations", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const user = await makeUser();
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  logs.disable();
  logs.setGlobalLoggerProvider(provider);
  try {
    const { result: created, statements } = await recordQueries(async () => {
      const rows = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          InteractionModel.create({
            profileId: agent.id,
            userId: user.id,
            source: "api",
            type: "openai:chatCompletions",
            model: "test-model",
            inputTokens: index + 1,
            outputTokens: 1,
            request: { model: "test-model", messages: [] },
            response: {
              id: "test",
              object: "chat.completion",
              created: 0,
              model: "test-model",
              choices: [],
            },
          }),
        ),
      );
      await drainBackgroundWork();
      return rows;
    });
    await provider.forceFlush();
    const snapshots = exporter
      .getFinishedLogRecords()
      .filter((r) => r.attributes.event_name === "archestra.session.summary")
      .map((r) => JSON.parse(String(r.body)));
    expect(snapshots.map((s) => s.session_id).sort()).toEqual(
      created.map((row) => row.id).sort(),
    );
    expect(snapshots.every((s) => s.requests === 1)).toBe(true);
    const aggregations = statements.filter((statement) =>
      statement.includes("COUNT(DISTINCT"),
    );
    expect(aggregations.length).toBeGreaterThan(0);
    expect(aggregations.length).toBeLessThan(created.length);
  } finally {
    await drainBackgroundWork();
    await provider.shutdown();
    logs.disable();
  }
});

test("a busy session rests between aggregations and still exports its latest totals", async () => {
  const calls: number[] = [];
  const exporter = new SessionSummaryExport(async () => {
    calls.push(performance.now());
    await new Promise((resolve) => setTimeout(resolve, 25));
    return [];
  });
  const key = { sessionId: "busy-session", interactionId: null };
  exporter.enqueue(key);
  for (let write = 0; write < 5; write++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    exporter.enqueue(key);
  }
  await drainBackgroundWork();
  // One aggregation for the first write, one trailing aggregation for the rest.
  expect(calls).toHaveLength(2);
  expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(25 * 5 - 5);
});
