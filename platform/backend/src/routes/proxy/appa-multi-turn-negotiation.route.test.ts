import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { ModelModel, TeamTokenModel, VirtualApiKeyModel } from "@/models";
import mcpGatewayRoutes from "@/routes/mcp-gateway";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  anthropicAdapterFactory,
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
} from "./adapters";
import type { AppaProxyHookConfig } from "./appa-proxy-hook";
import anthropicProxyRoutes from "./routes/anthropic";
import openAiProxyRoutes from "./routes/openai";

const runtimeUrl = "http://multi-turn-runtime.test";
const _hookUrl = `${runtimeUrl}/hook`;
const hookConfig: AppaProxyHookConfig = {
  url: runtimeUrl,
  timeoutMs: 100,
  runtimeToken: "multi-turn-runtime-token",
  sessionHmacSecret: "multi-turn-session-secret".repeat(3),
  nativeCodexEnabled: true,
};

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper for HTTP boundary tests
const server = useMswServer();

describe("multi-turn model negotiation for local and gateway tools", () => {
  let app: FastifyInstance;
  const originalHookConfig = config.llmProxy.appaHook;

  beforeEach(async () => {
    config.llmProxy.appaHook = hookConfig;
    installMockAppaRuntime();
    app = createRouteApp();
    await app.register(openAiProxyRoutes);
    await app.register(anthropicProxyRoutes);
    await app.register(mcpGatewayRoutes);
    await ModelModel.upsert({
      externalId: "anthropic/claude-3-5-sonnet",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "3.00",
      customPricePerMillionOutput: "15.00",
      lastSyncedAt: new Date(),
    });
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    config.llmProxy.appaHook = originalHookConfig;
    vi.restoreAllMocks();
    await app.close();
  });

  test("Claude Code multi-turn negotiation: holds disallowed call, issues remedy tool_use, releases on tool_result", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ name: "Claude Multi-Turn Agent" });
    await makeMember(user.id as never, agent.organizationId as never);
    const { value: passthroughToken } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Claude Multi-Turn Key",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });
    const { value: mcpToken } = await TeamTokenModel.create({
      organizationId: agent.organizationId,
      name: "Claude Gateway Token",
      teamId: null,
      isOrganizationToken: true,
    });

    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          messages: {
            create: async () => ({
              id: "msg_claude_initial",
              type: "message",
              role: "assistant",
              model: "claude-3-5-sonnet",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_local_bash_1",
                  name: "Bash",
                  input: { command: "cat /etc/shadow" },
                },
              ],
              stop_reason: "tool_use",
              usage: { input_tokens: 15, output_tokens: 25 },
            }),
          },
        }) as never,
    );

    // Turn 1: Initial call from Claude Code
    const turn1Response = await app.inject({
      method: "POST",
      url: "/v1/anthropic/v1/messages",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
        "x-archestra-session-id": "claude-negotiation-thread-1",
        "x-archestra-agent-id": agent.id,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/1.0.0",
      },
      payload: {
        model: "claude-3-5-sonnet",
        max_tokens: 1000,
        messages: [{ role: "user", content: "Inspect system files" }],
        tools: [
          {
            name: "Bash",
            description: "Run bash command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      },
    });

    expect(turn1Response.statusCode, turn1Response.body).toBe(200);
    const turn1Json = turn1Response.json();
    expect(turn1Json.role).toBe("assistant");
    expect(turn1Json.content).toHaveLength(1);
    expect(turn1Json.content[0].type).toBe("tool_use");
    expect(turn1Json.content[0].name).toBe("archestra__appa_execute_remedy");
    const remedyToolCallId = turn1Json.content[0].id;
    const remedyInput = turn1Json.content[0].input;
    expect(remedyInput).toHaveProperty("intent_id");
    expect(remedyInput).toHaveProperty("wire_context");
    expect(remedyInput.wire_context.call_id).toBe(remedyToolCallId);

    // Gateway call: Client executes archestra__appa_execute_remedy via MCP Gateway
    const gatewayResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "archestra__appa_execute_remedy",
          arguments: remedyInput,
        },
      },
    });

    expect(gatewayResponse.statusCode).toBe(200);
    const gatewayJson = gatewayResponse.json();
    console.error(">>> GATEWAY JSON:", JSON.stringify(gatewayJson));
    const receiptText = gatewayJson.result?.content?.[0]?.text;
    expect(receiptText).toContain("remedied");

    // Turn 2: Claude Code sends back the tool_result for the remedy
    const turn2Response = await app.inject({
      method: "POST",
      url: "/v1/anthropic/v1/messages",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
        "x-archestra-session-id": "claude-negotiation-thread-1",
        "x-archestra-agent-id": agent.id,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/1.0.0",
      },
      payload: {
        model: "claude-3-5-sonnet",
        max_tokens: 1000,
        messages: [
          { role: "user", content: "Inspect system files" },
          { role: "assistant", content: turn1Json.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: remedyToolCallId,
                content: receiptText,
              },
            ],
          },
        ],
        tools: [
          {
            name: "Bash",
            description: "Run bash command",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      },
    });

    // Proxy short-circuits and returns the restored original response!
    expect(turn2Response.statusCode, turn2Response.body).toBe(200);
    const turn2Json = turn2Response.json();
    expect(turn2Json.role).toBe("assistant");
    expect(turn2Json.content).toHaveLength(1);
    expect(turn2Json.content[0].type).toBe("tool_use");
    expect(turn2Json.content[0].name).toBe("Bash");
    expect(turn2Json.content[0].input).toEqual({ command: "cat /etc/shadow" });
  });

  test("OpenCode multi-turn negotiation: holds disallowed call, issues remedy tool_call, releases on tool result", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ name: "OpenCode Multi-Turn Agent" });
    await makeMember(user.id as never, agent.organizationId as never);
    const { value: passthroughToken } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "OpenCode Multi-Turn Key",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });
    const { value: mcpToken } = await TeamTokenModel.create({
      organizationId: agent.organizationId,
      name: "OpenCode Gateway Token",
      teamId: null,
      isOrganizationToken: true,
    });

    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async () => ({
                id: "chatcmpl_opencode_initial",
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "gpt-4o",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_opencode_edit_1",
                          type: "function",
                          function: {
                            name: "edit",
                            arguments: '{"file":"/private/keys.env"}',
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: 30,
                  total_tokens: 50,
                },
              }),
            },
          },
        }) as never,
    );

    // Turn 1: OpenCode sends completion request
    const turn1Response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
        "x-archestra-session-id": "opencode-negotiation-thread-1",
        "x-archestra-agent-id": agent.id,
        "content-type": "application/json",
        "user-agent": "opencode/2.1.0",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Edit private file" }],
        tools: [
          {
            type: "function",
            function: {
              name: "edit",
              description: "Edit a file",
              parameters: {
                type: "object",
                properties: { file: { type: "string" } },
              },
            },
          },
        ],
      },
    });

    expect(turn1Response.statusCode, turn1Response.body).toBe(200);
    const turn1Json = turn1Response.json();
    const toolCalls = turn1Json.choices[0].message.tool_calls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("archestra__appa_execute_remedy");
    const remedyCallId = toolCalls[0].id;
    const remedyArgs = JSON.parse(toolCalls[0].function.arguments);
    expect(remedyArgs).toHaveProperty("intent_id");
    expect(remedyArgs).toHaveProperty("wire_context");

    // Gateway call: Client executes remedy
    const gatewayResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "archestra__appa_execute_remedy",
          arguments: remedyArgs,
        },
      },
    });

    expect(gatewayResponse.statusCode).toBe(200);
    const gatewayJson = gatewayResponse.json();
    const receiptText = gatewayJson.result?.content?.[0]?.text;
    expect(receiptText).toContain("remedied");

    // Turn 2: OpenCode sends tool result back
    const turn2Response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
        "x-archestra-session-id": "opencode-negotiation-thread-1",
        "x-archestra-agent-id": agent.id,
        "content-type": "application/json",
        "user-agent": "opencode/2.1.0",
      },
      payload: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "Edit private file" },
          turn1Json.choices[0].message,
          {
            role: "tool",
            tool_call_id: remedyCallId,
            content: gatewayJson.result?.content?.[0]?.text ?? "remedied",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "edit",
              description: "Edit a file",
              parameters: {
                type: "object",
                properties: { file: { type: "string" } },
              },
            },
          },
        ],
      },
    });

    expect(turn2Response.statusCode, turn2Response.body).toBe(200);
    const turn2Json = turn2Response.json();
    const restoredCalls = turn2Json.choices[0].message.tool_calls;
    expect(restoredCalls).toHaveLength(1);
    expect(restoredCalls[0].function.name).toBe("edit");
    expect(JSON.parse(restoredCalls[0].function.arguments)).toEqual({
      file: "/private/keys.env",
    });
  });

  test("Codex multi-turn negotiation: holds disallowed call, issues remedy function_call, releases on tool result", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ name: "Codex Multi-Turn Agent" });
    await makeMember(user.id as never, agent.organizationId as never);
    const { value: passthroughToken } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Codex Multi-Turn Key",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });
    const { value: mcpToken } = await TeamTokenModel.create({
      organizationId: agent.organizationId,
      name: "Codex Gateway Token",
      teamId: null,
      isOrganizationToken: true,
    });

    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async () => ({
              id: "resp_codex_initial",
              object: "response",
              created_at: 1,
              model: "gpt-4o",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: "fc_codex_cmd_1",
                  call_id: "call_codex_cmd_1",
                  name: "functions.exec_command",
                  arguments: '{"cmd":"cat /etc/shadow"}',
                },
              ],
            }),
          },
        }) as never,
    );

    // Turn 1: Codex sends responses request
    const turn1Response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
        "x-archestra-session-id": "codex-negotiation-thread-1",
        "content-type": "application/json",
        originator: "codex_cli",
      },
      payload: {
        model: "gpt-4o",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Run privileged command" }],
          },
        ],
        tools: [
          {
            type: "function",
            name: "exec_command",
            description: "Run command",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
          {
            type: "function",
            name: "write_stdin",
            description: "Write stdin",
            parameters: {
              type: "object",
              properties: { session_id: { type: "string" } },
              required: ["session_id"],
            },
          },
        ],
      },
    });

    expect(turn1Response.statusCode, turn1Response.body).toBe(200);
    const turn1Json = turn1Response.json();
    const output = turn1Json.output;
    const remedyCall = output.find(
      (item: Record<string, unknown>) =>
        item.type === "function_call" &&
        item.name === "archestra__appa_execute_remedy",
    );
    expect(remedyCall).toBeDefined();
    const remedyArgs = JSON.parse(remedyCall.arguments);
    expect(remedyArgs).toHaveProperty("intent_id");
    expect(remedyArgs).toHaveProperty("wire_context");

    // Gateway call: Client executes remedy
    const gatewayResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "archestra__appa_execute_remedy",
          arguments: remedyArgs,
        },
      },
    });

    expect(gatewayResponse.statusCode).toBe(200);
    const gatewayJson = gatewayResponse.json();
    const receiptText = gatewayJson.result?.content?.[0]?.text;
    expect(receiptText).toContain("remedied");

    // Turn 2: Codex sends tool result back
    const turn2Response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": passthroughToken,
        "x-archestra-session-id": "codex-negotiation-thread-1",
        "content-type": "application/json",
        originator: "codex_cli",
      },
      payload: {
        model: "gpt-4o",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Run privileged command" }],
          },
          remedyCall,
          {
            type: "function_call_output",
            call_id: remedyCall.call_id,
            output: receiptText,
          },
        ],
        tools: [
          {
            type: "function",
            name: "exec_command",
            description: "Run command",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
          {
            type: "function",
            name: "write_stdin",
            description: "Write stdin",
            parameters: {
              type: "object",
              properties: { session_id: { type: "string" } },
              required: ["session_id"],
            },
          },
        ],
      },
    });

    expect(turn2Response.statusCode, turn2Response.body).toBe(200);
    const turn2Json = turn2Response.json();
    const restoredCall = turn2Json.output.find(
      (item: Record<string, unknown>) => item.type === "function_call",
    );
    expect(restoredCall).toBeDefined();
    expect(restoredCall.name).toBe("exec_command");
    expect(JSON.parse(restoredCall.arguments)).toEqual({
      cmd: "cat /etc/shadow",
    });
  });
});

