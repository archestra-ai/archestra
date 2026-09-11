import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect } from "vitest";
import config from "@/config";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { test } from "@/test";
import { DurableAppaNativeMcpExecutionService } from "./appa-native-mcp-execution";

const ownerScopeHash = "native-mcp-execution-test-owner";
const toolName = "fixture__create_job";

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://appa.test.svc.cluster.local:18787",
    timeoutMs: 100,
    sessionHmacSecret: "synthetic-session-key".repeat(4),
  };
});

describe("durable native MCP execution", () => {
  test("requires the sealed owner, profile access, wire tuple, tool, and exact arguments", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    await makeMember(owner.id, organization.id, { role: "admin" });
    await makeMember(otherUser.id, organization.id, { role: "admin" });
    const profile = await makeAgent({ organizationId: organization.id });
    const turn = await AppaProxySessionModel.enterTurn({
      profileId: profile.id,
      ownerScopeHash,
      clientSessionId: randomUUID(),
      rootId: `native-mcp:${randomUUID()}`,
      turnId: randomUUID(),
      maxSessionsPerOwner: 100,
    });
    const callId = `call_appa_${randomUUID().replaceAll("-", "")}`;
    const rewrittenCallId = `call_appa_${randomUUID().replaceAll("-", "")}`;
    const threadId = `thread_${randomUUID()}`;
    const itemId = `fc_${callId}`;
    const args = { request_key: "sealed", value: "exact" };
    const scope = {
      sessionId: turn.session.id,
      ownerScopeHash,
      turnId: turn.turnId,
    };
    const frame = await AppaProxyWireModel.createFrame({
      ...scope,
      kind: "model_response",
      protocol: "codex-native-response/v1",
      requestHash: "native-mcp-authorized-request",
      idempotencyKey: `native-mcp:${callId}`,
      payload: {
        calls: [
          { id: callId, name: toolName, arguments: JSON.stringify(args) },
          {
            id: rewrittenCallId,
            name: toolName,
            arguments: JSON.stringify({ ...args, value: "sanitized" }),
          },
        ],
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    await AppaProxyWireModel.addAliases({
      ...scope,
      frameId: frame.id,
      aliases: [
        {
          kind: "call",
          position: 0,
          wireId: callId,
          metadata: {
            purpose: "native_call",
            // This is the server-sealed value that client _meta cannot forge.
            principalUserId: owner.id,
            gatewayProfileId: profile.id,
            threadId,
            itemId,
            toolName,
            argumentsCanonical: '{"request_key":"sealed","value":"exact"}',
            executionArgumentsCanonical:
              '{"request_key":"sealed","value":"exact"}',
          },
        },
        {
          kind: "call",
          position: 1,
          wireId: rewrittenCallId,
          metadata: {
            purpose: "native_call",
            principalUserId: owner.id,
            gatewayProfileId: profile.id,
            threadId,
            itemId: `fc_${rewrittenCallId}`,
            toolName,
            argumentsCanonical: '{"request_key":"sealed","value":"exact"}',
            executionArgumentsCanonical:
              '{"request_key":"sealed","value":"sanitized"}',
          },
        },
      ],
    });
    await AppaProxyWireModel.markReady({ ...scope, frameId: frame.id });
    await AppaProxyWireModel.markIssued({ ...scope, frameId: frame.id });

    const service = new DurableAppaNativeMcpExecutionService();
    const token = (userId: string) => ({
      tokenId: randomUUID(),
      teamId: null,
      isOrganizationToken: false,
      isUserToken: true,
      userId,
      organizationId: organization.id,
    });
    const request = {
      callId,
      toolName,
      args,
      executionArgs: args,
      actualGatewayProfileId: profile.id,
      wireContext: { threadId, itemId },
    };

    // An admin can access the profile, but cannot substitute the sealed owner.
    expect(
      await service.claim({ ...request, tokenAuth: token(otherUser.id) }),
    ).toEqual({ state: "unavailable" });
    // Client-owned metadata cannot alter the bound tuple, name, or arguments.
    expect(
      await service.claim({
        ...request,
        tokenAuth: token(owner.id),
        wireContext: { threadId: "forged-thread", itemId },
      }),
    ).toEqual({ state: "unavailable" });
    expect(
      await service.claim({
        ...request,
        tokenAuth: token(owner.id),
        args: { ...args, value: "forged" },
      }),
    ).toEqual({ state: "unavailable" });
    expect(
      await service.claim({
        ...request,
        tokenAuth: token(owner.id),
        executionArgs: { ...args, unexpected: "forged" },
      }),
    ).toEqual({ state: "unavailable" });
    expect(
      await service.claim({
        ...request,
        tokenAuth: token(owner.id),
        actualGatewayProfileId: randomUUID(),
      }),
    ).toEqual({ state: "unavailable" });
    expect(
      await service.claim({
        ...request,
        tokenAuth: token(owner.id),
        toolName: "fixture__other_job",
      }),
    ).toEqual({ state: "unavailable" });

    // A pre-sanitization alias cannot authorize arguments that differ from
    // the committed response, even with the correct owner and wire tuple.
    expect(
      await service.claim({
        ...request,
        callId: rewrittenCallId,
        wireContext: { threadId, itemId: `fc_${rewrittenCallId}` },
        tokenAuth: token(owner.id),
      }),
    ).toEqual({ state: "unavailable" });
    const claimed = await service.claim({
      ...request,
      tokenAuth: token(owner.id),
    });
    expect(claimed.state).toBe("acquired");
    if (claimed.state !== "acquired") throw new Error("expected native claim");
    expect(
      await service.getNativeMcpExecutionOutcome({
        ...claimed.scope,
        callId,
      }),
    ).toMatchObject({ status: "indeterminate" });
    const stored = await service.complete({
      scope: claimed.scope,
      frameId: claimed.frameId,
      status: "failure",
      result: {
        content: [{ type: "text", text: "known failure" }],
        isError: true,
        structuredContent: { code: "known_failure" },
      },
    });
    expect(stored).toEqual({
      content: [{ type: "text", text: "known failure" }],
      isError: true,
      structuredContent: { code: "known_failure" },
    });
    expect(
      await service.claim({ ...request, tokenAuth: token(owner.id) }),
    ).toEqual({ state: "completed", result: stored });
    expect(
      await service.getNativeMcpExecutionOutcome({
        ...claimed.scope,
        callId,
      }),
    ).toEqual({ status: "failure", result: stored });
    expect(
      await service.getNativeMcpExecutionOutcome({
        ...claimed.scope,
        callId: `call_appa_${randomUUID().replaceAll("-", "")}`,
      }),
    ).toMatchObject({ status: "indeterminate" });
    expect(
      await AppaProxyWireModel.findControlMetadataForOrganization({
        organizationId: organization.id,
        controlCallId: callId,
      }),
    ).toBeNull();
    expect(
      await AppaProxyWireModel.findByControlCall({
        ...scope,
        controlCallId: callId,
      }),
    ).toBeNull();
    expect(
      await AppaProxyWireModel.listControlsForParent({
        ...scope,
        parentFrameId: frame.id,
      }),
    ).toEqual([]);
  });
});
