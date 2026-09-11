import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import logger from "@/logging";
import { AppaProxyHookSession } from "@/routes/proxy/appa-proxy-hook";
import { useMswServer } from "@/test/msw";
import { AppaProxyPhaseTrace } from "./appa-proxy-phase-trace";

vi.mock("@/logging");

const runtimeUrl = "http://phase-trace.test.svc.cluster.local:18787";
const runtimeConfig = {
  url: runtimeUrl,
  timeoutMs: 100,
  sessionHmacSecret: "s".repeat(32),
  runtimeToken: "t".repeat(32),
};

describe("APPA proxy phase trace", () => {
  const server = useMswServer();
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  beforeEach(() => {
    vi.clearAllMocks();
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

  test("records only hashed, local-write evidence", () => {
    const trace = new AppaProxyPhaseTrace({
      traceId: "trace-secret",
      ownerScopeHash: "bound-auth-scope",
      provider: "openai",
      protocol: "openai-responses",
      sessionId: "session-secret",
    });

    trace.authorizationReceipt({
      callIds: ["call-secret"],
      receipt: { id: "runtime-event", sha256: "receipt-hash" },
    });

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "appa_proxy_phase_trace",
        phase: "authorization_receipt",
        call_id_sha256: digest("call-secret"),
        trace_id_sha256: digest("trace-secret"),
        session_id_sha256: digest("session-secret"),
        bound_auth_scope_hash: "bound-auth-scope",
        runtime_receipt_id: "runtime-event",
        runtime_receipt_sha256: "receipt-hash",
        delivery_semantics:
          "local_write_completion_not_client_execution_or_ack",
      }),
      "APPA proxy phase trace",
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(
      "call-secret",
    );
  });

  test("waits for the real Fastify response finish before recording proposal delivery", async () => {
    app = Fastify();
    app.get("/proposal", async (_request, reply) => {
      const session = await AppaProxyHookSession.open({
        config: runtimeConfig,
        profileId: "00000000-0000-4000-8000-000000000091",
        ownerScopeHash: "phase-owner",
        clientSessionId: "phase-session",
        provider: "openai",
        protocol: "openai-responses",
        model: "gpt-test",
        modelInput: { prompt: "ignored" },
        toolResults: [],
        traceId: "phase-trace",
      });
      reply.raw.once("finish", () => session.markOutboundCallsDelivered());
      await session.authorizeOutboundToolCalls([
        {
          id: "call_phase",
          emittedName: "status",
          emittedArguments: "{}",
          emittedArgumentsCanonical: "{}",
          targetName: "status",
          targetArguments: {},
        },
      ]);
      await session.finish();
      return reply.send({ ok: true });
    });

    const response = await app.inject({ method: "GET", url: "/proposal" });

    expect(response.statusCode).toBe(200);
    const phases = vi
      .mocked(logger.info)
      .mock.calls.map(([fields]) => fields)
      .filter(
        (fields): fields is Record<string, unknown> =>
          !!fields &&
          typeof fields === "object" &&
          (fields as Record<string, unknown>).event ===
            "appa_proxy_phase_trace",
      );
    expect(phases.map((entry) => entry.phase)).toEqual([
      "authorization_receipt",
      "proposal_socket_write_finish",
    ]);
    expect(phases[0]).toEqual(
      expect.objectContaining({
        call_id_sha256: digest("call_phase"),
        runtime_receipt_id: expect.any(String),
        runtime_receipt_sha256: expect.any(String),
      }),
    );
    expect(phases[1]).not.toHaveProperty("runtime_receipt_id");
  });

  test("does not mark a quarantined disconnect as a successful socket write", async () => {
    const session = await openSession("disconnect-session");
    await session.authorizeOutboundToolCalls([outboundCall("call_disconnect")]);
    await session.quarantineUndeliveredCalls();

    const phases = tracePhases();
    expect(phases.map((entry) => entry.phase)).toEqual([
      "authorization_receipt",
    ]);
  });

  test("links an admitted result to the refusal response for the next denied proposal", async () => {
    const first = await openSession("result-session");
    await first.authorizeOutboundToolCalls([outboundCall("call_result")]);
    first.markOutboundCallsDelivered();
    await first.finish();
    vi.clearAllMocks();

    const continuation = await AppaProxyHookSession.open({
      ...sessionParams("result-session"),
      toolResults: [{ id: "call_result", content: "client result" }],
    });
    continuation.markContinuationResponseReady();
    continuation.markOutboundCallsDelivered();
    await continuation.finish();

    expect(tracePhases().map((entry) => entry.phase)).toEqual([
      "result_admission_receipt",
      "continuation_socket_write_finish",
    ]);
  });

  test("records independent completion chains when a result response proposes the next call", async () => {
    app = Fastify();
    app.get("/read-proposal", async (_request, reply) => {
      const session = await openSession("chained-session");
      reply.raw.once("finish", () => session.markOutboundCallsDelivered());
      await session.authorizeOutboundToolCalls([outboundCall("call_read")]);
      await session.finish();
      return reply.send({ call: "read" });
    });
    app.get("/read-result-next-publish", async (_request, reply) => {
      const session = await AppaProxyHookSession.open({
        ...sessionParams("chained-session"),
        toolResults: [{ id: "call_read", content: "read result" }],
      });
      reply.raw.once("finish", () => session.markOutboundCallsDelivered());
      await session.authorizeOutboundToolCalls([outboundCall("call_publish")]);
      await session.finish();
      session.markContinuationResponseReady();
      reply.raw.write('{"call":"publish"}');
      reply.raw.end();
      return reply;
    });
    app.get("/publish-result-terminal", async (_request, reply) => {
      const session = await AppaProxyHookSession.open({
        ...sessionParams("chained-session"),
        toolResults: [{ id: "call_publish", content: "publish result" }],
      });
      reply.raw.once("finish", () => session.markOutboundCallsDelivered());
      await session.finish();
      session.markContinuationResponseReady();
      return reply.send({ complete: true });
    });

    expect(
      (await app.inject({ method: "GET", url: "/read-proposal" })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/read-result-next-publish",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/publish-result-terminal" }))
        .statusCode,
    ).toBe(200);

    expect(phasesForCall("call_read")).toEqual([
      "authorization_receipt",
      "proposal_socket_write_finish",
      "result_admission_receipt",
      "continuation_socket_write_finish",
    ]);
    expect(phasesForCall("call_publish")).toEqual([
      "authorization_receipt",
      "proposal_socket_write_finish",
      "result_admission_receipt",
      "continuation_socket_write_finish",
    ]);
  });

  test("does not turn an aborted terminal response into a continuation write", async () => {
    const first = await openSession("aborted-continuation-session");
    await first.authorizeOutboundToolCalls([outboundCall("call_aborted")]);
    first.markOutboundCallsDelivered();
    await first.finish();
    vi.clearAllMocks();

    const continuation = await AppaProxyHookSession.open({
      ...sessionParams("aborted-continuation-session"),
      toolResults: [{ id: "call_aborted", content: "client result" }],
    });
    continuation.markContinuationResponseReady();
    await continuation.abort();

    expect(tracePhases().map((entry) => entry.phase)).toEqual([
      "result_admission_receipt",
    ]);
  });
});

