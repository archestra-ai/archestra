import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe } from "vitest";
import config from "@/config";
import db from "@/database";
import { appaProxyWireFramesTable as frames } from "@/database/schemas/appa-proxy-wire";
import { expect, test } from "@/test";
import AppaProxySessionModel from "./appa-proxy-session";
import AppaProxyWireModel from "./appa-proxy-wire";

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://appa.test.svc.cluster.local:18787",
    timeoutMs: 100,
    sessionHmacSecret: "synthetic-session-key".repeat(4),
  };
});

async function openTurn(ownerScopeHash = "synthetic-owner") {
  const turn = await AppaProxySessionModel.enterTurn({
    profileId: randomUUID(),
    ownerScopeHash,
    clientSessionId: randomUUID(),
    rootId: `wire-test:${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 100,
  });
  return { turn, scope: { sessionId: turn.session.id, ownerScopeHash } };
}

describe("durable APPA wire frames", () => {
  test("keeps private payload encrypted and makes repeated creation idempotent", async () => {
    const { turn, scope } = await openTurn();
    const input = {
      ...scope,
      turnId: turn.turnId,
      kind: "model_response" as const,
      protocol: "codex-responses",
      requestHash: "synthetic-request-hash",
      idempotencyKey: "native-turn-1:step-1",
      payload: { output: "SYNTHETIC_PRIVATE_PAYLOAD" },
      expiresAt: new Date(Date.now() + 60_000),
    };
    const first = await AppaProxyWireModel.createFrame(input);
    const repeated = await AppaProxyWireModel.createFrame(input);
    expect(repeated.id).toBe(first.id);
    expect(first.payloadCiphertext).not.toContain("SYNTHETIC_PRIVATE_PAYLOAD");
    expect(
      (await AppaProxyWireModel.findOwned({ ...scope, frameId: first.id }))
        ?.payload,
    ).toEqual(input.payload);
    expect(
      await AppaProxyWireModel.findOwned({
        ...scope,
        ownerScopeHash: "another-owner",
        frameId: first.id,
      }),
    ).toBeNull();
    await expect(
      AppaProxyWireModel.createFrame({
        ...input,
        payload: { output: "CHANGED" },
      }),
    ).rejects.toThrow("reused");
    const next = await AppaProxyWireModel.createFrame({
      ...input,
      idempotencyKey: "native-turn-2:step-1",
    });
    expect(next.id).not.toBe(first.id);
  });

  test("allows only one control executor and preserves its exact receipt", async () => {
    const { turn, scope } = await openTurn();
    const parent = await AppaProxyWireModel.createFrame({
      ...scope,
      turnId: turn.turnId,
      kind: "model_response",
      protocol: "codex-responses",
      requestHash: "request-1",
      idempotencyKey: "held-response-1",
      payload: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    const frame = await AppaProxyWireModel.createFrame({
      parentFrameId: parent.id,
      ...scope,
      turnId: turn.turnId,
      kind: "remedy_control",
      protocol: "codex-responses",
      requestHash: "request-1",
      idempotencyKey: "control-1",
      controlCallId: "call_appa_control_1",
      payload: { position: 0, offer: "synthetic-offer" },
      expiresAt: new Date(Date.now() + 60_000),
    });
    await AppaProxyWireModel.markReady({ ...scope, frameId: frame.id });
    await AppaProxyWireModel.markIssued({ ...scope, frameId: frame.id });
    const executions = await Promise.all(
      [1, 2].map(() =>
        AppaProxyWireModel.beginControlExecution({
          ...scope,
          frameId: frame.id,
          selection: { offer: "synthetic-offer" },
        }),
      ),
    );
    expect(executions.filter((execution) => execution.acquired)).toHaveLength(
      1,
    );
    expect(executions[0].frame.executionEventId).toBe(
      executions[1].frame.executionEventId,
    );
    await expect(
      AppaProxyWireModel.beginControlExecution({
        ...scope,
        frameId: frame.id,
        selection: { offer: "different" },
      }),
    ).rejects.toThrow("changed");
    const receipt = {
      state: "resolved",
      runtime_event: executions[0].frame.executionEventId,
    };
    await AppaProxyWireModel.completeControl({
      ...scope,
      frameId: frame.id,
      receipt,
    });
    await AppaProxySessionModel.releaseTurn(turn);
    const replay = await AppaProxyWireModel.completeControl({
      ...scope,
      frameId: frame.id,
      receipt,
    });
    expect(replay.state).toBe("completed");
    await expect(
      AppaProxyWireModel.completeControl({
        ...scope,
        frameId: frame.id,
        receipt: { state: "forged" },
      }),
    ).rejects.toThrow("changed");
    expect(
      (
        await AppaProxyWireModel.findByControlCall({
          ...scope,
          controlCallId: "call_appa_control_1",
        })
      )?.receipt,
    ).toEqual(receipt);
  });

  test("does not publish aliases before issuance or issue after quarantine", async () => {
    const { turn, scope } = await openTurn();
    const frame = await AppaProxyWireModel.createFrame({
      ...scope,
      turnId: turn.turnId,
      kind: "model_response",
      protocol: "codex-responses",
      requestHash: "request-2",
      idempotencyKey: "response-2",
      payload: {},
      expiresAt: new Date(Date.now() + 60_000),
    });
    await AppaProxyWireModel.addAliases({
      ...scope,
      frameId: frame.id,
      aliases: [
        {
          kind: "call",
          position: 0,
          wireId: "call_appa_1",
          logicalId: "call_provider_1",
          metadata: { name: "read_public" },
        },
      ],
    });
    expect(await AppaProxyWireModel.listIssuedAliases(scope)).toHaveLength(0);
    await AppaProxyWireModel.markReady({ ...scope, frameId: frame.id });
    await AppaProxySessionModel.quarantineTurn(turn);
    await expect(
      AppaProxyWireModel.markIssued({ ...scope, frameId: frame.id }),
    ).rejects.toThrow();
    const [stored] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    expect(stored.state).toBe("ready");
    expect(await AppaProxyWireModel.listIssuedAliases(scope)).toHaveLength(0);
  });

  test("claims a native business call once and replays only its exact receipt", async () => {
    const { turn, scope } = await openTurn();
    const callId = `call_appa_${randomUUID().replaceAll("-", "")}`;
    const parent = await AppaProxyWireModel.createFrame({
      ...scope,
      turnId: turn.turnId,
      kind: "model_response",
      protocol: "codex-native-response/v1",
      requestHash: "native-request",
      idempotencyKey: "native-parent",
      payload: {
        calls: [
          { id: callId, arguments: '{"request_key":"once","value":"durable"}' },
        ],
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [alias] = await AppaProxyWireModel.addAliases({
      ...scope,
      frameId: parent.id,
      aliases: [
        {
          kind: "call",
          position: 0,
          wireId: callId,
          metadata: {
            purpose: "native_call",
            argumentsCanonical: '{"request_key":"once","value":"durable"}',
          },
        },
      ],
    });
    const fillers = await Promise.all(
      [0, 1, 2].map((index) =>
        AppaProxyWireModel.createFrame({
          ...scope,
          turnId: turn.turnId,
          kind: "model_response",
          protocol: "codex-native-response/v1",
          requestHash: `budget-reservation-${index}`,
          idempotencyKey: `budget-reservation-${index}`,
          payload: {},
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    );
    await AppaProxyWireModel.markReady({ ...scope, frameId: parent.id });
    await AppaProxyWireModel.markIssued({ ...scope, frameId: parent.id });
    // Native MCP execution starts after the issuing LLM turn has been released.
    await AppaProxySessionModel.releaseTurn(turn);
    const argumentsCanonical = '{"request_key":"once","value":"durable"}';
    // Simulate a nearly full session without allocating a 64 MiB fixture.
    await db
      .update(frames)
      .set({ payloadBytes: 16 * 1024 * 1024 })
      .where(
        inArray(
          frames.id,
          fillers.map((frame) => frame.id),
        ),
      );
    await db
      .update(frames)
      .set({
        payloadBytes: 16 * 1024 * 1024 - 64 * 1024 - alias.metadataBytes,
      })
      .where(eq(frames.id, parent.id));
    await expect(
      AppaProxyWireModel.claimNativeMcpExecution({
        ...scope,
        aliasId: alias.id,
        callId,
        expectedExecutionArgumentsCanonical: argumentsCanonical,
      }),
    ).rejects.toThrow("budget exhausted");
    expect(
      (await AppaProxyWireModel.listIssuedAliases(scope))[0].consumedAt,
    ).toBeNull();
    await db
      .update(frames)
      .set({ payloadBytes: parent.payloadBytes })
      .where(eq(frames.id, parent.id));
    await db
      .update(frames)
      .set({ payloadBytes: fillers[0].payloadBytes })
      .where(
        inArray(
          frames.id,
          fillers.map((frame) => frame.id),
        ),
      );
    const claims = await Promise.all(
      [1, 2].map(() =>
        AppaProxyWireModel.claimNativeMcpExecution({
          ...scope,
          aliasId: alias.id,
          callId,
          expectedExecutionArgumentsCanonical: argumentsCanonical,
        }),
      ),
    );
    expect(claims.filter((claim) => claim.state === "acquired")).toHaveLength(
      1,
    );
    expect(claims.filter((claim) => claim.state === "running")).toHaveLength(1);
    const acquired = claims.find((claim) => claim.state === "acquired");
    if (!acquired) throw new Error("native execution claim was not acquired");

    const receipt = {
      version: 1,
      status: "success",
      result: { content: [{ type: "text", text: "created once" }] },
    };
    await AppaProxyWireModel.completeNativeMcpExecution({
      ...scope,
      frameId: acquired.frame.id,
      receipt,
    });
    const replay = await AppaProxyWireModel.claimNativeMcpExecution({
      ...scope,
      aliasId: alias.id,
      callId,
      expectedExecutionArgumentsCanonical: argumentsCanonical,
    });
    expect(replay.state).toBe("completed");
    expect(
      await AppaProxyWireModel.findNativeMcpExecutionReceipt({
        ...scope,
        callId,
      }),
    ).toEqual({ state: "completed", receipt });
  });

  test("does not re-execute a running native call or changed arguments", async () => {
    const { turn, scope } = await openTurn();
    const callId = `call_appa_${randomUUID().replaceAll("-", "")}`;
    const parent = await AppaProxyWireModel.createFrame({
      ...scope,
      turnId: turn.turnId,
      kind: "model_response",
      protocol: "codex-native-response/v1",
      requestHash: "native-uncertain-request",
      idempotencyKey: "native-uncertain-parent",
      payload: {
        calls: [{ id: callId, arguments: '{"request_key":"uncertain"}' }],
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [alias] = await AppaProxyWireModel.addAliases({
      ...scope,
      frameId: parent.id,
      aliases: [
        {
          kind: "call",
          position: 0,
          wireId: callId,
          metadata: { argumentsCanonical: '{"request_key":"uncertain"}' },
        },
      ],
    });
    await AppaProxyWireModel.markReady({ ...scope, frameId: parent.id });
    await AppaProxyWireModel.markIssued({ ...scope, frameId: parent.id });
    const first = await AppaProxyWireModel.claimNativeMcpExecution({
      ...scope,
      aliasId: alias.id,
      callId,
      expectedExecutionArgumentsCanonical: '{"request_key":"uncertain"}',
    });
    expect(first.state).toBe("acquired");
    await expect(
      AppaProxyWireModel.claimNativeMcpExecution({
        ...scope,
        aliasId: alias.id,
        callId,
        expectedExecutionArgumentsCanonical: '{"request_key":"changed"}',
      }),
    ).rejects.toThrow("binding changed");
    await expect(
      AppaProxyWireModel.completeNativeMcpExecution({
        ...scope,
        frameId: first.frame.id,
        receipt: { raw: "x".repeat(64 * 1024) },
      }),
    ).rejects.toThrow("too large");
    const retry = await AppaProxyWireModel.claimNativeMcpExecution({
      ...scope,
      aliasId: alias.id,
      callId,
      expectedExecutionArgumentsCanonical: '{"request_key":"uncertain"}',
    });
    expect(retry.state).toBe("running");
    // Completion must retain the known outcome even when the hook quarantines
    // the session while the external call is settling.
    await AppaProxySessionModel.quarantineTurn(turn);
    await AppaProxyWireModel.completeNativeMcpExecution({
      ...scope,
      frameId: first.frame.id,
      receipt: {
        version: 1,
        status: "failure",
        result: {
          content: [{ type: "text", text: "settled after quarantine" }],
        },
      },
    });
    expect(
      await AppaProxyWireModel.findNativeMcpExecutionReceipt({
        ...scope,
        callId,
      }),
    ).toMatchObject({ state: "completed" });
  });

  test("atomically refreshes held native MCP bindings within the alias budget", async () => {
    const { turn, scope } = await openTurn();
    const callId = `call_appa_${randomUUID().replaceAll("-", "")}`;
    const parent = await AppaProxyWireModel.createFrame({
      ...scope,
      turnId: turn.turnId,
      kind: "model_response",
      protocol: "codex-native-response/v1",
      requestHash: "native-finalization-request",
      idempotencyKey: "native-finalization-parent",
      payload: {
        calls: [{ id: callId, arguments: '{"value":"proposal"}' }],
      },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [alias] = await AppaProxyWireModel.addAliases({
      ...scope,
      frameId: parent.id,
      aliases: [
        {
          kind: "call",
          position: 0,
          wireId: callId,
          logicalId: "provider-call",
          metadata: {
            purpose: "native_call",
            providerCallId: "provider-call",
            providerItemId: "provider-item",
            principalUserId: "credential-user",
            threadId: "durable-thread",
            itemId: `fc_${callId}`,
            toolName: "create_job",
            argumentsCanonical: '{"value":"proposal"}',
          },
        },
      ],
    });
    if (!alias) throw new Error("expected native MCP alias");
    const finalizedArguments = JSON.stringify({ value: "x".repeat(1024) });
    await AppaProxyWireModel.replaceHeldPayload({
      ...scope,
      turnId: turn.turnId,
      frameId: parent.id,
      payload: {
        calls: [{ id: callId, arguments: finalizedArguments }],
      },
    });
    const fillers = await Promise.all(
      [0, 1, 2].map((index) =>
        AppaProxyWireModel.createFrame({
          ...scope,
          turnId: turn.turnId,
          kind: "model_response",
          protocol: "codex-native-response/v1",
          requestHash: `native-finalization-budget-${index}`,
          idempotencyKey: `native-finalization-budget-${index}`,
          payload: {},
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    );
    // Fill the durable history exactly to its current size. Finalization's
    // larger sealed arguments must fail without publishing a partial update.
    await db
      .update(frames)
      .set({ payloadBytes: 16 * 1024 * 1024 })
      .where(
        inArray(
          frames.id,
          fillers.map((frame) => frame.id),
        ),
      );
    await db
      .update(frames)
      .set({ payloadBytes: 16 * 1024 * 1024 - alias.metadataBytes })
      .where(eq(frames.id, parent.id));
    await expect(
      AppaProxyWireModel.finalizeNativeMcpBindingsAndMarkReady({
        ...scope,
        frameId: parent.id,
      }),
    ).rejects.toThrow("budget exhausted");
    expect(
      (await AppaProxyWireModel.findOwned({ ...scope, frameId: parent.id }))
        ?.frame.state,
    ).toBe("held");
    expect(
      await AppaProxyWireModel.readNativeCallAliasMetadata({
        ...scope,
        aliasId: alias.id,
      }),
    ).toMatchObject({
      argumentsCanonical: '{"value":"proposal"}',
      providerCallId: "provider-call",
      providerItemId: "provider-item",
      principalUserId: "credential-user",
      threadId: "durable-thread",
      itemId: `fc_${callId}`,
      toolName: "create_job",
    });
    await db
      .update(frames)
      .set({ payloadBytes: parent.payloadBytes })
      .where(eq(frames.id, parent.id));
    await db
      .update(frames)
      .set({ payloadBytes: fillers[0]?.payloadBytes ?? 0 })
      .where(
        inArray(
          frames.id,
          fillers.map((frame) => frame.id),
        ),
      );
    await AppaProxyWireModel.finalizeNativeMcpBindingsAndMarkReady({
      ...scope,
      frameId: parent.id,
    });
    await AppaProxyWireModel.markIssued({ ...scope, frameId: parent.id });
    expect(
      (await AppaProxyWireModel.listIssuedAliases(scope))[0]?.metadata,
    ).toMatchObject({ argumentsCanonical: finalizedArguments });
  });

  test("enforces duplicate wire alias detection within batch and against session", async () => {
    const { turn, scope } = await openTurn();
    const frame = await AppaProxyWireModel.createFrame({
      ...scope,
      turnId: turn.turnId,
      kind: "model_response",
      protocol: "codex-responses",
      requestHash: "request-dedup-test",
      idempotencyKey: "frame-dedup-1",
      payload: { output: "ok" },
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Duplicate wireId within single batch
    await expect(
      AppaProxyWireModel.addAliases({
        ...scope,
        frameId: frame.id,
        aliases: [
          {
            kind: "call",
            position: 0,
            wireId: "call_dup",
            metadata: { foo: 1 },
          },
          {
            kind: "call",
            position: 1,
            wireId: "call_dup",
            metadata: { foo: 2 },
          },
        ],
      }),
    ).rejects.toThrow("Duplicate wire alias within batch");

    // Duplicate position within single batch
    await expect(
      AppaProxyWireModel.addAliases({
        ...scope,
        frameId: frame.id,
        aliases: [
          {
            kind: "call",
            position: 0,
            wireId: "call_1",
            metadata: { foo: 1 },
          },
          {
            kind: "task",
            position: 0,
            wireId: "task_1",
            metadata: { foo: 2 },
          },
        ],
      }),
    ).rejects.toThrow("Duplicate alias position within batch");

    // First insert succeeds
    await AppaProxyWireModel.addAliases({
      ...scope,
      frameId: frame.id,
      aliases: [
        {
          kind: "call",
          position: 0,
          wireId: "call_existing",
          metadata: { foo: 1 },
        },
      ],
    });

    // Second insert with duplicate wireId across session fails
    await expect(
      AppaProxyWireModel.addAliases({
        ...scope,
        frameId: frame.id,
        aliases: [
          {
            kind: "call",
            position: 1,
            wireId: "call_existing",
            metadata: { foo: 2 },
          },
        ],
      }),
    ).rejects.toThrow("Wire alias already exists for session");
  });

  test("rejects tampered ciphertext when unsealing frame payload", async () => {
    const { turn, scope } = await openTurn();
    const frame = await AppaProxyWireModel.createFrame({
      ...scope,
      turnId: turn.turnId,
      kind: "model_response",
      protocol: "codex-responses",
      requestHash: "request-tamper-test",
      idempotencyKey: "frame-tamper-1",
      payload: { secret: "AUTHENTIC_DATA" },
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Verify unseal works initially
    const authentic = await AppaProxyWireModel.findOwned({
      ...scope,
      frameId: frame.id,
    });
    expect(authentic?.payload).toEqual({ secret: "AUTHENTIC_DATA" });

    // Tamper with ciphertext in database
    await db
      .update(frames)
      .set({ payloadCiphertext: "tampered:payload:ciphertext" })
      .where(eq(frames.id, frame.id));

    // Tampered payload fails authentication
    await expect(
      AppaProxyWireModel.findOwned({ ...scope, frameId: frame.id }),
    ).rejects.toThrow();
  });
});
