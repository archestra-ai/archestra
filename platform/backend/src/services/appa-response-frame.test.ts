import { randomUUID } from "node:crypto";
import config from "@/config";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import type { AppaProxyHookSession } from "@/routes/proxy/appa-proxy-hook";
import { AppaProxyLedger } from "@/services/appa-proxy/ledger";
import { expect, test } from "@/test";
import { AppaHistoryCodec } from "./appa-history-codec";
import { AppaResponseFrame } from "./appa-response-frame";

test("seals an immutable Anthropic response before recording its checkpoint fork", async () => {
  config.llmProxy.appaHook = hookConfig();
  const opened = await open();
  const request = {
    system: "rules",
    messages: [{ role: "user", content: "source" }],
  };
  const response = {
    id: "msg_source",
    content: [{ type: "text", text: "issued", provider_field: "retained" }],
  };
  const frameService = new AppaResponseFrame({
    session: opened.session,
    profileId: opened.profileId,
  });
  const frame = await frameService.complete({
    runtimeEventId: randomUUID(),
    provider: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-test",
    request,
    response,
  });
  const stored = await AppaProxyWireModel.findOwned({
    ...opened.scope,
    frameId: frame.sourceFrameId,
  });
  expect(stored?.frame.state).toBe("completed");
  expect(stored?.frame.receiptHash).toBe(frame.receiptHash);
  expect(stored?.payload).toMatchObject({ response });

  const ledger = new AppaProxyLedger({
    ...opened.scope,
    profileId: opened.profileId,
  });
  const binding = await ledger.recordCheckpointBinding({
    checkpoint: {
      checkpoint_id: "checkpoint-source",
      source_scope: {},
      position: 1,
      digest: "digest",
    },
    frame,
  });
  const forkRequest = AppaHistoryCodec.request({
    protocol: "anthropic-messages",
    request: {
      system: "rules",
      messages: [
        { role: "user", content: "source" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "issued", provider_field: "retained" },
          ],
        },
        { role: "user", content: "fork" },
      ],
    },
  });
  await expect(
    ledger.matchingCheckpointFork({
      provider: frame.provider,
      model: frame.model,
      history: forkRequest,
    }),
  ).resolves.toEqual(binding);
  const invalidTail = AppaHistoryCodec.request({
    protocol: "anthropic-messages",
    request: {
      system: "rules",
      messages: [
        { role: "user", content: "source" },
        { role: "assistant", content: "issued" },
        { role: "assistant", content: "not a fresh user tail" },
      ],
    },
  });
  await expect(
    ledger.matchingCheckpointFork({
      provider: frame.provider,
      model: frame.model,
      history: invalidTail,
    }),
  ).resolves.toBeNull();
  await expect(
    AppaProxyLedger.forForkLookup({
      ownerScopeHash: `other-owner:${randomUUID()}`,
      profileId: opened.profileId,
    }).matchingCheckpointFork({
      provider: frame.provider,
      model: frame.model,
      history: forkRequest,
    }),
  ).resolves.toBeNull();
});

test("rejects a retry that changes an encrypted response frame", async () => {
  config.llmProxy.appaHook = hookConfig();
  const opened = await open();
  const service = new AppaResponseFrame({
    session: opened.session,
    profileId: opened.profileId,
  });
  const params = {
    runtimeEventId: randomUUID(),
    provider: "openai",
    protocol: "openai-responses" as const,
    model: "gpt-test",
    request: { input: [{ role: "user", content: "source" }] },
    response: {
      id: "resp_1",
      output: [{ type: "message", role: "assistant", content: "first" }],
    },
  };
  const first = await service.complete(params);
  await expect(service.complete(params)).resolves.toEqual(first);
  await expect(
    service.complete({
      ...params,
      response: {
        id: "resp_1",
        output: [{ type: "message", role: "assistant", content: "changed" }],
      },
    }),
  ).rejects.toThrow("identity was reused with different content");
});

