import { createHash, randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect } from "vitest";
import config from "@/config";
import AppaApprovalModel from "@/models/appa-approval";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import type { AppaControlPrincipal } from "@/routes/mcp-gateway/appa-controls";
import { test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  DurableAppaControlService,
  HttpAppaControlRuntime,
} from "./appa-control";

const ownerScopeHash = "appa-control-test-owner";
const effectiveArguments = { path: "/safe", overwrite: false };
const argumentsSha256 = sha256(stableStringify(effectiveArguments));
// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper for HTTP boundary tests
const mswServer = useMswServer();

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://appa.test.svc.cluster.local:18787",
    timeoutMs: 100,
    sessionHmacSecret: "synthetic-session-key".repeat(4),
  };
});

class RuntimeBoundary implements Pick<HttpAppaControlRuntime, "post"> {
  readonly events: Array<Record<string, unknown>> = [];
  unknownAfterEvent: "resolve_batch_offer" | null = null;

  async post(params: {
    eventId: string;
    requestBody: string;
    requestSha256: string;
  }): Promise<Record<string, unknown>> {
    const envelope = JSON.parse(params.requestBody) as {
      event: Record<string, unknown>;
    };
    const event = envelope.event;
    this.events.push(event);
    if (this.unknownAfterEvent === event.event)
      throw new Error("runtime outcome unknown");
    const decision = this.decision(event);
    return {
      protocol_version: 1,
      event_id: params.eventId,
      request_sha256: params.requestSha256,
      decision,
    };
  }

  private decision(event: Record<string, unknown>): Record<string, unknown> {
    if (event.event === "resolve_batch_offer") {
      return {
        decision: "batch_offer_resolved",
        batch_id: event.batch_id,
        position: event.position,
        offer_id: event.offer_id,
        tool: event.tool,
        arguments_sha256: event.arguments_sha256,
        resolution:
          event.resolution === "accept_restriction"
            ? "accepted"
            : event.resolution === "apply_sanitizer"
              ? "bound"
              : event.resolution === "approve"
                ? "approved"
                : "denied",
      };
    }
    throw new Error("unexpected runtime event");
  }
}

