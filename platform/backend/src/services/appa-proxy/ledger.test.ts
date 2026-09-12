import { randomUUID } from "node:crypto";
import { beforeEach, describe } from "vitest";
import config from "@/config";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import type { AppaCompletedResponseFrame } from "@/services/appa-response-frame";
import { expect, test } from "@/test";
import { resolveAppaCarrierChild } from "../appa-client-correlation";
import { AppaProxyLedger } from "./ledger";

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://appa.test.svc.cluster.local:18787",
    timeoutMs: 100,
    sessionHmacSecret: "synthetic-session-key".repeat(4),
  };
});

async function openLedger(params?: {
  ownerScopeHash?: string;
  profileId?: string;
}) {
  const ownerScopeHash = params?.ownerScopeHash ?? `owner:${randomUUID()}`;
  const profileId = params?.profileId ?? randomUUID();
  const turn = await AppaProxySessionModel.enterTurn({
    profileId,
    ownerScopeHash,
    clientSessionId: randomUUID(),
    rootId: `root:${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
  });
  const scope = {
    sessionId: turn.session.id,
    ownerScopeHash,
    profileId,
  };
  const parent = await AppaProxyWireModel.createFrame({
    ...scope,
    turnId: turn.turnId,
    kind: "model_response",
    protocol: "claude-code",
    requestHash: "request",
    idempotencyKey: `parent:${randomUUID()}`,
    payload: { response: "held" },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const frame = await AppaProxyWireModel.createFrame({
    ...scope,
    parentFrameId: parent.id,
    turnId: turn.turnId,
    kind: "remedy_control",
    protocol: "claude-code",
    requestHash: "request",
    idempotencyKey: `checkpoint:${randomUUID()}`,
    controlCallId: `call:${randomUUID()}`,
    payload: { checkpoint: true },
    expiresAt: new Date(Date.now() + 60_000),
  });
  await AppaProxyWireModel.markReady({ ...scope, frameId: frame.id });
  await AppaProxyWireModel.markIssued({ ...scope, frameId: frame.id });
  await AppaProxyWireModel.beginControlExecution({
    ...scope,
    frameId: frame.id,
    selection: { checkpoint: true },
  });
  const completed = await AppaProxyWireModel.completeControl({
    ...scope,
    frameId: frame.id,
    receipt: { response: "encrypted" },
  });
  const receiptHash = completed.receiptHash;
  if (!receiptHash) throw new Error("test receipt was not persisted");
  return {
    ledger: new AppaProxyLedger(scope),
    scope,
    frame: { ...completed, receiptHash },
  };
}

function checkpointFrame(params: {
  frame: { id: string; receiptHash: string };
  requestPrefix?: unknown[];
  inheritedPrefix?: unknown[];
  checkpointEventId?: string;
}): AppaCompletedResponseFrame {
  return {
    sourceFrameId: params.frame.id,
    runtimeEventId: params.checkpointEventId ?? randomUUID(),
    receiptHash: params.frame.receiptHash,
    receiptIdentity: `${params.frame.id}:${params.frame.receiptHash}`,
    provider: "anthropic",
    protocol: "anthropic-messages",
    model: "model",
    bootstrapDigest: null,
    requestPrefix: params.requestPrefix ?? [],
    inheritedPrefix: params.inheritedPrefix ?? [],
    issuedItemsDigest: "issued",
    terminalOmission: false,
    compactionRequested: false,
    compactionProduced: false,
  };
}

function forkHistory(history: unknown[]) {
  return {
    protocol: "anthropic-messages" as const,
    history,
    bootstrapDigest: null,
  };
}

describe("APPA checkpoint correlation", () => {
  test("binds a signed child carrier to one released runtime spawn call", async () => {
    const ownerScopeHash = `owner:${randomUUID()}`;
    const profileId = randomUUID();
    const clientSessionId = randomUUID();
    const turn = await AppaProxySessionModel.enterTurn({
      profileId,
      ownerScopeHash,
      clientSessionId,
      rootId: `root:${randomUUID()}`,
      turnId: randomUUID(),
      maxSessionsPerOwner: 10,
    });
    await AppaProxySessionModel.createOutboundIntent({
      turn,
      maxCallsPerSession: 10,
      calls: ["spawn", "changed", "duplicate"].map((callId) => ({
        callId,
        emittedName: "Task",
        emittedArguments: '{"prompt":"delegate"}',
        emittedArgumentsCanonical: '{"prompt":"delegate"}',
        appaTargetName: "Task",
        appaTargetArguments: { prompt: "delegate" },
      })),
    });
    const ledger = new AppaProxyLedger({
      sessionId: turn.session.id,
      ownerScopeHash,
      profileId,
    });
    const prepared = await ledger.prepareChildCarrier({
      callId: "spawn",
      originalArguments: { prompt: "delegate" },
    });
    await expect(
      ledger.prepareChildCarrier({
        callId: "spawn",
        originalArguments: { prompt: "delegate" },
      }),
    ).resolves.toEqual(prepared);
    const changed = await ledger.prepareChildCarrier({
      callId: "changed",
      originalArguments: { prompt: "delegate" },
    });
    const duplicate = await ledger.prepareChildCarrier({
      callId: "duplicate",
      originalArguments: { prompt: "delegate" },
    });
    await AppaProxySessionModel.approveOutboundCallBatch({
      turn,
      calls: [
        {
          callId: "spawn",
          dispatchId: "dispatch",
          spawnBinding: "runtime-spawn-binding",
          effectiveCall: {
            callId: "spawn",
            emittedName: "Task",
            emittedArguments: prepared.rewrittenArgumentsCanonical,
            emittedArgumentsCanonical: prepared.rewrittenArgumentsCanonical,
            appaTargetName: "Task",
            appaTargetArguments: prepared.rewrittenArguments,
          },
        },
        {
          callId: "changed",
          dispatchId: "dispatch-changed",
          spawnBinding: "runtime-spawn-binding-changed",
          effectiveCall: {
            callId: "changed",
            emittedName: "Task",
            emittedArguments: JSON.stringify({
              prompt: `${changed.carrier}\nchanged`,
            }),
            emittedArgumentsCanonical: JSON.stringify({
              prompt: `${changed.carrier}\nchanged`,
            }),
            appaTargetName: "Task",
            appaTargetArguments: { prompt: `${changed.carrier}\nchanged` },
          },
        },
        {
          callId: "duplicate",
          dispatchId: "dispatch-duplicate",
          spawnBinding: "runtime-spawn-binding-duplicate",
          effectiveCall: {
            callId: "duplicate",
            emittedName: "Task",
            emittedArguments: JSON.stringify({
              prompt: `${duplicate.carrier}\n${duplicate.carrier}\ndelegate`,
            }),
            emittedArgumentsCanonical: JSON.stringify({
              prompt: `${duplicate.carrier}\n${duplicate.carrier}\ndelegate`,
            }),
            appaTargetName: "Task",
            appaTargetArguments: {
              prompt: `${duplicate.carrier}\n${duplicate.carrier}\ndelegate`,
            },
          },
        },
      ],
    });
    await expect(
      ledger.resolveChildCarrier({
        parentClientSessionId: clientSessionId,
        callId: "spawn",
        carrier: prepared.carrier,
      }),
    ).resolves.toBe("runtime-spawn-binding");
    await expect(
      resolveAppaCarrierChild({
        client: "claude-code",
        headers: {
          "x-claude-code-session-id": clientSessionId,
          "x-claude-code-agent-id": "native-child-agent",
        },
        request: {
          messages: [
            {
              role: "user",
              content: prepared.carrier,
            },
          ],
        },
        sessionId: clientSessionId,
        ownerScopeHash,
        profileId,
      }),
    ).resolves.toMatchObject({
      parentClientSessionId: clientSessionId,
      childClientSessionId: `claude:${clientSessionId}:agent:native-child-agent`,
      spawnBinding: "runtime-spawn-binding",
    });
    await expect(
      ledger.resolveChildCarrier({
        parentClientSessionId: clientSessionId,
        callId: "spawn",
        carrier: `${prepared.carrier}0`,
      }),
    ).rejects.toThrow(
      "child did not present a valid proxy-issued spawn carrier",
    );
    await expect(
      ledger.resolveChildCarrier({
        parentClientSessionId: clientSessionId,
        callId: "changed",
        carrier: changed.carrier,
      }),
    ).rejects.toThrow("released provider spawn arguments");
    await expect(
      ledger.resolveChildCarrier({
        parentClientSessionId: clientSessionId,
        callId: "duplicate",
        carrier: duplicate.carrier,
      }),
    ).rejects.toThrow("released provider spawn arguments");
    await expect(
      new AppaProxyLedger({
        sessionId: turn.session.id,
        ownerScopeHash: "other-owner",
        profileId,
      }).resolveChildCarrier({
        parentClientSessionId: clientSessionId,
        callId: "spawn",
        carrier: prepared.carrier,
      }),
    ).rejects.toThrow(
      "provider call is not an admitted single-call correlation",
    );
  });

  test("persists encrypted exact history and resolves one scoped fork", async () => {
    const { ledger, frame } = await openLedger();
    const request = [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "source" }],
      },
    ];
    const inherited = [
      ...request,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "issued" }],
      },
    ];
    const binding = await ledger.recordCheckpointBinding({
      frame: checkpointFrame({
        frame,
        requestPrefix: request,
        inheritedPrefix: inherited,
      }),
      checkpoint: {
        checkpoint_id: "checkpoint",
        source_scope: { adapter: "claude-code", root_id: "source" },
        position: 1,
        digest: "digest",
      },
    });
    await expect(
      ledger.matchingCheckpointFork({
        provider: "anthropic",
        model: "model",
        history: forkHistory([
          ...inherited,
          {
            type: "message",
            role: "user",
            content: [{ type: "text", text: "fork" }],
          },
        ]),
      }),
    ).resolves.toEqual(binding);
    await expect(
      ledger.matchingCheckpointFork({
        provider: "anthropic",
        model: "model",
        history: forkHistory(request),
      }),
    ).resolves.toBeNull();
  });

  test("rejects a checkpoint replay whose exact provider history changed", async () => {
    const { ledger, frame } = await openLedger();
    const input = {
      frame: checkpointFrame({ frame }),
      checkpoint: {
        checkpoint_id: "checkpoint",
        source_scope: { adapter: "claude-code", root_id: "source" },
        position: 1,
        digest: "digest",
      },
    };
    await ledger.recordCheckpointBinding(input);
    await expect(
      ledger.recordCheckpointBinding({
        ...input,
        frame: checkpointFrame({
          frame,
          inheritedPrefix: [
            { type: "message", role: "assistant", content: [] },
          ],
          checkpointEventId: input.frame.runtimeEventId,
        }),
      }),
    ).rejects.toThrow(
      "runtime checkpoint identity was reused with different provider history",
    );
  });

  test("requires an immutable completed source receipt", async () => {
    const { ledger, frame } = await openLedger();
    await expect(
      ledger.recordCheckpointBinding({
        frame: {
          ...checkpointFrame({ frame }),
          receiptHash: "tampered",
        },
        checkpoint: {
          checkpoint_id: "checkpoint",
          source_scope: { adapter: "claude-code", root_id: "source" },
          position: 1,
          digest: "digest",
        },
      }),
    ).rejects.toThrow("encrypted response receipt");
  });

  test("does not expose a checkpoint outside its authenticated fork scope", async () => {
    const { ledger, scope, frame } = await openLedger();
    await ledger.recordCheckpointBinding({
      frame: checkpointFrame({ frame }),
      checkpoint: {
        checkpoint_id: "checkpoint",
        source_scope: { adapter: "claude-code", root_id: "source" },
        position: 1,
        digest: "digest",
      },
    });
    await expect(
      AppaProxyLedger.forForkLookup({
        ownerScopeHash: "other-owner",
        profileId: scope.profileId,
      }).matchingCheckpointFork({
        provider: "anthropic",
        model: "model",
        history: forkHistory([
          {
            type: "message",
            role: "user",
            content: [{ type: "text", text: "fork" }],
          },
        ]),
      }),
    ).resolves.toBeNull();
  });

  test("fails closed for ambiguous or unsupported normalized histories", async () => {
    const ownerScopeHash = `owner:${randomUUID()}`;
    const profileId = randomUUID();
    const first = await openLedger({ ownerScopeHash, profileId });
    const second = await openLedger({ ownerScopeHash, profileId });
    const request = [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "source" }],
      },
    ];
    const inherited = [
      ...request,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "issued" }],
      },
    ];
    for (const [index, source] of [first, second].entries()) {
      await source.ledger.recordCheckpointBinding({
        frame: checkpointFrame({
          frame: source.frame,
          requestPrefix: request,
          inheritedPrefix: inherited,
        }),
        checkpoint: {
          checkpoint_id: `checkpoint-${index}`,
          source_scope: { adapter: "claude-code", root_id: "source" },
          position: 1,
          digest: "digest",
        },
      });
    }
    const lookup = AppaProxyLedger.forForkLookup({ ownerScopeHash, profileId });
    await expect(
      lookup.matchingCheckpointFork({
        provider: "anthropic",
        model: "model",
        history: forkHistory([
          ...inherited,
          {
            type: "message",
            role: "user",
            content: [{ type: "text", text: "fork" }],
          },
        ]),
      }),
    ).rejects.toThrow("ambiguously");
    await expect(
      lookup.matchingCheckpointFork({
        provider: "anthropic",
        model: "model",
        history: forkHistory([...inherited, { type: "unsupported" }]),
      }),
    ).resolves.toBeNull();
  });
});
