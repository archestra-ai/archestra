import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import InteractionModel from "@/models/interaction";
import { expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
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