function tracePhases(): Record<string, unknown>[] {
  return vi
    .mocked(logger.info)
    .mock.calls.map(([fields]) => fields)
    .filter(
      (fields): fields is Record<string, unknown> =>
        !!fields &&
        typeof fields === "object" &&
        (fields as Record<string, unknown>).event === "appa_proxy_phase_trace",
    );
}

function phasesForCall(callId: string): unknown[] {
  const callHash = digest(callId);
  return tracePhases()
    .filter((phase) => phase.call_id_sha256 === callHash)
    .map((phase) => phase.phase);
}

function sessionParams(clientSessionId: string) {
  return {
    config: runtimeConfig,
    profileId: "00000000-0000-4000-8000-000000000092",
    ownerScopeHash: "phase-owner",
    clientSessionId,
    provider: "openai",
    protocol: "openai-responses" as const,
    model: "gpt-test",
    modelInput: { prompt: "ignored" },
    traceId: "phase-trace",
  };
}

function openSession(clientSessionId: string) {
  return AppaProxyHookSession.open({
    ...sessionParams(clientSessionId),
    toolResults: [],
  });
}

function outboundCall(id: string) {
  return {
    id,
    emittedName: "status",
    emittedArguments: "{}",
    emittedArgumentsCanonical: "{}",
    targetName: "status",
    targetArguments: {},
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
