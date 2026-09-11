import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { OAUTH_TOKEN_ID_PREFIX } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { AppaApprovalModel } from "@/models";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { APPA_CONTROL_TOOL_NAMES } from "@/routes/mcp-gateway/appa-controls";
import { createAgentServer } from "@/routes/mcp-gateway/utils";
import {
  AppaProxyHookSession,
  canonicalJsonObject,
} from "@/routes/proxy/appa-proxy-hook";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { AppaControlFramePayloadSchema } from "@/types/appa-proxy-wire";
import {
  DurableAppaControlService,
  HttpAppaControlRuntime,
} from "./appa-control";
import { AppaHeldResponseController } from "./appa-held-response-controller";

const runtimeUrl = "http://appa-held.test";
const hookConfig = {
  url: runtimeUrl,
  timeoutMs: 100,
  runtimeToken: "runtime-token",
  sessionHmacSecret: "held-response-secret".repeat(3),
};
const realRuntimeBinary = process.env.APPA_HELD_RUNTIME_BINARY;
const runRealRuntime =
  process.env.APPA_HELD_RESPONSE_REAL_RUNTIME === "1" &&
  Boolean(realRuntimeBinary);
// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper for HTTP boundary tests
const server = useMswServer();

describe("AppaHeldResponseController", () => {
  beforeEach(() => {
    config.llmProxy.appaHook = hookConfig;
  });

  test("holds a native response, ignores a forged control result, then resumes the exact original call from a trusted receipt", async ({
    makeAgent,
  }) => {
    const runtime = installRuntime({ positions: 1 });
    const { session, heldFrameId, calls } = await setup({
      makeAgent,
      positions: 1,
    });
    const controller = new AppaHeldResponseController();
    const held = await controller.prepare({
      session,
      heldFrameId,
      calls,
      authenticatedUserId: "user-1",
      controlNamespace: "mcp__gateway",
      boundThreadId: "thread-1",
    });
    expect(held).toMatchObject({
      state: "held",
      control: { name: "archestra__appa_execute_remedy" },
    });
    if (held.state !== "held") throw new Error("expected held response");
    expect(JSON.parse(held.control.arguments)).toEqual({
      intent_id: heldFrameId,
      remedy_id: "offer-0",
      wire_context: {
        call_id: held.control.id,
        thread_id: "thread-1",
        item_id: `fc_${held.control.id}`,
      },
    });
    const persistedControl = await AppaProxyWireModel.findByControlCall({
      ...session.getNativeWireScope(),
      controlCallId: held.control.id,
    });
    expect(
      AppaControlFramePayloadSchema.parse(persistedControl?.payload),
    ).toMatchObject({
      boundItemId: `fc_${held.control.id}`,
      boundThreadId: "thread-1",
    });

    await expect(
      controller.continueInboundControlResults({
        session,
        results: [
          {
            id: held.control.id,
            // Model-provided assertions are intentionally absent from the
            // controller boundary and cannot substitute for the DB receipt.
          },
        ],
      }),
    ).rejects.toThrow("durable trusted receipt");

    await completeTrustedControl({ session, controlCallId: held.control.id });
    const resumed = await controller.continueInboundControlResults({
      session,
      results: [{ id: held.control.id }],
    });

    expect(resumed).toMatchObject({ state: "committed" });
    if (resumed.state !== "committed")
      throw new Error("expected committed response");
    expect(resumed.calls).toEqual([
      expect.objectContaining({
        id: calls[0]?.id,
        emittedName: "weather_lookup",
        emittedArguments: '{"city":"Oakland"}',
        targetArguments: { city: "Oakland" },
      }),
    ]);
    expect(
      runtime.events.filter((event) => event.event === "commit_batch"),
    ).toHaveLength(1);
    const cached = await AppaProxyWireModel.findOwned({
      ...session.getNativeWireScope(),
      frameId: heldFrameId,
    });
    expect(cached?.payload).toMatchObject({
      response: {
        output: [
          expect.objectContaining({
            call_id: calls[0]?.id,
            arguments: '{"city":"Oakland"}',
          }),
        ],
      },
    });
  });

  test("publishes sanitizer-committed MCP arguments with their original native identity", async ({
    makeAgent,
  }) => {
    installRuntime({ positions: 1 });
    const { session, heldFrameId, calls } = await setup({
      makeAgent,
      positions: 1,
    });
    const call = calls[0];
    if (!call) throw new Error("expected held business call");
    const [alias] = await AppaProxyWireModel.addAliases({
      ...session.getNativeWireScope(),
      frameId: heldFrameId,
      aliases: [
        {
          kind: "call",
          position: 0,
          wireId: call.id,
          logicalId: "provider-call",
          metadata: {
            purpose: "native_call",
            providerCallId: "provider-call",
            providerItemId: "provider-item",
            principalUserId: "credential-user",
            threadId: "durable-thread",
            itemId: `fc_${call.id}`,
            toolName: "weather_lookup",
            argumentsCanonical: call.emittedArgumentsCanonical,
          },
        },
      ],
    });
    if (!alias) throw new Error("expected native MCP alias");
    const controller = new AppaHeldResponseController();
    const held = await controller.prepare({
      session,
      heldFrameId,
      calls,
      authenticatedUserId: "user-finalize",
      controlNamespace: "mcp__gateway",
      boundThreadId: "durable-thread",
    });
    if (held.state !== "held") throw new Error("expected held response");
    await completeTrustedControl({ session, controlCallId: held.control.id });
    const committed = await controller.continueFromControlResult({
      session,
      heldFrameId,
      controlCallId: held.control.id,
    });
    expect(committed).toMatchObject({ state: "committed" });
    const issuedBeforeReplay = (
      await AppaProxyWireModel.listIssuedAliases(session.getNativeWireScope())
    ).find((entry) => entry.id === alias.id);
    expect(issuedBeforeReplay?.metadata).toMatchObject({
      providerCallId: "provider-call",
      providerItemId: "provider-item",
      principalUserId: "credential-user",
      threadId: "durable-thread",
      itemId: `fc_${call.id}`,
      toolName: "weather_lookup",
      argumentsCanonical: '{"city":"Oakland"}',
    });
    const replay = await controller.continueFromControlResult({
      session,
      heldFrameId,
      controlCallId: held.control.id,
    });
    expect(replay).toMatchObject({ state: "committed" });
    const issuedAfterReplay = (
      await AppaProxyWireModel.listIssuedAliases(session.getNativeWireScope())
    ).find((entry) => entry.id === alias.id);
    expect(issuedAfterReplay?.metadata).toEqual(issuedBeforeReplay?.metadata);
    await expect(
      AppaProxyWireModel.claimNativeMcpExecution({
        ...session.getNativeWireScope(),
        aliasId: alias.id,
        callId: call.id,
        expectedExecutionArgumentsCanonical: call.emittedArgumentsCanonical,
      }),
    ).rejects.toThrow("binding changed");
    await expect(
      AppaProxyWireModel.claimNativeMcpExecution({
        ...session.getNativeWireScope(),
        aliasId: alias.id,
        callId: call.id,
        expectedExecutionArgumentsCanonical: '{"city":"Oakland"}',
      }),
    ).resolves.toMatchObject({ state: "acquired" });
  });

  test("requires every withheld position and serializes concurrent continuations", async ({
    makeAgent,
  }) => {
    const runtime = installRuntime({ positions: 2 });
    const { session, heldFrameId, calls } = await setup({
      makeAgent,
      positions: 2,
    });
    const controller = new AppaHeldResponseController();
    const held = await controller.prepare({
      session,
      heldFrameId,
      calls,
      authenticatedUserId: "user-2",
      controlNamespace: "mcp__gateway",
      boundThreadId: "thread-2",
    });
    if (held.state !== "held") throw new Error("expected held response");
    await completeTrustedControl({ session, controlCallId: held.control.id });
    const next = await controller.continueFromControlResult({
      session,
      heldFrameId,
      controlCallId: held.control.id,
    });
    expect(next).toMatchObject({ state: "held" });
    if (next.state !== "held") throw new Error("expected next control");
    await completeTrustedControl({ session, controlCallId: next.control.id });
    const concurrent = await Promise.all([
      controller.continueFromControlResult({
        session,
        heldFrameId,
        controlCallId: next.control.id,
      }),
      controller.continueFromControlResult({
        session,
        heldFrameId,
        controlCallId: next.control.id,
      }),
    ]);

    expect(concurrent.map((result) => result.state).sort()).toEqual([
      "committed",
      "pending",
    ]);
    expect(
      runtime.events.filter((event) => event.event === "commit_batch"),
    ).toHaveLength(1);
    const replay = await controller.continueFromControlResult({
      session,
      heldFrameId,
      controlCallId: next.control.id,
    });
    expect(replay).toMatchObject({
      state: "committed",
      calls: [
        {
          id: calls[0]?.id,
          emittedArguments: '{"city":"Oakland"}',
          targetArguments: { city: "Oakland" },
        },
        {
          id: calls[1]?.id,
          emittedArguments: '{"city":"Berkeley"}',
          targetArguments: { city: "Berkeley" },
        },
      ],
    });
  });

  test("rejects an unverified owner, namespace, unknown receipt, and unknown operation", async ({
    makeAgent,
  }) => {
    installRuntime({ positions: 1 });
    const { session, heldFrameId, calls } = await setup({
      makeAgent,
      positions: 1,
    });
    const controller = new AppaHeldResponseController();
    await expect(
      controller.prepare({
        session,
        heldFrameId,
        calls,
        authenticatedUserId: "",
        controlNamespace: "mcp__gateway",
        boundThreadId: "thread",
      }),
    ).rejects.toThrow("authenticated user");
    const held = await controller.prepare({
      session,
      heldFrameId,
      calls,
      authenticatedUserId: "user-3",
      controlNamespace: "mcp__gateway",
      boundThreadId: "thread",
    });
    if (held.state !== "held") throw new Error("expected held response");
    await expect(
      controller.issueControl({
        session,
        heldFrameId,
        authenticatedUserId: "different-user",
        controlNamespace: "mcp__gateway",
        boundThreadId: "thread",
        operation: "status",
      }),
    ).rejects.toThrow("another authenticated user");
    await expect(
      controller.issueControl({
        session,
        heldFrameId,
        authenticatedUserId: "user-3",
        controlNamespace: "not-a-discovered-namespace",
        boundThreadId: "thread",
        operation: "status",
      }),
    ).rejects.toThrow("registered APPA control namespace");
    await expect(
      controller.issueControl({
        session,
        heldFrameId,
        authenticatedUserId: "user-3",
        controlNamespace: "mcp__gateway",
        boundThreadId: "thread",
        operation: "execute",
        remedyId: "unknown-offer",
      }),
    ).rejects.toThrow("not in the held batch");
    await expect(
      controller.continueFromControlResult({
        session,
        heldFrameId,
        controlCallId: "unknown-control-call",
      }),
    ).rejects.toThrow("durable trusted receipt");
  });

  test("binds a human remedy voucher to the pre-created exact call approval", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    installRuntime({ positions: 1, kind: "human_approval" });
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(
      user.id as never,
      organization.id as never,
      {
        role: "admin",
      } as never,
    );
    const agent = await makeAgent({ organizationId: organization.id } as never);
    const { session, heldFrameId, calls } = await setup({
      makeAgent: async () => agent,
      positions: 1,
    });
    const held = await new AppaHeldResponseController().prepare({
      session,
      heldFrameId,
      calls,
      organizationId: organization.id,
      authenticatedUserId: user.id,
      controlNamespace: "mcp__gateway",
      boundThreadId: "thread-human",
    });
    expect(held).toMatchObject({ state: "held" });
    if (held.state !== "held") throw new Error("expected held response");
    const control = await AppaProxyWireModel.findByControlCall({
      ...session.getNativeWireScope(),
      controlCallId: held.control.id,
    });
    const payload = AppaControlFramePayloadSchema.parse(control?.payload);
    expect(payload.approvalId).toBeTypeOf("string");
    await AppaApprovalModel.decide({
      organizationId: organization.id,
      id: payload.approvalId ?? "",
      userId: user.id,
      isAgentAdmin: true,
      approverId: user.id,
      decision: "approve",
      audit: {
        actorName: null,
        actorEmail: "reviewer@example.test",
        actorType: "user",
        impersonatedBy: null,
        requestId: "human-voucher-test",
        httpPath: "/api/appa-approvals/test/decision",
      },
    });
    const approval = await AppaApprovalModel.getForTurn({
      id: payload.approvalId ?? "",
      sessionId: session.getNativeWireScope().sessionId,
      activeTurnId: session.getNativeWireScope().turnId,
    });
    expect(approval).toMatchObject({
      candidateCallId: calls[0]?.id,
      offerId: "offer-0",
      tool: "weather_lookup",
    });
  });

  test("connects the held voucher through the gateway dispatcher and HTTP runtime service", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    installRuntime({ positions: 1 });
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(
      user.id as never,
      organization.id as never,
      {
        role: "admin",
      } as never,
    );
    const agent = await makeAgent({ organizationId: organization.id } as never);
    const { session, heldFrameId, calls } = await setup({
      makeAgent: async () => agent,
      positions: 1,
    });
    const held = await new AppaHeldResponseController().prepare({
      session,
      heldFrameId,
      calls,
      organizationId: organization.id,
      authenticatedUserId: user.id,
      controlNamespace: "mcp__gateway",
      boundThreadId: "thread-gateway",
    });
    if (held.state !== "held") throw new Error("expected held response");
    const control = new DurableAppaControlService({
      runtime: new HttpAppaControlRuntime({
        url: runtimeUrl,
        runtimeToken: "runtime-token",
        timeoutMs: 100,
      }),
      controlSessionSecret: "gateway-control-session-secret".repeat(3),
    });
    const { server: gateway } = await createAgentServer({
      agentId: agent.id,
      tokenAuth: {
        tokenId: `${OAUTH_TOKEN_ID_PREFIX}${randomUUID()}`,
        teamId: null,
        isOrganizationToken: false,
        organizationId: organization.id,
        isUserToken: true,
        userId: user.id,
      },
      appaControls: control,
    });
    const dispatch = (
      gateway as unknown as {
        server: {
          _requestHandlers: Map<
            string,
            (
              request: unknown,
              extra: unknown,
            ) => Promise<Record<string, unknown>>
          >;
        };
      }
    ).server._requestHandlers.get("tools/call");
    if (!dispatch) throw new Error("gateway tool dispatcher is unavailable");
    const result = await dispatch(
      {
        method: "tools/call",
        params: {
          name: APPA_CONTROL_TOOL_NAMES.executeRemedy,
          arguments: JSON.parse(held.control.arguments),
          _meta: { callId: held.control.id, threadId: "thread-gateway" },
        },
      },
      {},
    );
    expect(result).toMatchObject({
      isError: false,
      structuredContent: { status: "completed" },
    });
    await expect(
      new AppaHeldResponseController().continueInboundControlResults({
        session,
        results: [{ id: held.control.id }],
      }),
    ).resolves.toMatchObject({ state: "committed" });
  });

  test("claims an occupied held turn without allowing an ordinary new turn", async ({
    makeAgent,
  }) => {
    installRuntime({ positions: 1 });
    const { session, profileId, clientSessionId } = await setup({
      makeAgent,
      positions: 1,
    });
    const scope = session.getNativeWireScope();
    const continuation = await AppaProxyHookSession.claimHeldContinuation({
      config: hookConfig,
      ...scope,
    });
    expect(continuation.rootId).toBe(session.rootId);
    await expect(
      AppaProxyHookSession.acquire({
        config: hookConfig,
        profileId,
        ownerScopeHash: scope.ownerScopeHash,
        clientSessionId,
        toolResults: [],
      }),
    ).rejects.toThrow("active turn");
  });

  test("continues a completed control before ordinary admission using only its durable binding", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    installRuntime({ positions: 1 });
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(
      user.id as never,
      organization.id as never,
      {
        role: "admin",
      } as never,
    );
    const agent = await makeAgent({
      organizationId: organization.id,
      accessAllTools: false,
    } as never);
    const { session, heldFrameId, calls } = await setup({
      makeAgent: async () => agent,
      positions: 1,
    });
    const controller = new AppaHeldResponseController();
    const held = await controller.prepare({
      session,
      heldFrameId,
      calls,
      authenticatedUserId: user.id,
      controlNamespace: "mcp__gateway",
      boundThreadId: "thread-authenticated",
    });
    if (held.state !== "held") throw new Error("expected held response");
    await expect(
      controller.continueBeforeAcquire({
        config: hookConfig,
        organizationId: organization.id,
        authenticatedUserId: user.id,
        profileId: agent.id,
        ownerScopeHash: session.getNativeWireScope().ownerScopeHash,
        threadId: "thread-authenticated",
        controlItemIds: new Map([[held.control.id, "at_first_history_item"]]),
        results: [{ id: held.control.id }],
      }),
    ).resolves.toEqual({ state: "rejected" });
    await expect(
      controller.continueBeforeAcquire({
        config: hookConfig,
        organizationId: organization.id,
        authenticatedUserId: user.id,
        profileId: agent.id,
        ownerScopeHash: session.getNativeWireScope().ownerScopeHash,
        threadId: "thread-authenticated",
        controlItemIds: controlItemIds(held.control.id),
        results: [{ id: held.control.id }, { id: "unknown-control-result" }],
      }),
    ).resolves.toEqual({ state: "rejected" });
    await expect(
      controller.continueBeforeAcquire({
        config: hookConfig,
        organizationId: organization.id,
        authenticatedUserId: user.id,
        profileId: agent.id,
        ownerScopeHash: "another-credential-owner",
        threadId: "thread-authenticated",
        controlItemIds: controlItemIds(held.control.id),
        results: [{ id: held.control.id }],
      }),
    ).resolves.toEqual({ state: "rejected" });
    const execute = await controller.issueControl({
      session,
      heldFrameId,
      authenticatedUserId: user.id,
      controlNamespace: "mcp__gateway",
      boundThreadId: "thread-authenticated",
      operation: "execute",
      remedyId: "offer-0",
    });
    await completeTrustedControl({ session, controlCallId: execute.id });

    await expect(
      controller.continueBeforeAcquire({
        config: hookConfig,
        organizationId: organization.id,
        authenticatedUserId: "forged-user-id",
        profileId: agent.id,
        ownerScopeHash: session.getNativeWireScope().ownerScopeHash,
        threadId: "thread-authenticated",
        controlItemIds: controlItemIds(execute.id),
        results: [{ id: execute.id }],
      }),
    ).resolves.toEqual({ state: "rejected" });
    for (const binding of [
      {
        profileId: randomUUID(),
        ownerScopeHash: session.getNativeWireScope().ownerScopeHash,
      },
      { profileId: agent.id, ownerScopeHash: "another-credential-owner" },
    ]) {
      await expect(
        controller.continueBeforeAcquire({
          config: hookConfig,
          organizationId: organization.id,
          authenticatedUserId: user.id,
          ...binding,
          threadId: "thread-authenticated",
          controlItemIds: controlItemIds(execute.id),
          results: [{ id: execute.id }],
        }),
      ).resolves.toEqual({ state: "rejected" });
    }
    const continued = await controller.continueBeforeAcquire({
      config: hookConfig,
      organizationId: organization.id,
      authenticatedUserId: user.id,
      profileId: agent.id,
      ownerScopeHash: session.getNativeWireScope().ownerScopeHash,
      threadId: "thread-authenticated",
      controlItemIds: controlItemIds(execute.id),
      results: [{ id: execute.id }],
    });
    expect(continued).toMatchObject({ state: "committed", heldFrameId });
    if (continued.state !== "committed")
      throw new Error("expected committed continuation");
    expect(continued.session.rootId).toBe(session.rootId);
  });

  test("classifies every completed same-scope remedy in full history as historical after its parent commits", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const runtime = installRuntime({ positions: 2 });
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(
      user.id as never,
      organization.id as never,
      { role: "admin" } as never,
    );
    const agent = await makeAgent({
      organizationId: organization.id,
      accessAllTools: false,
    } as never);
    const { session, heldFrameId, calls } = await setup({
      makeAgent: async () => agent,
      positions: 2,
    });
    const businessResultId = calls[0]?.id;
    if (!businessResultId) throw new Error("expected held business call");
    const controller = new AppaHeldResponseController();
    const first = await controller.prepare({
      session,
      heldFrameId,
      calls,
      authenticatedUserId: user.id,
      controlNamespace: "mcp__gateway",
      boundThreadId: "thread-history",
    });
    if (first.state !== "held") throw new Error("expected first control");
    await completeTrustedControl({ session, controlCallId: first.control.id });
    const second = await controller.continueFromControlResult({
      session,
      heldFrameId,
      controlCallId: first.control.id,
    });
    if (second.state !== "held") throw new Error("expected second control");
    await completeTrustedControl({ session, controlCallId: second.control.id });

    const committed = await controller.continueBeforeAcquire({
      config: hookConfig,
      organizationId: organization.id,
      authenticatedUserId: user.id,
      profileId: agent.id,
      ownerScopeHash: session.getNativeWireScope().ownerScopeHash,
      threadId: "thread-history",
      controlItemIds: controlItemIds(first.control.id, second.control.id),
      results: [{ id: first.control.id }, { id: second.control.id }],
    });
    expect(committed).toMatchObject({ state: "committed", heldFrameId });
    if (committed.state !== "committed")
      throw new Error("expected committed continuation");
    await committed.session.finish();

    await expect(
      controller.continueBeforeAcquire({
        config: hookConfig,
        organizationId: organization.id,
        authenticatedUserId: user.id,
        profileId: agent.id,
        ownerScopeHash: session.getNativeWireScope().ownerScopeHash,
        threadId: "thread-history",
        controlItemIds: controlItemIds(first.control.id, second.control.id),
        results: [
          { id: first.control.id },
          { id: second.control.id },
          // This is new client business output, not a prior APPA admission.
          // Historical controls must not prevent its later ordinary admission.
          { id: businessResultId },
        ],
      }),
    ).resolves.toEqual({
      state: "historical",
      controlCallIds: [first.control.id, second.control.id],
    });
    expect(
      runtime.events.filter((event) => event.event === "commit_batch"),
    ).toHaveLength(1);
  });
});