async function setupControl(params: {
  makeOrganization: (...args: never[]) => Promise<Record<string, string>>;
  makeUser: (...args: never[]) => Promise<Record<string, string>>;
  makeMember: (...args: never[]) => Promise<Record<string, string>>;
  makeAgent: (...args: never[]) => Promise<Record<string, string>>;
  kind?: "acceptance" | "human_approval" | "sanitizer";
  offers?: Array<"acceptance" | "sanitizer">;
  payloadRootId?: string;
}) {
  const organization = await params.makeOrganization();
  const user = await params.makeUser();
  await params.makeMember(
    user.id as never,
    organization.id as never,
    {
      role: "admin",
    } as never,
  );
  const llmAgent = await params.makeAgent({
    organizationId: organization.id,
    accessAllTools: false,
  } as never);
  const gatewayAgent = await params.makeAgent({
    organizationId: organization.id,
    accessAllTools: false,
  } as never);
  const turn = await AppaProxySessionModel.enterTurn({
    profileId: llmAgent.id,
    ownerScopeHash,
    clientSessionId: randomUUID(),
    rootId: "root-control-test",
    turnId: randomUUID(),
    maxSessionsPerOwner: 100,
  });
  const kind = params.kind ?? "acceptance";
  let approval:
    | Awaited<ReturnType<typeof AppaApprovalModel.create>>
    | undefined;
  if (kind === "human_approval") {
    await AppaProxySessionModel.createOutboundIntent({
      turn,
      calls: [
        {
          callId: "approval-candidate",
          emittedName: "filesystem.apply",
          emittedArguments: JSON.stringify(effectiveArguments),
          emittedArgumentsCanonical: stableStringify(effectiveArguments),
          appaTargetName: "filesystem.apply",
          appaTargetArguments: effectiveArguments,
        },
      ],
      maxCallsPerSession: 100,
    });
    approval = await AppaApprovalModel.create({
      organizationId: organization.id,
      sessionId: turn.session.id,
      activeTurnId: turn.turnId,
      candidateCallId: "approval-candidate",
      rootId: "root-control-test",
      tool: "filesystem.apply",
      argumentsSha256,
      offerId: "offer-accept",
    });
  }
  const parent = await AppaProxyWireModel.createFrame({
    sessionId: turn.session.id,
    ownerScopeHash,
    turnId: turn.turnId,
    kind: "model_response",
    protocol: "codex-responses",
    requestHash: "parent-request",
    idempotencyKey: `parent:${randomUUID()}`,
    payload: { held_input: "TOP_SECRET_HELD_INPUT" },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const batchId = randomUUID();
  const kinds = params.offers ?? [kind];
  const offers = kinds.map((kind, index) => ({
    id: index === 0 ? "offer-accept" : `offer-${kind}`,
    batchId,
    // One prepared call may expose multiple alternative remedies. Every offer
    // must retain that runtime-issued batch position and call identity.
    position: 0,
    callId: "runtime-call-0",
    kind,
    tool: "filesystem.apply",
    argumentsSha256,
    effectiveArguments,
  }));
  const controlFrames = await Promise.all(
    (["inspect", "execute", "status"] as const).map(async (operation) => {
      const controlCallId = `control-${operation}-${randomUUID()}`;
      const frame = await AppaProxyWireModel.createFrame({
        sessionId: turn.session.id,
        ownerScopeHash,
        turnId: turn.turnId,
        kind: "remedy_control",
        protocol: "codex-responses",
        requestHash: `control-request:${operation}`,
        idempotencyKey: `control:${controlCallId}`,
        parentFrameId: parent.id,
        controlCallId,
        runtimeBatchId: batchId,
        payload: {
          version: 1,
          purpose: "gateway_remedy",
          type: "remedy_batch",
          intent: { id: parent.id, descriptor: "safe remediation summary" },
          rootId: params.payloadRootId ?? "root-control-test",
          heldParentFrameId: parent.id,
          boundThreadId: "thread-control-test",
          boundItemId: "item-control-test",
          owner: { kind: "user", id: user.id },
          vouch: {
            operation,
            ...(operation === "execute"
              ? { chosenRemedyId: "offer-accept" }
              : {}),
          },
          offers,
          ...(approval ? { approvalId: approval.id } : {}),
        },
        expiresAt: new Date(Date.now() + 60_000),
      });
      await AppaProxyWireModel.markReady({
        sessionId: turn.session.id,
        ownerScopeHash,
        frameId: frame.id,
      });
      await AppaProxyWireModel.markIssued({
        sessionId: turn.session.id,
        ownerScopeHash,
        frameId: frame.id,
      });
      return [operation, { frame, controlCallId }] as const;
    }),
  );
  const controls = Object.fromEntries(controlFrames) as Record<
    "inspect" | "execute" | "status",
    {
      frame: Awaited<ReturnType<typeof AppaProxyWireModel.createFrame>>;
      controlCallId: string;
    }
  >;
  const principal: AppaControlPrincipal = {
    organizationId: organization.id,
    gatewayProfileId: gatewayAgent.id,
    subject: { kind: "user", id: user.id },
  };
  const runtime = new RuntimeBoundary();
  const service = new DurableAppaControlService({
    runtime,
    controlSessionSecret: "control-session-secret",
    approvalSigningSecret: "approval-signing-secret",
  });
  const controlSession = await service.authorizeControlSession({ principal });
  if (!controlSession) throw new Error("test user was not authorized");
  const requestFor = (operation: "inspect" | "execute" | "status") => ({
    principal,
    controlSession,
    wireContext: {
      callId: controls[operation].controlCallId,
      threadId: "thread-control-test",
      itemId: "item-control-test",
    },
    intentId: parent.id,
  });
  return {
    organization,
    user,
    llmAgent,
    gatewayAgent,
    turn,
    frame: controls.execute.frame,
    approval,
    batchId,
    service,
    runtime,
    request: requestFor("execute"),
    requestFor,
  };
}

describe("DurableAppaControlService", () => {
  test("uses the strict bounded HTTP runtime boundary", async () => {
    const eventId = randomUUID();
    const requestBody = JSON.stringify({
      event_id: eventId,
      event: {
        event: "resolve_batch_offer",
        root_id: "root-1",
        batch_id: randomUUID(),
        position: 0,
        offer_id: "offer-1",
        tool: "filesystem.apply",
        arguments_sha256: argumentsSha256,
        resolution: "accept_restriction",
      },
    });
    const requestSha256 = sha256(requestBody);
    mswServer.use(
      http.post(
        "http://appa-runtime.test/proxy/v1/events",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer runtime-token",
          );
          expect(request.headers.get("content-type")).toContain(
            "application/json",
          );
          expect(await request.text()).toBe(requestBody);
          return HttpResponse.json({
            protocol_version: 1,
            event_id: eventId,
            request_sha256: requestSha256,
            decision: { decision: "ack" },
          });
        },
      ),
    );
    const runtime = new HttpAppaControlRuntime({
      url: "http://appa-runtime.test",
      runtimeToken: "runtime-token",
      timeoutMs: 100,
    });

    await expect(
      runtime.post({ eventId, requestBody, requestSha256 }),
    ).resolves.toMatchObject({ decision: { decision: "ack" } });
  });

  test("rejects a mismatched HTTP runtime receipt", async () => {
    const eventId = randomUUID();
    const requestBody = JSON.stringify({
      event_id: eventId,
      event: {
        event: "resolve_batch_offer",
        root_id: "root-1",
        batch_id: randomUUID(),
        position: 0,
        offer_id: "offer-1",
        tool: "filesystem.apply",
        arguments_sha256: argumentsSha256,
        resolution: "accept_restriction",
      },
    });
    const requestSha256 = sha256(requestBody);
    mswServer.use(
      http.post("http://appa-runtime.test/proxy/v1/events", () =>
        HttpResponse.json({
          protocol_version: 1,
          event_id: randomUUID(),
          request_sha256: requestSha256,
          decision: { decision: "ack" },
        }),
      ),
    );
    const runtime = new HttpAppaControlRuntime({
      url: "http://appa-runtime.test",
      runtimeToken: "runtime-token",
      timeoutMs: 100,
    });

    await expect(
      runtime.post({ eventId, requestBody, requestSha256 }),
    ).rejects.toThrow();
  });

  test("does not retry an uncertain runtime event", async () => {
    const eventId = randomUUID();
    const requestBody = JSON.stringify({
      event_id: eventId,
      event: {
        event: "resolve_batch_offer",
        root_id: "root-1",
        batch_id: randomUUID(),
        position: 0,
        offer_id: "offer-1",
        tool: "filesystem.apply",
        arguments_sha256: argumentsSha256,
        resolution: "accept_restriction",
      },
    });
    let requests = 0;
    mswServer.use(
      http.post("http://appa-runtime.test/proxy/v1/events", () => {
        requests++;
        return HttpResponse.json(
          { error: { code: "event_uncertain" } },
          { status: 503 },
        );
      }),
    );
    const runtime = new HttpAppaControlRuntime({
      url: "http://appa-runtime.test",
      runtimeToken: "runtime-token",
      timeoutMs: 100,
    });

    await expect(
      runtime.post({
        eventId,
        requestBody,
        requestSha256: sha256(requestBody),
      }),
    ).rejects.toThrow();
    expect(requests).toBe(1);
  });

  test("resolves one stored held-batch remedy through a separate authorized MCP profile", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const context = await setupControl({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);

    const plan = await context.service.inspectPlan(
      context.requestFor("inspect"),
    );
    expect(plan).toMatchObject({ state: "complete" });
    expect(JSON.stringify(plan.result)).not.toContain("TOP_SECRET_HELD_INPUT");
    expect(JSON.stringify(plan.result)).not.toContain("/safe");

    const first = await context.service.executeSelectedNonHumanRemedy({
      ...context.request,
      remedyId: "offer-accept",
    });
    const repeated = await context.service.executeSelectedNonHumanRemedy({
      ...context.request,
      remedyId: "offer-accept",
    });

    expect(first).toEqual({
      state: "complete",
      result: { status: "completed" },
    });
    expect(repeated).toEqual({
      state: "complete",
      result: { status: "completed" },
    });
    expect(context.runtime.events).toEqual([
      {
        event: "resolve_batch_offer",
        root_id: "root-control-test",
        batch_id: context.batchId,
        position: 0,
        offer_id: "offer-accept",
        tool: "filesystem.apply",
        arguments_sha256: argumentsSha256,
        resolution: "accept_restriction",
      },
    ]);
  });

  test("rejects cross-owner and forged control metadata before dispatch", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const context = await setupControl({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const otherUser = await makeUser();
    await makeMember(
      otherUser.id as never,
      context.organization.id as never,
      {
        role: "admin",
      } as never,
    );
    const otherPrincipal: AppaControlPrincipal = {
      organizationId: context.organization.id,
      gatewayProfileId: context.gatewayAgent.id,
      subject: { kind: "user", id: otherUser.id },
    };
    const otherSession = await context.service.authorizeControlSession({
      principal: otherPrincipal,
    });
    if (!otherSession) throw new Error("test user was not authorized");

    const crossOwner = await context.service.getStatus({
      ...context.requestFor("status"),
      principal: otherPrincipal,
      controlSession: otherSession,
    });
    const forged = await context.service.getStatus({
      ...context.requestFor("status"),
      wireContext: {
        ...context.requestFor("status").wireContext,
        callId: "forged-call",
      },
    });

    expect(crossOwner).toEqual({
      state: "rejected",
      result: { status: "unavailable" },
    });
    expect(forged).toEqual({
      state: "rejected",
      result: { status: "unavailable" },
    });
    await expect(
      context.service.authorizeControlSession({
        principal: {
          ...context.request.principal,
          subject: { kind: "gateway_token", id: "gateway-token" },
        },
      }),
    ).resolves.toBeNull();
    expect(context.runtime.events).toHaveLength(0);
  });

  test("rejects a control call vouched for a different operation", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const context = await setupControl({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);

    const inspectCallUsedForExecute =
      await context.service.executeSelectedNonHumanRemedy({
        ...context.requestFor("inspect"),
        remedyId: "offer-accept",
      });
    const executeCallUsedForInspect = await context.service.inspectPlan(
      context.request,
    );

    expect(inspectCallUsedForExecute).toEqual({
      state: "rejected",
      result: { status: "unavailable" },
    });
    expect(executeCallUsedForInspect).toEqual({
      state: "rejected",
      result: { status: "unavailable" },
    });
    expect(context.runtime.events).toHaveLength(0);
  });

  test("rejects a payload whose root does not match the held parent session", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const context = await setupControl({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      payloadRootId: "forged-root",
    } as never);

    await expect(
      context.service.inspectPlan(context.requestFor("inspect")),
    ).resolves.toEqual({
      state: "rejected",
      result: { status: "unavailable" },
    });
    expect(context.runtime.events).toHaveLength(0);
  });

  test("keeps unknown runtime outcomes pending and rejects a changed selection", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const context = await setupControl({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      offers: ["acceptance", "sanitizer"],
    } as never);
    context.runtime.unknownAfterEvent = "resolve_batch_offer";

    const unknown = await context.service.executeSelectedNonHumanRemedy({
      ...context.request,
      remedyId: "offer-accept",
    });
    const duplicate = await context.service.executeSelectedNonHumanRemedy({
      ...context.request,
      remedyId: "offer-accept",
    });
    const changed = await context.service.executeSelectedNonHumanRemedy({
      ...context.request,
      remedyId: "offer-sanitizer",
    });

    expect(unknown).toEqual({
      state: "pending",
      result: { status: "pending" },
    });
    expect(duplicate).toEqual({
      state: "pending",
      result: { status: "pending" },
    });
    expect(changed).toEqual({
      state: "rejected",
      result: { status: "unavailable" },
    });
    expect(context.runtime.events).toHaveLength(1);
  });

  test("records fixed registry discovery only as a local observation", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const context = await setupControl({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    } as never);
    const observation = await AppaProxyWireModel.recordLocalObservation({
      sessionId: context.turn.session.id,
      ownerScopeHash,
      turnId: context.turn.turnId,
      idempotencyKey: "native-registry-observation",
      tools: { filesystem_apply: {}, search: {} },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const stored = await AppaProxyWireModel.findOwned({
      sessionId: context.turn.session.id,
      ownerScopeHash,
      frameId: observation.id,
    });
    if (!stored) throw new Error("local observation was not persisted");

    expect(observation.kind).toBe("inbound_hold");
    expect(observation.receiptCiphertext).toBeNull();
    expect(stored.payload).toMatchObject({
      purpose: "client_local_observation",
      type: "registry_discovery",
      program: "text(JSON.stringify(Object.keys(tools)));",
      outputText: '["filesystem_apply","search"]',
    });
    await expect(
      AppaProxyWireModel.beginControlExecution({
        sessionId: context.turn.session.id,
        ownerScopeHash,
        frameId: observation.id,
        selection: { offer_id: "forged" },
      }),
    ).rejects.toThrow("not owned");

    const bootstrapControlCallId = `bootstrap-${randomUUID()}`;
    const misclassified = await AppaProxyWireModel.createFrame({
      sessionId: context.turn.session.id,
      ownerScopeHash,
      turnId: context.turn.turnId,
      kind: "remedy_control",
      protocol: "client-local-observation/v1",
      requestHash: "bootstrap-request",
      idempotencyKey: `bootstrap:${bootstrapControlCallId}`,
      parentFrameId: context.frame.parentFrameId ?? undefined,
      controlCallId: bootstrapControlCallId,
      payload: stored.payload,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await AppaProxyWireModel.markReady({
      sessionId: context.turn.session.id,
      ownerScopeHash,
      frameId: misclassified.id,
    });
    await AppaProxyWireModel.markIssued({
      sessionId: context.turn.session.id,
      ownerScopeHash,
      frameId: misclassified.id,
    });
    const rejectedBootstrap =
      await context.service.executeSelectedNonHumanRemedy({
        ...context.request,
        intentId: bootstrapControlCallId,
        wireContext: {
          ...context.request.wireContext,
          callId: bootstrapControlCallId,
        },
        remedyId: "forged",
      });

    expect(rejectedBootstrap).toEqual({
      state: "rejected",
      result: { status: "unavailable" },
    });
    expect(context.runtime.events).toHaveLength(0);
  });

  test("requires an approved user-session record and sends a batch-position-bound grant", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const context = await setupControl({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      kind: "human_approval",
    } as never);
    const execution = context.service.executeSelectedNonHumanRemedy({
      ...context.request,
      remedyId: "offer-accept",
    });

    if (!context.approval)
      throw new Error("human control did not issue approval");
    await AppaApprovalModel.decide({
      organizationId: context.organization.id,
      id: context.approval.id,
      userId: context.user.id,
      isAgentAdmin: true,
      approverId: context.user.id,
      decision: "approve",
      audit: {
        actorName: null,
        actorEmail: "reviewer@example.test",
        actorType: "user",
        impersonatedBy: null,
        requestId: "test-request",
        httpPath: "/api/appa-approvals/test/decision",
      },
    });

    const result = await execution;
    expect(result).toEqual({
      state: "complete",
      result: { status: "completed" },
    });
    const resolution = context.runtime.events.find(
      (event) => event.event === "resolve_batch_offer",
    );
    expect(resolution).toMatchObject({
      batch_id: context.batchId,
      position: 0,
      resolution: "approve",
      approval: {
        approval_id: context.approval.id,
        batch_id: context.batchId,
        position: 0,
      },
    });
    expect((resolution?.approval as Record<string, unknown>).signature).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
