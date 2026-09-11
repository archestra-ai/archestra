import { describe, expect, it } from "vitest";
import {
  buildCodexRequestUserInputTool,
  type CodexToolReference,
  type CodexWireAliases,
  isCodexRequestUserInputEligible,
  normalizeCodexRequestToNativeTools,
  rewriteCodexClientRequestToProxy,
  rewriteCodexProxyRequestToClient,
  rewriteCodexResponseToProxy,
} from "./appa-codex-wire";

const nativeTools: CodexToolReference[] = [
  { namespace: "functions", name: "exec_command", kind: "function" },
  { namespace: "functions", name: "apply_patch", kind: "custom" },
  { namespace: "collaboration", name: "spawn_agent", kind: "function" },
];

const aliases: CodexWireAliases = {
  callIds: [
    {
      clientId: "call-client-spawn",
      proxyId: "call-proxy-spawn",
      namespace: "collaboration",
      name: "spawn_agent",
      kind: "function",
    },
  ],
  itemIds: [{ clientId: "item-client-spawn", proxyId: "item-proxy-spawn" }],
  tasks: [
    {
      logicalTaskPath: "/tasks/root/reader",
      clientTaskPath: "/root/reader__proxy_7c91",
      wireTaskName: "reader__proxy_7c91",
    },
  ],
};

describe("normalizeCodexRequestToNativeTools", () => {
  it("moves additional tools to native declarations, preserves namespaces, and withholds exec", () => {
    const result = normalizeCodexRequestToNativeTools({
      body: {
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [
                  { type: "custom", name: "exec" },
                  { type: "function", name: "exec_command" },
                  { type: "custom", name: "apply_patch" },
                ],
              },
              {
                type: "namespace",
                name: "mcp__catalog",
                tools: [{ type: "function", name: "read" }],
              },
            ],
          },
          { type: "message", role: "user", content: "run direct tools" },
        ],
        parallel_tool_calls: true,
      },
      headers: {
        "X-OpenAI-Internal-Codex-Responses-Lite": "true",
        "x-client-request-id": "request-1",
      },
    });

    expect(result.body.input).toEqual([
      { type: "message", role: "user", content: "run direct tools" },
    ]);
    expect(result.body.tools).toEqual([
      {
        type: "namespace",
        name: "functions",
        tools: [
          { type: "function", name: "exec_command" },
          { type: "custom", name: "apply_patch" },
        ],
      },
      {
        type: "namespace",
        name: "mcp__catalog",
        tools: [{ type: "function", name: "read" }],
      },
    ]);
    expect(result.headers).toEqual({ "x-client-request-id": "request-1" });
  });

  it("withholds an already-top-level exec declaration without an additional_tools packet", () => {
    const result = normalizeCodexRequestToNativeTools({
      body: {
        input: [{ type: "message", role: "user", content: "hello" }],
        tools: [
          { type: "custom", name: "exec" },
          { type: "function", name: "exec_command" },
        ],
      },
    });

    expect(result.body.tools).toEqual([
      { type: "function", name: "exec_command" },
    ]);
  });

  it("preserves stock top-level Responses functions without synthesizing Code Mode tools", () => {
    const tools = [
      {
        type: "function",
        name: "exec_command",
        parameters: { type: "object", required: ["cmd"] },
      },
      {
        type: "function",
        name: "write_stdin",
        parameters: { type: "object", required: ["session_id"] },
      },
    ];

    const result = normalizeCodexRequestToNativeTools({
      body: {
        input: [{ type: "message", role: "user", content: "inspect" }],
        tools,
      },
    });

    expect(result.body).toEqual({
      input: [{ type: "message", role: "user", content: "inspect" }],
      tools,
    });
  });
});