function createRouteApp(): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app.withTypeProvider<ZodTypeProvider>() as unknown as FastifyInstance;
}

function installMockAppaRuntime() {
  const batches = new Map<
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
      const batchId = String(envelope.event.batch_id ?? "batch-1");
      const calls = envelope.event.calls as
        | Array<{
            call_id: string;
            tool: string;
            arguments: Record<string, unknown>;
          }>
        | undefined;
      if (envelope.event.event === "prepare_batch" && calls) {
        batches.set(batchId, calls);
      }
      const prepared = batches.get(batchId) ?? [];
      const decision =
        envelope.event.event === "prepare_batch"
          ? {
              decision: "batch_prepared",
              batch_id: batchId,
              root_id: envelope.event.root_id,
              next: "resolve_batch_offer or commit_batch",
              positions: prepared.map((call, position) => ({
                position,
                call_id: call.call_id,
                state: "blocked",
                tool: call.tool,
                arguments_sha256: createHash("sha256")
                  .update(JSON.stringify(call.arguments))
                  .digest("hex"),
                feedback: "requires sanitizer",
                offers: [
                  {
                    offer_id: `offer-${position}`,
                    kind: "sanitizer",
                    root_id: envelope.event.root_id,
                    tool: call.tool,
                    arguments_sha256: createHash("sha256")
                      .update(JSON.stringify(call.arguments))
                      .digest("hex"),
                    batch_id: batchId,
                    position,
                  },
                ],
                review: [],
              })),
            }
          : envelope.event.event === "commit_batch"
            ? {
                decision: "batch_committed",
                batch_id: batchId,
                calls: prepared.map((call, position) => ({
                  position,
                  call_id: call.call_id,
                  dispatch_id: `dispatch-${call.call_id}`,
                  tool: call.tool,
                  arguments_sha256: createHash("sha256")
                    .update(JSON.stringify(call.arguments))
                    .digest("hex"),
                  arguments: call.arguments,
                  spawn_binding: null,
                })),
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
}