test("does not fork a Chat history with a changed issued tool call", async () => {
  config.llmProxy.appaHook = hookConfig();
  const opened = await open();
  const service = new AppaResponseFrame({
    session: opened.session,
    profileId: opened.profileId,
  });
  const assistant = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: '{"a":1,"b":2}' },
      },
    ],
  };
  const frame = await service.complete({
    runtimeEventId: randomUUID(),
    provider: "openai",
    protocol: "openai-chat-completions",
    model: "kimi-test",
    request: {
      messages: [
        { role: "user", content: "source" },
        assistant,
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    },
    response: {
      choices: [{ message: { role: "assistant", content: "done" } }],
    },
  });
  const ledger = new AppaProxyLedger({
    ...opened.scope,
    profileId: opened.profileId,
  });
  await ledger.recordCheckpointBinding({
    checkpoint: {
      checkpoint_id: "checkpoint-chat",
      source_scope: {},
      position: 1,
      digest: "digest",
    },
    frame,
  });
  const history = (params: {
    toolCall: Record<string, unknown>;
    resultCallId?: string;
  }) =>
    AppaHistoryCodec.request({
      protocol: "openai-chat-completions",
      request: {
        messages: [
          { role: "user", content: "source" },
          { ...assistant, tool_calls: [params.toolCall] },
          {
            role: "tool",
            tool_call_id: params.resultCallId ?? "call_1",
            content: "result",
          },
          { role: "assistant", content: "done" },
          { role: "user", content: "fork" },
        ],
      },
    });

  await expect(
    ledger.matchingCheckpointFork({
      provider: "openai",
      model: "kimi-test",
      history: history({
        toolCall: {
          ...assistant.tool_calls[0],
          function: { name: "lookup", arguments: '{"b":2,"a":1}' },
        },
      }),
    }),
  ).resolves.not.toBeNull();
  for (const changed of [
    { toolCall: { ...assistant.tool_calls[0], id: "call_changed" } },
    {
      toolCall: {
        ...assistant.tool_calls[0],
        function: { name: "changed", arguments: '{"a":1,"b":2}' },
      },
    },
    {
      toolCall: {
        ...assistant.tool_calls[0],
        function: { name: "lookup", arguments: '{"a":2,"b":1}' },
      },
    },
    { toolCall: assistant.tool_calls[0], resultCallId: "call_changed" },
  ]) {
    await expect(
      ledger.matchingCheckpointFork({
        provider: "openai",
        model: "kimi-test",
        history: history(changed),
      }),
    ).resolves.toBeNull();
  }
});

test("refuses an ambiguous inherited prefix instead of choosing a checkpoint", async () => {
  config.llmProxy.appaHook = hookConfig();
  const opened = await open();
  const service = new AppaResponseFrame({
    session: opened.session,
    profileId: opened.profileId,
  });
  const request = {
    messages: [{ role: "user", content: "source" }],
  };
  const response = {
    content: [{ type: "text", text: "issued" }],
  };
  const first = await service.complete({
    runtimeEventId: randomUUID(),
    provider: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-test",
    request,
    response,
  });
  const second = await service.complete({
    runtimeEventId: randomUUID(),
    provider: "anthropic",
    protocol: "anthropic-messages",
    model: "claude-test",
    request,
    response,
  });
  const ledger = new AppaProxyLedger({
    ...opened.scope,
    profileId: opened.profileId,
  });
  await ledger.recordCheckpointBinding({
    checkpoint: {
      checkpoint_id: "checkpoint-one",
      source_scope: {},
      position: 1,
      digest: "one",
    },
    frame: first,
  });
  await ledger.recordCheckpointBinding({
    checkpoint: {
      checkpoint_id: "checkpoint-two",
      source_scope: {},
      position: 2,
      digest: "two",
    },
    frame: second,
  });
  const forkHistory = AppaHistoryCodec.request({
    protocol: "anthropic-messages",
    request: {
      messages: [
        { role: "user", content: "source" },
        { role: "assistant", content: "issued" },
        { role: "user", content: "fork" },
      ],
    },
  });

  await expect(
    ledger.matchingCheckpointFork({
      provider: "anthropic",
      model: "claude-test",
      history: forkHistory,
    }),
  ).rejects.toThrow("ambiguously matches multiple durable checkpoints");
});

async function open() {
  const ownerScopeHash = `owner:${randomUUID()}`;
  const profileId = randomUUID();
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
    turnId: turn.turnId,
  };
  return {
    profileId,
    scope,
    session: {
      getNativeWireScope: () => scope,
    } as unknown as AppaProxyHookSession,
  };
}

function hookConfig() {
  return {
    url: "http://appa.test.svc.cluster.local:18787",
    timeoutMs: 100,
    sessionHmacSecret: "response-frame-test-key".repeat(4),
  };
}