describe("rewriteCodexResponseToProxy", () => {
  it("uses parent allocations, preserves encrypted payloads, and records spawn birth aliases", () => {
    const encrypted = "gAAAAA-nonce-like-ciphertext";
    const result = rewriteCodexResponseToProxy({
      response: {
        output: [
          {
            type: "function_call",
            id: "item-client-spawn",
            call_id: "call-client-spawn",
            namespace: "collaboration",
            name: "spawn_agent",
            arguments: JSON.stringify({
              task_name: "reader",
              message: encrypted,
            }),
            encrypted_function_args: encrypted,
          },
        ],
      },
      knownTools: nativeTools,
      allocations: [
        {
          providerCallId: "call-client-spawn",
          providerItemId: "item-client-spawn",
          clientCallId: "call-proxy-spawn",
          clientItemId: "item-proxy-spawn",
          taskAlias: aliases.tasks[0],
        },
      ],
    });

    const call = result.response.output as Array<Record<string, unknown>>;
    expect(call[0]).toMatchObject({
      id: "item-proxy-spawn",
      call_id: "call-proxy-spawn",
      encrypted_function_args: encrypted,
    });
    expect(JSON.parse(call[0].arguments as string)).toEqual({
      task_name: "reader__proxy_7c91",
      message: encrypted,
    });
    expect(result.correlations).toEqual([
      {
        kind: "tool_call",
        namespace: "collaboration",
        name: "spawn_agent",
        toolKind: "function",
        providerCallId: "call-client-spawn",
        providerItemId: "item-client-spawn",
        providerCallIdPresent: true,
        providerItemIdPresent: true,
        clientCallId: "call-proxy-spawn",
        clientItemId: "item-proxy-spawn",
        taskAlias: aliases.tasks[0],
      },
    ]);
  });

  it("uses parent output-position allocations when Codex omits both IDs", () => {
    const result = rewriteCodexResponseToProxy({
      response: {
        output: [
          { type: "message", role: "assistant", content: [] },
          {
            type: "function_call",
            namespace: "functions",
            name: "exec_command",
            arguments: "{}",
          },
        ],
      },
      knownTools: nativeTools,
      allocations: [
        {
          outputIndex: 1,
          clientCallId: "call-parent-generated",
          clientItemId: "item-parent-generated",
        },
      ],
    });

    const output = result.response.output as Array<Record<string, unknown>>;
    expect(output[1]).toMatchObject({
      call_id: "call-parent-generated",
      id: "item-parent-generated",
    });
    expect(result.correlations).toEqual([
      {
        kind: "tool_call",
        namespace: "functions",
        name: "exec_command",
        toolKind: "function",
        providerCallIdPresent: false,
        providerItemIdPresent: false,
        clientCallId: "call-parent-generated",
        clientItemId: "item-parent-generated",
      },
    ]);
  });

  it("rejects duplicate IDs, duplicate allocations, and unregistered tool kinds or namespaces", () => {
    const response = {
      output: [
        {
          type: "function_call",
          id: "item-client-spawn",
          call_id: "call-client-spawn",
          namespace: "collaboration",
          name: "spawn_agent",
          arguments: '{"task_name":"reader","message":"cipher"}',
        },
      ],
    };
    expect(() =>
      rewriteCodexResponseToProxy({
        response,
        knownTools: nativeTools,
        allocations: [],
      }),
    ).toThrow("Missing client ID allocation");
    expect(() =>
      rewriteCodexResponseToProxy({
        response,
        knownTools: nativeTools,
        allocations: [
          {
            providerCallId: "call-client-spawn",
            providerItemId: "item-client-spawn",
            clientCallId: "call-proxy-a",
            clientItemId: "item-proxy-a",
          },
          {
            outputIndex: 1,
            providerCallId: "call-client-spawn",
            providerItemId: "item-client-spawn",
            clientCallId: "call-proxy-b",
            clientItemId: "item-proxy-b",
          },
        ],
      }),
    ).toThrow("Duplicate allocated provider call ID");
    expect(() =>
      rewriteCodexResponseToProxy({
        response: {
          output: [
            response.output[0],
            { ...response.output[0], id: "item-client-second" },
          ],
        },
        knownTools: nativeTools,
        allocations: [
          {
            providerCallId: "call-client-spawn",
            providerItemId: "item-client-spawn",
            clientCallId: "call-proxy-spawn",
            clientItemId: "item-proxy-spawn",
          },
        ],
      }),
    ).toThrow("Duplicate Codex call_id: call-client-spawn");
    expect(() =>
      rewriteCodexResponseToProxy({
        response: {
          output: [
            response.output[0],
            { ...response.output[0], call_id: "call-client-second" },
          ],
        },
        knownTools: nativeTools,
        allocations: [
          {
            providerCallId: "call-client-spawn",
            providerItemId: "item-client-spawn",
            clientCallId: "call-proxy-spawn",
            clientItemId: "item-proxy-spawn",
          },
        ],
      }),
    ).toThrow("Duplicate Codex item id: item-client-spawn");
    expect(() =>
      rewriteCodexResponseToProxy({
        response: {
          output: [
            {
              ...response.output[0],
              namespace: "unknown_namespace",
              name: "unknown_tool",
            },
          ],
        },
        knownTools: nativeTools,
        allocations: [
          {
            providerCallId: "call-client-spawn",
            providerItemId: "item-client-spawn",
            clientCallId: "call-proxy-spawn",
            clientItemId: "item-proxy-spawn",
          },
        ],
      }),
    ).toThrow("Unknown Codex tool unknown_namespace.unknown_tool");
    expect(() =>
      rewriteCodexResponseToProxy({
        response: {
          output: [{ ...response.output[0], type: "custom_tool_call" }],
        },
        knownTools: nativeTools,
        allocations: [
          {
            providerCallId: "call-client-spawn",
            providerItemId: "item-client-spawn",
            clientCallId: "call-proxy-spawn",
            clientItemId: "item-proxy-spawn",
          },
        ],
      }),
    ).toThrow("Unknown Codex tool collaboration.spawn_agent (custom)");
    expect(() =>
      rewriteCodexResponseToProxy({
        response: {
          output: [
            {
              ...response.output[0],
              arguments: '{"task_name":"reader"}',
            },
          ],
        },
        knownTools: nativeTools,
        allocations: [
          {
            providerCallId: "call-client-spawn",
            providerItemId: "item-client-spawn",
            clientCallId: "call-proxy-spawn",
            clientItemId: "item-proxy-spawn",
            taskAlias: aliases.tasks[0],
          },
        ],
      }),
    ).toThrow("spawn_agent arguments requires non-empty message");
  });
});