describe.skipIf(!runRealRuntime)(
  "AppaHeldResponseController real runtime integration",
  () => {
    test("resolves and releases one runtime-held call through the HTTP control service", async ({
      makeAgent,
      makeMember,
      makeOrganization,
      makeUser,
    }) => {
      const root = await mkdtemp(path.join(tmpdir(), "appa-held-runtime-"));
      const policyPath = path.join(root, "appa.toml");
      const runtimeDb = path.join(root, "runtime.sqlite");
      const runtimeToken = "held-runtime-token-0123456789".repeat(2);
      const approvalSecret = "held-runtime-approval-secret-0123456789abcdef";
      const port = await reserveLoopbackPort();
      const runtimeUrl = `http://127.0.0.1:${port}`;
      let runtime: ReturnType<typeof spawn> | undefined;
      let stderr = "";
      try {
        // This proof must reach the source-built runtime, not this file's MSW
        // protocol fixtures.
        server.close();
        await writeFile(
          policyPath,
          `[policy]\nversion = 2\n\n[[policy.tool]]\nname = "held_release"\ndelta = { trust = "suspicious" }\n\n[externals]\ntimeout_ms = 1000\nreview_timeout_ms = 10000\nmax_body_bytes = 65536\n`,
          "utf8",
        );
        runtime = spawn(
          requiredEnv(realRuntimeBinary, "APPA_HELD_RUNTIME_BINARY"),
          [
            "runtime",
            "--adapter",
            "kagent",
            "--config",
            policyPath,
            "--db",
            runtimeDb,
            "--listen",
            `127.0.0.1:${port}`,
          ],
          {
            stdio: ["ignore", "ignore", "pipe"],
            env: {
              PATH: process.env.PATH,
              APPA_PROXY_TOKEN: runtimeToken,
              APPA_PROXY_APPROVAL_SECRET: approvalSecret,
            },
          },
        );
        runtime.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        await waitForRuntime(runtimeUrl, runtime, () => stderr);

        const organization = await makeOrganization();
        const user = await makeUser();
        await makeMember(
          user.id as never,
          organization.id as never,
          {
            role: "admin",
          } as never,
        );
        const agent = await makeAgent({
          organizationId: organization.id,
          accessAllTools: false,
        } as never);
        const runtimeConfig = {
          url: runtimeUrl,
          timeoutMs: 10_000,
          runtimeToken,
          approvalSigningSecret: approvalSecret,
          sessionHmacSecret: "held-real-runtime-session-secret".repeat(3),
        };
        config.llmProxy.appaHook = runtimeConfig;
        const session = await AppaProxyHookSession.open({
          config: runtimeConfig,
          profileId: agent.id,
          organizationId: organization.id,
          ownerScopeHash: `real-held-owner-${randomUUID()}`,
          clientSessionId: `real-held-thread-${randomUUID()}`,
          modelInput: { input: "real held call" },
          toolResults: [],
        });
        const scope = session.getNativeWireScope();
        const emittedArguments = '{"destination":"internal"}';
        const call = {
          id: `call-${randomUUID()}`,
          emittedName: "held_release",
          emittedArguments,
          emittedArgumentsCanonical: canonicalJsonObject(emittedArguments),
          targetName: "held_release",
          targetArguments: { destination: "internal" },
        };
        const frame = await AppaProxyWireModel.createFrame({
          ...scope,
          kind: "model_response",
          protocol: "codex-native-response/v1",
          requestHash: "real-runtime-response",
          idempotencyKey: `real-held-parent:${scope.turnId}`,
          payload: {
            calls: [
              {
                id: call.id,
                name: call.emittedName,
                arguments: emittedArguments,
              },
            ],
            response: {
              output: [
                {
                  type: "function_call",
                  call_id: call.id,
                  name: call.emittedName,
                  arguments: emittedArguments,
                },
              ],
            },
          },
          expiresAt: new Date(Date.now() + 60_000),
        });
        const controller = new AppaHeldResponseController();
        const held = await controller.prepare({
          session,
          heldFrameId: frame.id,
          calls: [call],
          authenticatedUserId: user.id,
          controlNamespace: "mcp__gateway",
          boundThreadId: "real-held-thread",
        });
        expect(held).toMatchObject({ state: "held" });
        if (held.state !== "held") throw new Error("runtime did not hold call");
        const inspect = await AppaProxyWireModel.findByControlCall({
          ...scope,
          controlCallId: held.control.id,
        });
        const inspectPayload = AppaControlFramePayloadSchema.safeParse(
          inspect?.payload,
        );
        const remedyId = inspectPayload.success
          ? inspectPayload.data.offers[0]?.id
          : undefined;
        if (!remedyId) throw new Error("runtime held call has no remedy");
        expect(held.control).toMatchObject({
          name: "archestra__appa_execute_remedy",
          arguments: JSON.stringify({
            intent_id: frame.id,
            remedy_id: remedyId,
            wire_context: {
              call_id: held.control.id,
              thread_id: "real-held-thread",
              item_id: `fc_${held.control.id}`,
            },
          }),
        });
        const controls = new DurableAppaControlService({
          runtime: new HttpAppaControlRuntime({
            url: runtimeUrl,
            runtimeToken,
            timeoutMs: 10_000,
          }),
          controlSessionSecret: "real-control-session-secret".repeat(3),
          approvalSigningSecret: approvalSecret,
        });
        const principal = {
          organizationId: organization.id,
          gatewayProfileId: agent.id,
          subject: { kind: "user" as const, id: user.id },
        };
        const controlSession = await controls.authorizeControlSession({
          principal,
        });
        if (!controlSession)
          throw new Error("control session was not authorized");
        const operation = await controls.executeSelectedNonHumanRemedy({
          principal,
          controlSession,
          wireContext: {
            callId: held.control.id,
            threadId: "real-held-thread",
            itemId: `fc_${held.control.id}`,
          },
          intentId: frame.id,
          remedyId,
        });
        expect(operation).toMatchObject({ state: "complete" });
        const continued = await controller.continueFromControlResult({
          session,
          heldFrameId: frame.id,
          controlCallId: held.control.id,
        });
        expect(continued).toMatchObject({ state: "committed" });
        if (continued.state !== "committed")
          throw new Error("held runtime call was not committed");
        expect(continued.calls).toEqual([
          expect.objectContaining({
            id: call.id,
            emittedArguments,
            targetArguments: { destination: "internal" },
          }),
        ]);
      } finally {
        await stopProcess(runtime);
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

function installRuntime(params: {
  positions: number;
  kind?: "sanitizer" | "human_approval";
}) {
  const events: Array<Record<string, unknown>> = [];
  const preparedBatches = new Map<
    string,
    Array<{ call_id: string; tool: string; arguments: Record<string, unknown> }>
  >();
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
        sanitized_results: true,
        child_workflows: false,
      }),
    ),
    http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
      const requestBody = await request.text();
      const envelope = JSON.parse(requestBody) as {
        event_id: string;
        event: Record<string, unknown>;
      };
      events.push(envelope.event);
      const prepared = envelope.event.calls as
        | Array<{
            call_id: string;
            tool: string;
            arguments: Record<string, unknown>;
          }>
        | undefined;
      const batchId = String(envelope.event.batch_id ?? "");
      if (envelope.event.event === "prepare_batch" && prepared) {
        preparedBatches.set(batchId, prepared);
      }
      const calls = preparedBatches.get(batchId) ?? [];
      const decision =
        envelope.event.event === "prepare_batch"
          ? {
              decision: "batch_prepared",
              batch_id: batchId,
              root_id: envelope.event.root_id,
              next: "resolve_batch_offer or commit_batch",
              positions: calls.map((call, position) => ({
                position,
                call_id: call.call_id,
                state: "blocked",
                tool: call.tool,
                arguments_sha256: sha256(call.arguments),
                feedback: "requires sanitizer",
                offers: [
                  {
                    offer_id: `offer-${position}`,
                    kind: params.kind ?? "sanitizer",
                    root_id: envelope.event.root_id,
                    tool: call.tool,
                    arguments_sha256: sha256(call.arguments),
                    batch_id: batchId,
                    position,
                  },
                ],
                review: [],
              })),
            }
          : envelope.event.event === "resolve_batch_offer"
            ? {
                decision: "batch_offer_resolved",
                batch_id: envelope.event.batch_id,
                position: envelope.event.position,
                offer_id: envelope.event.offer_id,
                tool: envelope.event.tool,
                arguments_sha256: envelope.event.arguments_sha256,
                resolution:
                  envelope.event.resolution === "accept_restriction"
                    ? "accepted"
                    : envelope.event.resolution === "apply_sanitizer"
                      ? "bound"
                      : envelope.event.resolution === "approve"
                        ? "approved"
                        : "denied",
              }
            : envelope.event.event === "commit_batch"
              ? {
                  decision: "batch_committed",
                  batch_id: batchId,
                  calls: calls.map((call, position) => {
                    const arguments_ = {
                      city: position === 0 ? "Oakland" : "Berkeley",
                    };
                    return {
                      position,
                      call_id: call.call_id,
                      dispatch_id: `dispatch-${call.call_id}`,
                      tool: call.tool,
                      arguments_sha256: sha256(arguments_),
                      arguments: arguments_,
                      spawn_binding: null,
                    };
                  }),
                }
              : { decision: "ack" };
      return HttpResponse.json({
        protocol_version: 1,
        event_id: envelope.event_id,
        request_sha256: createHash("sha256").update(requestBody).digest("hex"),
        decision,
      });
    }),
  );
  return { events };
}

