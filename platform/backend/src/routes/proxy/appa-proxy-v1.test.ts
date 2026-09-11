import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, describe } from "vitest";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  type AppaProxyHookConfig,
  AppaProxyHookSession,
} from "./appa-proxy-hook";

const url = "http://appa.test.svc.cluster.local:18787";
const config: AppaProxyHookConfig = {
  url,
  timeoutMs: 100,
  sessionHmacSecret: "session".repeat(8),
  runtimeToken: "transport".repeat(8),
  autoAcceptRestrictions: true,
};
describe("OpenAPPA v1 transport", () => {
  const server = useMswServer();

  async function receipt(
    request: Request,
    decide: (event: Record<string, unknown>) => Record<string, unknown>,
  ) {
    const raw = await request.text();
    const envelope = JSON.parse(raw);
    return {
      protocol_version: 1,
      event_id: envelope.event_id,
      request_sha256: createHash("sha256").update(raw).digest("hex"),
      decision: decide(envelope.event),
    };
  }

  function allowDecision(event: Record<string, unknown>) {
    if (event.event === "tool_calls" && Array.isArray(event.calls)) {
      return {
        decision: "allow_calls",
        calls: event.calls.map((candidate) => {
          const call = candidate as { call_id: string; spawn?: boolean };
          return {
            call_id: call.call_id,
            dispatch_id: `dispatch_${call.call_id}`,
            ...(call.spawn ? { spawn_binding: `fork_${call.call_id}` } : {}),
          };
        }),
      };
    }
    if (event.event === "tool_result") {
      return {
        decision: "result_admitted",
        call_id: event.call_id,
        presentation: "SAFE_RUNTIME_PRESENTATION",
        offers: [],
      };
    }
    return { decision: "ack" };
  }

  function open(clientSessionId = "v1-test") {
    return AppaProxyHookSession.open({
      config,
      profileId: "00000000-0000-4000-8000-000000000071",
      ownerScopeHash: "v1-owner",
      clientSessionId,
      modelInput: "synthetic",
      toolResults: [],
    });
  }

  const call = {
    id: "call_v1",
    emittedName: "read_public_status",
    emittedArguments: "{}",
    emittedArgumentsCanonical: "{}",
    targetName: "read_public_status",
    targetArguments: {},
  };

  beforeEach(() => {
    server.use(
      http.get(`${url}/proxy/v1/capabilities`, () =>
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
    );
  });

  test("uses the deployed nested receipt and retries identical bytes after a lost reply", async () => {
    const bodies: string[] = [];
    let lost = false;
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) => {
        const raw = await request.clone().text();
        bodies.push(raw);
        const body = await receipt(request, allowDecision);
        if (!lost) {
          lost = true;
          return HttpResponse.error();
        }
        return HttpResponse.json(body);
      }),
    );
    const session = await open();
    expect(bodies[0]).toBe(bodies[1]);
    await session.authorizeOutboundToolCalls([call]);
    await session.finish();
    expect(
      bodies.filter((body) => JSON.parse(body).event.event === "tool_calls"),
    ).toHaveLength(1);
  });

  test("does not retry an explicitly uncertain operation", async () => {
    let attempts = 0;
    server.use(
      http.post(`${url}/proxy/v1/events`, () => {
        attempts++;
        return HttpResponse.json(
          { error: { code: "event_uncertain" } },
          { status: 503 },
        );
      }),
    );
    await expect(open()).rejects.toThrow("unknown");
    await expect(open()).rejects.toThrow("quarantined");
    expect(attempts).toBe(1);
  });

  test("rejects a receipt for different request bytes", async () => {
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) => {
        const body = await receipt(request, () => ({ decision: "ack" }));
        return HttpResponse.json({ ...body, request_sha256: "0".repeat(64) });
      }),
    );
    await expect(open()).rejects.toThrow("unknown");
  });

  test("rejects a flat decision rather than weakening the v1 contract", async () => {
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) => {
        const body = await receipt(request, () => ({ decision: "ack" }));
        return HttpResponse.json({ ...body, decision: "ack" });
      }),
    );
    await expect(open()).rejects.toThrow("unknown");
  });

  test("keeps unsupported spawn bindings fail-closed inside a valid receipt", async () => {
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(
          await receipt(request, (event) =>
            event.event === "tool_calls"
              ? {
                  decision: "allow_calls",
                  calls: [{ call_id: "call_v1", dispatch_id: "dispatch_v1" }],
                  spawn_binding: { child: "unsupported" },
                }
              : { decision: "ack" },
          ),
        ),
      ),
    );
    const session = await open();
    await expect(session.authorizeOutboundToolCalls([call])).rejects.toThrow(
      "unknown",
    );
  });

  test("accepts a singleton runtime acceptance and re-proposes a fresh tool_calls event", async () => {
    let calls = 0;
    const ids: string[] = [];
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) => {
        const raw = (await request.clone().json()) as { event_id: string };
        const body = await receipt(request, (event) => {
          if (event.event === "resolve_offer")
            return {
              decision: "offer_resolved",
              offer_id: event.offer_id,
              kind: "acceptance",
              resolution: "accepted",
              tool: event.tool,
              arguments_sha256: event.arguments_sha256,
            };
          if (event.event !== "tool_calls") return { decision: "ack" };
          ids.push(raw.event_id);
          calls++;
          if (calls > 1) return allowDecision(event);
          const [proposed] = event.calls as Array<{ tool: string }>;
          return {
            decision: "deny_calls",
            calls: [
              {
                call_id: (event.calls as Array<{ call_id: string }>)[0]
                  ?.call_id,
                decision: "deny_call",
                feedback: "accept narrowing",
                review: [],
                offers: [
                  {
                    offer_id: "accepted-offer",
                    kind: "acceptance",
                    root_id: event.root_id,
                    tool: proposed.tool,
                    arguments_sha256: createHash("sha256")
                      .update("{}")
                      .digest("hex"),
                  },
                ],
              },
            ],
          };
        });
        return HttpResponse.json(body);
      }),
    );
    const session = await open();
    await session.authorizeOutboundToolCalls([call]);
    await session.finish();
    expect(calls).toBe(2);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("does not treat a typed human offer as a generic acceptance", async () => {
    let resolved = 0;
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(
          await receipt(request, (event) => {
            if (event.event === "resolve_offer") resolved++;
            if (event.event !== "tool_calls") return { decision: "ack" };
            const [proposed] = event.calls as Array<{ tool: string }>;
            return {
              decision: "deny_calls",
              calls: [
                {
                  call_id: (event.calls as Array<{ call_id: string }>)[0]
                    ?.call_id,
                  decision: "deny_call",
                  feedback: "human required",
                  review: [],
                  offers: [
                    {
                      offer_id: "human",
                      kind: "human_approval",
                      root_id: event.root_id,
                      tool: proposed.tool,
                      arguments_sha256: createHash("sha256")
                        .update("{}")
                        .digest("hex"),
                    },
                  ],
                },
              ],
            };
          }),
        ),
      ),
    );
    const session = await open();
    await expect(session.authorizeOutboundToolCalls([call])).rejects.toThrow(
      "denied",
    );
    expect(resolved).toBe(0);
  });

  test("binds a singleton sanitizer before re-proposing the call", async () => {
    let proposals = 0;
    const resolutions: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(
          await receipt(request, (event) => {
            if (event.event === "resolve_offer") {
              resolutions.push(event);
              return {
                decision: "offer_resolved",
                offer_id: event.offer_id,
                kind: "sanitizer",
                resolution: "bound",
                tool: event.tool,
                arguments_sha256: event.arguments_sha256,
              };
            }
            if (event.event !== "tool_calls") return allowDecision(event);
            proposals++;
            if (proposals > 1) return allowDecision(event);
            const [proposed] = event.calls as Array<{
              call_id: string;
              tool: string;
            }>;
            return {
              decision: "deny_calls",
              calls: [
                {
                  call_id: proposed?.call_id,
                  decision: "deny_call",
                  feedback: "sanitize the result",
                  review: [],
                  offers: [
                    {
                      offer_id: "acceptance-offer",
                      kind: "acceptance",
                      root_id: event.root_id,
                      tool: proposed?.tool,
                      arguments_sha256: createHash("sha256")
                        .update("{}")
                        .digest("hex"),
                    },
                    {
                      offer_id: "sanitizer-offer",
                      kind: "sanitizer",
                      root_id: event.root_id,
                      tool: proposed?.tool,
                      arguments_sha256: createHash("sha256")
                        .update("{}")
                        .digest("hex"),
                    },
                  ],
                },
              ],
            };
          }),
        ),
      ),
    );
    const session = await open("sanitize-singleton");
    await session.authorizeOutboundToolCalls([call]);
    await session.finish();
    expect(proposals).toBe(2);
    expect(resolutions).toEqual([
      expect.objectContaining({
        resolution: "apply_sanitizer",
        tool: "read_public_status",
      }),
    ]);
  });

  test("waits for signed singleton approval then re-proposes identical calls", async () => {
    const reviewConfig = {
      ...config,
      approvalSigningSecret: "approval".repeat(8),
    };
    const calls: Array<{ id: string; calls: Array<Record<string, unknown>> }> =
      [];
    const resolutions: Array<Record<string, unknown>> = [];
    let proposals = 0;
    server.use(
      http.get(`${url}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: true,
          approval_grants: true,
          parallel_calls: true,
          child_workflows: false,
          sanitized_results: true,
        }),
      ),
      http.post(`${url}/proxy/v1/events`, async ({ request }) => {
        const envelope = (await request.clone().json()) as {
          event_id: string;
          event: Record<string, unknown>;
        };
        return HttpResponse.json(
          await receipt(request, (event) => {
            if (event.event === "resolve_offer") {
              resolutions.push(event);
              return {
                decision: "offer_resolved",
                offer_id: event.offer_id,
                kind: "human_approval",
                resolution: "approved",
                tool: event.tool,
                arguments_sha256: event.arguments_sha256,
              };
            }
            if (event.event !== "tool_calls") return allowDecision(event);
            calls.push({
              id: envelope.event_id,
              calls: event.calls as Array<Record<string, unknown>>,
            });
            proposals++;
            if (proposals > 1) return allowDecision(event);
            const [proposed] = event.calls as Array<{ tool: string }>;
            return {
              decision: "deny_calls",
              calls: [
                {
                  call_id: (event.calls as Array<{ call_id: string }>)[0]
                    ?.call_id,
                  decision: "deny_call",
                  feedback: "review required",
                  review: [],
                  offers: [
                    {
                      offer_id: "human-offer",
                      kind: "human_approval",
                      root_id: event.root_id,
                      tool: proposed.tool,
                      arguments_sha256: createHash("sha256")
                        .update("{}")
                        .digest("hex"),
                    },
                  ],
                },
              ],
            };
          }),
        );
      }),
    );
    const session = await AppaProxyHookSession.open({
      config: reviewConfig,
      profileId: "00000000-0000-4000-8000-000000000071",
      organizationId: "00000000-0000-4000-8000-000000000072",
      ownerScopeHash: "v1-owner",
      clientSessionId: "review-singleton",
      modelInput: "synthetic",
      toolResults: [],
    });
    const authorization = session.authorizeOutboundToolCalls([call]);
    await expect
      .poll(async () => {
        const [approval] = await db
          .select()
          .from(schema.appaApprovalsTable)
          .limit(1);
        return approval?.id ?? null;
      })
      .not.toBeNull();
    const [approval] = await db
      .select()
      .from(schema.appaApprovalsTable)
      .limit(1);
    if (!approval) throw new Error("approval was not created");
    await db
      .update(schema.appaApprovalsTable)
      .set({
        status: "approved",
        approverId: "reviewer",
        decidedAt: new Date(),
      })
      .where(eq(schema.appaApprovalsTable.id, approval.id));
    await authorization;
    await session.finish();
    expect(calls).toHaveLength(2);
    expect(calls[0].id).not.toBe(calls[1].id);
    expect(calls[1].calls).toEqual(calls[0].calls);
    expect(resolutions).toEqual([
      expect.objectContaining({
        resolution: "approve",
        tool: "read_public_status",
        arguments_sha256: createHash("sha256").update("{}").digest("hex"),
        approval: expect.objectContaining({
          reviewer_id: "reviewer",
          signature: expect.any(String),
        }),
      }),
    ]);
  });

  test("rejects oversized event bodies before sending them", async () => {
    const events: string[] = [];
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(
          await receipt(request, (event) => {
            events.push(String(event.event));
            return { decision: "ack" };
          }),
        ),
      ),
    );
    await expect(
      AppaProxyHookSession.open({
        config,
        profileId: "00000000-0000-4000-8000-000000000071",
        ownerScopeHash: "v1-owner",
        clientSessionId: "large",
        modelInput: "x".repeat(1024 * 1024),
        toolResults: [],
      }),
    ).rejects.toThrow("1 MiB");
    expect(events).not.toContain("prompt");
  });

  test("binds parallel calls and reversed results to exact call ids", async () => {
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(
          await receipt(request, (event) => {
            events.push(event);
            if (event.event === "tool_calls") {
              return {
                decision: "allow_calls",
                calls: [...(event.calls as Array<{ call_id: string }>)]
                  .reverse()
                  .map((call) => ({
                    call_id: call.call_id,
                    dispatch_id: `dispatch_${call.call_id}`,
                  })),
              };
            }
            return allowDecision(event);
          }),
        ),
      ),
    );
    const first = await open("parallel-results");
    await first.authorizeOutboundToolCalls([
      call,
      { ...call, id: "call_v1_second" },
    ]);
    await first.finish();
    const second = await AppaProxyHookSession.open({
      config,
      profileId: "00000000-0000-4000-8000-000000000071",
      ownerScopeHash: "v1-owner",
      clientSessionId: "parallel-results",
      modelInput: "followup",
      toolResults: [
        { id: "call_v1_second", content: "raw second" },
        { id: "call_v1", content: "raw first" },
      ],
    });
    expect(second.getModelResultUpdates()).toEqual(
      new Map([
        ["call_v1_second", "SAFE_RUNTIME_PRESENTATION"],
        ["call_v1", "SAFE_RUNTIME_PRESENTATION"],
      ]),
    );
    await second.finish();
    expect(events.find((event) => event.event === "tool_calls")).toMatchObject({
      calls: [
        { call_id: "call_v1", tool: "read_public_status" },
        { call_id: "call_v1_second", tool: "read_public_status" },
      ],
    });
    expect(
      events
        .filter((event) => event.event === "tool_result")
        .map((event) => event.call_id),
    ).toEqual(["call_v1_second", "call_v1"]);
  });

  test("does not apply Codex-only gateway receipts to Claude-issued calls", async () => {
    const events: Array<Record<string, unknown>> = [];
    const claudeCall = {
      ...call,
      id: "toolu_claude_issued",
      emittedName: "mcp__gateway__fixture_read",
      targetName: "mcp/gateway/fixture_read",
    };
    const nativeCodexConfig = { ...config, nativeCodexEnabled: true };
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(
          await receipt(request, (event) => {
            events.push(event);
            return event.event === "tool_result"
              ? {
                  decision: "result_admitted",
                  call_id: event.call_id,
                  presentation: "SAFE_RUNTIME_PRESENTATION",
                }
              : allowDecision(event);
          }),
        ),
      ),
    );
    const first = await AppaProxyHookSession.open({
      config: nativeCodexConfig,
      nativeCodexExecution: false,
      profileId: "00000000-0000-4000-8000-000000000071",
      ownerScopeHash: "v1-owner",
      clientSessionId: "claude-result-contract",
      modelInput: "synthetic",
      toolResults: [],
    });
    await first.authorizeOutboundToolCalls([claudeCall]);
    await first.finish();
    const second = await AppaProxyHookSession.open({
      config: nativeCodexConfig,
      nativeCodexExecution: false,
      profileId: "00000000-0000-4000-8000-000000000071",
      ownerScopeHash: "v1-owner",
      clientSessionId: "claude-result-contract",
      modelInput: "continue",
      toolResults: [
        { id: claudeCall.id, content: "gateway-correlated result" },
      ],
    });
    expect(second.getModelResultUpdates()).toEqual(
      new Map([[claudeCall.id, "SAFE_RUNTIME_PRESENTATION"]]),
    );
    await second.finish();
    expect(events.find((event) => event.event === "tool_result")).toMatchObject(
      {
        call_id: claudeCall.id,
        outcome: { status: "success", body: "gateway-correlated result" },
      },
    );
  });

  test("starts and ends a child only through its bound parent spawn", async () => {
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${url}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          parallel_calls: true,
          child_workflows: true,
          child_actor_targeting: true,
          sanitized_results: true,
        }),
      ),
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(
          await receipt(request, (event) => {
            events.push(event);
            return allowDecision(event);
          }),
        ),
      ),
    );
    const parent = await open("parent-thread");
    await parent.authorizeOutboundToolCalls([
      {
        ...call,
        id: "spawn-call",
        targetName: "spawn_agent",
        emittedName: "spawn_agent",
        spawn: true,
      },
    ]);
    await parent.finish();
    const child = await AppaProxyHookSession.open({
      config,
      profileId: "00000000-0000-4000-8000-000000000071",
      ownerScopeHash: "v1-owner",
      clientSessionId: "child-thread",
      parentClientSessionId: "parent-thread",
      spawnBinding: "fork_spawn-call",
      modelInput: "child prompt",
      toolResults: [],
    });
    await child.finish({ childReturn: "child answer" });
    expect(events.filter((event) => event.event === "child_start")).toEqual([
      expect.objectContaining({
        child_id: "child-thread",
        spawn_binding: "fork_spawn-call",
      }),
    ]);
    expect(events.filter((event) => event.event === "child_end")).toEqual([
      expect.objectContaining({
        child_id: "child-thread",
        value: "child answer",
      }),
    ]);
  });

  test("requires and atomically consumes the spawn capability for child attach", async () => {
    server.use(
      http.get(`${url}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          parallel_calls: true,
          child_workflows: true,
          child_actor_targeting: true,
          sanitized_results: true,
        }),
      ),
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(await receipt(request, allowDecision)),
      ),
    );
    const parent = await open("capability-parent");
    await parent.authorizeOutboundToolCalls([
      {
        ...call,
        id: "capability-spawn",
        targetName: "spawn_agent",
        emittedName: "spawn_agent",
        spawn: true,
      },
    ]);
    await parent.finish();
    await expect(
      AppaProxyHookSession.open({
        config,
        profileId: "00000000-0000-4000-8000-000000000071",
        ownerScopeHash: "v1-owner",
        clientSessionId: "missing-capability-child",
        parentClientSessionId: "capability-parent",
        modelInput: "child",
        toolResults: [],
      }),
    ).rejects.toThrow("server-issued spawn capability");
    await expect(
      AppaProxyHookSession.open({
        config,
        profileId: "00000000-0000-4000-8000-000000000071",
        ownerScopeHash: "v1-owner",
        clientSessionId: "changed-capability-child",
        parentClientSessionId: "capability-parent",
        spawnBinding: "fork_changed",
        modelInput: "child",
        toolResults: [],
      }),
    ).rejects.toThrow("unconsumed authorized spawn capability");
    const firstChild = await AppaProxyHookSession.open({
      config,
      profileId: "00000000-0000-4000-8000-000000000071",
      ownerScopeHash: "v1-owner",
      clientSessionId: "capability-child",
      parentClientSessionId: "capability-parent",
      spawnBinding: "fork_capability-spawn",
      modelInput: "child",
      toolResults: [],
    });
    await firstChild.finish();
    await expect(
      AppaProxyHookSession.open({
        config,
        profileId: "00000000-0000-4000-8000-000000000071",
        ownerScopeHash: "v1-owner",
        clientSessionId: "reused-capability-child",
        parentClientSessionId: "capability-parent",
        spawnBinding: "fork_capability-spawn",
        modelInput: "child",
        toolResults: [],
      }),
    ).rejects.toThrow("unconsumed authorized spawn capability");
  });

  test("quarantines indeterminate outcomes instead of admitting a notice", async () => {
    server.use(
      http.post(`${url}/proxy/v1/events`, async ({ request }) =>
        HttpResponse.json(await receipt(request, allowDecision)),
      ),
    );
    const first = await open("indeterminate-result");
    await first.authorizeOutboundToolCalls([call]);
    await first.finish();
    await expect(
      AppaProxyHookSession.open({
        config,
        profileId: "00000000-0000-4000-8000-000000000071",
        ownerScopeHash: "v1-owner",
        clientSessionId: "indeterminate-result",
        modelInput: "followup",
        toolResults: [
          { id: "call_v1", content: "untrusted", status: "indeterminate" },
        ],
      }),
    ).rejects.toThrow("indeterminate tool outcome quarantined");
    await expect(open("indeterminate-result")).rejects.toThrow("quarantined");
  });
});