describe("Codex request aliases", () => {
  it("round-trips IDs and rewrites only protocol task fields", () => {
    const nonceText =
      "do not rewrite /tasks/root/reader inside ordinary user text";
    const result = rewriteCodexProxyRequestToClient({
      aliases,
      threadBinding: {
        clientParentThreadId: "thread-client-parent",
        clientThreadId: "thread-client-child",
        logicalParentThreadId: "thread-proxy-parent",
        logicalThreadId: "thread-proxy-child",
      },
      request: {
        headers: {
          "x-codex-parent-thread-id": "thread-proxy-parent",
          "thread-id": "thread-proxy-child",
          "x-codex-turn-metadata": {
            parent_thread_id: "thread-proxy-parent",
            thread_id: "thread-proxy-child",
            agent_name: "/tasks/root/reader",
          },
        },
        input: [
          {
            type: "function_call",
            id: "item-proxy-spawn",
            call_id: "call-proxy-spawn",
            namespace: "collaboration",
            name: "wait_agent",
            arguments: JSON.stringify({ task_name: "/tasks/root/reader" }),
          },
          {
            type: "agent_message",
            author: "/tasks/root/reader",
            recipient: "/tasks/root/reader",
            content: nonceText,
          },
          { type: "message", role: "user", content: nonceText },
        ],
      },
    });

    const input = result.request.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({
      id: "item-client-spawn",
      call_id: "call-client-spawn",
    });
    expect(JSON.parse(input[0].arguments as string)).toEqual({
      task_name: "/root/reader__proxy_7c91",
    });
    expect(input[1]).toMatchObject({
      author: "/root/reader__proxy_7c91",
      recipient: "/root/reader__proxy_7c91",
      content: nonceText,
    });
    expect(input[2].content).toBe(nonceText);
    const headers = result.request.headers as Record<string, unknown>;
    expect(headers["x-codex-parent-thread-id"]).toBe("thread-client-parent");
    expect(headers["thread-id"]).toBe("thread-client-child");
    expect(headers["x-codex-turn-metadata"]).toMatchObject({
      agent_name: "/root/reader__proxy_7c91",
      parent_thread_id: "thread-client-parent",
      thread_id: "thread-client-child",
    });
  });

  it("maps child metadata only with its supplied ledger binding and surfaces V1 agent IDs", () => {
    const request = {
      headers: {
        "x-codex-parent-thread-id": "thread-client-parent",
        "thread-id": "thread-client-child",
        "x-codex-turn-metadata": JSON.stringify({
          parent_thread_id: "thread-client-parent",
          thread_id: "thread-client-child",
          agent_name: "/root/reader__proxy_7c91",
        }),
      },
      input: [
        {
          type: "function_call_output",
          call_id: "call-client-spawn",
          output: JSON.stringify({ agent_id: "agent-client-v1" }),
        },
        {
          type: "agent_message",
          author: "/root/reader__proxy_7c91",
          recipient: "/root/reader__proxy_7c91",
        },
      ],
    };
    expect(() =>
      rewriteCodexClientRequestToProxy({ request, aliases }),
    ).toThrow("requires a parent-ledger thread binding");

    const result = rewriteCodexClientRequestToProxy({
      request,
      aliases,
      threadBinding: {
        clientParentThreadId: "thread-client-parent",
        clientThreadId: "thread-client-child",
        logicalParentThreadId: "thread-proxy-parent",
        logicalThreadId: "thread-proxy-child",
      },
    });
    const input = result.request.input as Array<Record<string, unknown>>;
    expect(input[0].call_id).toBe("call-proxy-spawn");
    expect(input[1]).toMatchObject({
      author: "/tasks/root/reader",
      recipient: "/tasks/root/reader",
    });
    expect(result.v1SpawnResults).toEqual([
      {
        clientCallId: "call-client-spawn",
        proxyCallId: "call-proxy-spawn",
        clientAgentId: "agent-client-v1",
      },
    ]);
  });
});

describe("request_user_input declaration", () => {
  it("is eligible only for the registered root Plan/default context", () => {
    expect(
      isCodexRequestUserInputEligible({
        isRootRegisteredHandler: true,
        mode: "plan",
        defaultModeRequestUserInput: false,
      }),
    ).toBe(true);
    expect(
      isCodexRequestUserInputEligible({
        isRootRegisteredHandler: false,
        mode: "plan",
        defaultModeRequestUserInput: true,
      }),
    ).toBe(false);
    expect(
      isCodexRequestUserInputEligible({
        isRootRegisteredHandler: true,
        mode: "default",
        defaultModeRequestUserInput: false,
      }),
    ).toBe(false);
    expect(buildCodexRequestUserInputTool()).toMatchObject({
      type: "function",
      name: "request_user_input",
      parameters: { required: ["questions"] },
    });
  });
});