function sha256(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJsonObject(JSON.stringify(value)))
    .digest("hex");
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") {
    throw new Error("could not reserve runtime port");
  }
  return address.port;
}

async function waitForRuntime(
  runtimeUrl: string,
  runtime: ReturnType<typeof spawn>,
  getStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (runtime.exitCode !== null) {
      throw new Error(`runtime exited: ${getStderr()}`);
    }
    try {
      const response = await fetch(`${runtimeUrl}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return;
    } catch {
      // The source-built runtime is still binding its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`runtime did not become ready: ${getStderr()}`);
}

async function stopProcess(
  runtime: ReturnType<typeof spawn> | undefined,
): Promise<void> {
  if (!runtime || runtime.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    runtime.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    runtime.kill("SIGTERM");
  });
}

async function setup(params: { makeAgent: unknown; positions: number }) {
  const agent = await (params.makeAgent as () => Promise<{ id: string }>)();
  const clientSessionId = `thread-${randomUUID()}`;
  const session = await AppaProxyHookSession.open({
    config: hookConfig,
    profileId: agent.id,
    ownerScopeHash: `owner-${randomUUID()}`,
    clientSessionId,
    modelInput: { input: "held native response" },
    toolResults: [],
  });
  const scope = session.getNativeWireScope();
  const calls = Array.from({ length: params.positions }, (_, position) => {
    const emittedArguments = JSON.stringify({ city: `Original-${position}` });
    return {
      id: `call-${position}-${randomUUID()}`,
      emittedName: "weather_lookup",
      emittedArguments,
      emittedArgumentsCanonical: canonicalJsonObject(emittedArguments),
      targetName: "weather_lookup",
      targetArguments: { city: `Original-${position}` },
    };
  });
  const frame = await AppaProxyWireModel.createFrame({
    ...scope,
    kind: "model_response",
    protocol: "codex-native-response/v1",
    requestHash: "provider-response",
    idempotencyKey: `held-parent:${scope.turnId}`,
    payload: {
      response: {
        output: calls.map((call) => ({
          id: `fc_${call.id}`,
          type: "function_call",
          call_id: call.id,
          name: call.emittedName,
          arguments: call.emittedArguments,
        })),
      },
    },
    expiresAt: new Date(Date.now() + 60_000),
  });
  return {
    session,
    profileId: agent.id,
    clientSessionId,
    heldFrameId: frame.id,
    calls,
  };
}

async function completeTrustedControl(params: {
  session: AppaProxyHookSession;
  controlCallId: string;
}) {
  const scope = params.session.getNativeWireScope();
  const found = await AppaProxyWireModel.findByControlCall({
    ...scope,
    controlCallId: params.controlCallId,
  });
  if (!found) throw new Error("control frame not found");
  const begun = await AppaProxyWireModel.beginControlExecution({
    ...scope,
    frameId: found.frame.id,
    selection: { trusted: true },
  });
  if (!begun.acquired) throw new Error("control execution not acquired");
  await AppaProxyWireModel.completeControl({
    ...scope,
    frameId: found.frame.id,
    receipt: { source: "trusted-gateway", call: params.controlCallId },
  });
}

function controlItemIds(...controlCallIds: string[]): Map<string, string> {
  return new Map(controlCallIds.map((id) => [id, `fc_${id}`]));
}
