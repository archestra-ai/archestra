import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";

const runtimeUrl = "http://phase-log.test.svc.cluster.local:18787";
const runtimeConfig = {
  url: runtimeUrl,
  timeoutMs: 100,
  sessionHmacSecret: "s".repeat(32),
  runtimeToken: "t".repeat(32),
};

describe("APPA phase trace log probe", () => {
  const server = useMswServer();
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    server.use(
      http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          parallel_calls: true,
          child_workflows: false,
          sanitized_results: true,
        }),
      ),
      http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
        const raw = await request.text();
        const envelope = JSON.parse(raw) as {
          event_id: string;
          event: {
            event: string;
            call_id?: string;
            calls?: Array<{ call_id: string }>;
          };
        };
        return HttpResponse.json({
          protocol_version: 1,
          event_id: envelope.event_id,
          request_sha256: createHash("sha256").update(raw).digest("hex"),
          decision:
            envelope.event.event === "tool_calls"
              ? {
                  decision: "allow_calls",
                  calls: envelope.event.calls?.map((call) => ({
                    call_id: call.call_id,
                    dispatch_id: `dispatch_${call.call_id}`,
                  })),
                }
              : envelope.event.event === "tool_result"
                ? {
                    decision: "result_admitted",
                    call_id: envelope.event.call_id,
                    presentation: "SAFE_RUNTIME_PRESENTATION",
                    offers: [],
                  }
                : { decision: "ack" },
        });
      }),
    );
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test("emits all phases through a real Fastify response finish", async () => {
    const originalLevel = process.env.ARCHESTRA_LOGGING_LEVEL;
    process.env.ARCHESTRA_LOGGING_LEVEL = "info";
    try {
      const { AppaProxyHookSession } = await import(
        "@/routes/proxy/appa-proxy-hook"
      );
      const { default: logger } = await import("@/logging");
      const loggerLevel = logger.level;
      logger.level = "info";
      app = Fastify();
      app.get("/proposal", async (_request, reply) => {
        const session = await AppaProxyHookSession.open({
          ...sessionParams(),
          toolResults: [],
        });
        reply.raw.once("finish", () => session.markOutboundCallsDelivered());
        await session.authorizeOutboundToolCalls([outboundCall()]);
        await session.finish();
        return reply.send({ ok: true });
      });
      app.get("/continuation", async (_request, reply) => {
        const session = await AppaProxyHookSession.open({
          ...sessionParams(),
          toolResults: [{ id: "call_log", content: "client result" }],
        });
        reply.raw.once("finish", () => session.markOutboundCallsDelivered());
        await session.finish();
        session.markContinuationResponseReady();
        return reply.send({ ok: true });
      });

      expect(
        (await app.inject({ method: "GET", url: "/proposal" })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: "/continuation" })).statusCode,
      ).toBe(200);
      logger.level = loggerLevel;
    } finally {
      if (originalLevel === undefined) {
        delete process.env.ARCHESTRA_LOGGING_LEVEL;
      } else {
        process.env.ARCHESTRA_LOGGING_LEVEL = originalLevel;
      }
    }
  });
});

function sessionParams() {
  return {
    config: runtimeConfig,
    profileId: "00000000-0000-4000-8000-000000000093",
    ownerScopeHash: "d".repeat(64),
    clientSessionId: "log-session",
    provider: "openai",
    protocol: "openai-responses" as const,
    model: "gpt-test",
    modelInput: { prompt: "ignored" },
    traceId: "log-trace",
  };
}

function outboundCall() {
  return {
    id: "call_log",
    emittedName: "status",
    emittedArguments: "{}",
    emittedArgumentsCanonical: "{}",
    targetName: "status",
    targetArguments: {},
  };
}
