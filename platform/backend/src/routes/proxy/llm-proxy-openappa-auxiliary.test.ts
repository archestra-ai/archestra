/** Side calls must not join or rewrite the parent trajectory. */

import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config, { parseLlmProxyPlugins, parseOpenAppaConfig } from "@/config";
import * as database from "@/database";
import { ModelModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { rewriteConnectionProxySetupUrl } from "@/services/connection-proxy-setup-context";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createAnthropicTestClient } from "@/test/llm-provider-stubs";
import { type Agent, ApiError } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { anthropicAdapterFactory, openaiAdapterFactory } from "./adapters";
import { openAiResponsesAdapterFactory } from "./adapters/openai-responses";
import anthropicProxyRoutes from "./routes/anthropic";
import openAiProxyRoutes from "./routes/openai";

const native = await vi.hoisted(async () => {
  const { createRuntimeModule } = await import(
    "@/test/openappa-runtime-module"
  );
  return createRuntimeModule();
});
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/cache-manager");

const MARKER =
  "[appa] delegated trajectory appa2-dGVzdA.0123456789abcdef0123456789abcdef01234567 — child of appa-0123456789abcdef0123456789abcdef01234567.";

describe("OpenAPPA auxiliary analysis", () => {
  let app: FastifyInstance;
  let agent: Agent;
  let userId: string;
  let anthropicRequests: unknown[];
  let responsesRequests: unknown[];
  let unregisterAppaPlugin: () => void;

  beforeEach(async ({ makeAgent, makeMember, makeUser }) => {
    config.openappa = {
      ...parseOpenAppaConfig("true"),
      offerSigningSecret: "test-offer-signing-secret-32chars",
    };
    await GuardrailsDeploymentModel.setEnabled(true);
    config.llmProxy.plugins = parseLlmProxyPlugins(
      undefined,
      config.openappa.enabled,
    );
    unregisterAppaPlugin = registerLlmProxyPlugin(createAppaLlmProxyPlugin());
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    app = Fastify({
      rewriteUrl: rewriteConnectionProxySetupUrl,
    }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) =>
      reply.status(error instanceof ApiError ? error.statusCode : 500).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type:
            error instanceof ApiError
              ? error.type
              : "api_internal_server_error",
        },
      }),
    );
    await app.register(anthropicProxyRoutes);
    await app.register(openAiProxyRoutes);
    agent = await makeAgent({ name: "Auxiliary analysis" });
    userId = (await makeUser()).id;
    await makeMember(userId, agent.organizationId);
    anthropicRequests = [];
    responsesRequests = [];
    native.initializeOpenappa.mockResolvedValue(undefined);
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw) as { event?: string; spawn?: unknown };
      if (event.event === "tool_call") {
        return JSON.stringify({
          decision: "allow_call",
          ...(event.spawn ? { spawn_binding: "prepared-fork" } : {}),
        });
      }
      if (event.event === "tool_result") {
        return JSON.stringify({
          decision: "replace_output",
          approved_output: "APPROVED REPLACEMENT",
          output_source: "tool",
        });
      }
      return JSON.stringify({ decision: "ack" });
    });
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(() => {
      const client = createAnthropicTestClient({
        includeToolUse: true,
        streamStopReason: "tool_use",
      });
      client.messages.create = async (params) => {
        anthropicRequests.push(structuredClone(params));
        const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
        return createAnthropicTestClient({
          includeToolUse: hasTools,
          responseText: "noted",
          ...(hasTools
            ? {
                nonStreamingToolUse: {
                  name: "get_weather",
                  input: { location: "SF" },
                },
              }
            : {}),
          messageId: `msg-${anthropicRequests.length}`,
          toolUseId: `toolu_aux_${anthropicRequests.length}`,
        }).messages.create(params);
      };
      return client as never;
    });
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async (params: unknown) => {
              responsesRequests.push(structuredClone(params));
              return {
                id: "resp_aux",
                object: "response",
                created_at: 1,
                status: "completed",
                model: "gpt-5.5",
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Label" }],
                  },
                ],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              };
            },
          },
        }) as never,
    );
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => ({ chat: { completions: { create: async () => ({}) } } }) as never,
    );
    await ModelModel.upsert({
      externalId: "anthropic/claude-3-5-sonnet-20241022",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5",
      provider: "openai",
      modelId: "gpt-5.5",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    unregisterAppaPlugin();
    vi.restoreAllMocks();
    await app.close();
  });

  const claudeHeaders = (session: string) => ({
    "x-api-key": "test-key",
    "anthropic-version": "2023-06-01",
    "x-archestra-user-id": userId,
    "user-agent": "claude-cli/2.1.288 (external, cli)",
    "x-claude-code-session-id": session,
  });

  const agentTools = () => [
    {
      name: "get_weather",
      description: "Weather",
      input_schema: {
        type: "object",
        properties: { location: { type: "string" } },
      },
    },
    {
      name: "archestra__execute_remedy_plan",
      description: "Execute a remedy",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "archestra__get_remedy_plans",
      description: "Read a ruling",
      input_schema: { type: "object", properties: {} },
    },
  ];

  test.each([
    false,
    true,
  ])("post-compaction Claude turns omit only the empty system message through replay (stream=%s)", async (stream) => {
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(() => {
      const client = createAnthropicTestClient({
        includeToolUse: false,
        responseText: "REPORT-MARKER",
      });
      client.messages.create = async (params) => {
        anthropicRequests.push(structuredClone(params));
        expect(
          params.messages.some(
            (message) =>
              String(message.role) === "system" &&
              Array.isArray(message.content) &&
              message.content.length === 0,
          ),
        ).toBe(false);
        return createAnthropicTestClient({
          includeToolUse: false,
          responseText: "REPORT-MARKER",
        }).messages.create(params);
      };
      return client as never;
    });
    const messages = [
      { role: "user", content: "Compacted history" },
      { role: "system", content: [] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "REPORT-MARKER",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Continue after compaction" }],
      },
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "Available agent types",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ];
    const original = structuredClone(messages);
    for (let turn = 0; turn < 3; turn++) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          ...claudeHeaders(`compact-${stream}`),
          "anthropic-beta": "mid-conversation-system-2026-04-07",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 256,
          stream,
          system: "Base instructions",
          tools: agentTools(),
          messages,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("REPORT-MARKER");
      const actual = anthropicRequests.at(-1) as
        | { messages: unknown[] }
        | undefined;
      expect(actual?.messages.slice(0, 4)).toEqual(
        original.filter(
          (message) =>
            !(message.role === "system" && message.content.length === 0),
        ),
      );
      messages.push(
        {
          role: "assistant",
          content: [{ type: "text", text: "REPORT-MARKER" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Repeat without tools" }],
        },
      );
    }
    expect(messages[1]).toEqual({ role: "system", content: [] });
  });

  test.each([
    false,
    true,
  ])("quoted JSON analysis does not join the parent replay or change provider bytes (jsonl=%s)", async (jsonl) => {
    const session = "5f1c2a3b-8e9d-4c7b-a6f5-0e1d2c3b4a59";
    const parentBody = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Check the weather" }],
      tools: agentTools(),
    };
    let quoted = JSON.stringify({
      transcript: `parent said\n${MARKER}\nthen stopped`,
      tools: [],
    });
    if (jsonl)
      quoted += `\n${JSON.stringify({ tool: "quoted second event" })}\n`;
    const analysis = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      system: [
        { type: "text", text: "Classify the quoted transcript." },
        {
          type: "text",
          text: "Examples may mention <teammate-message> and <cross-session-message>.",
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Rate this transcript." },
            { type: "text", text: quoted },
          ],
        },
      ],
    };

    const first = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      remoteAddress: "127.0.0.1",
      headers: claudeHeaders(session),
      payload: parentBody,
    });
    expect(first.statusCode, first.body).toBe(200);
    const toolUse = (
      first.json() as { content: Array<Record<string, unknown>> }
    ).content.find((block) => block.type === "tool_use");
    expect(toolUse?.id).toEqual(expect.any(String));
    await drainBackgroundWork();

    const side = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      remoteAddress: "127.0.0.1",
      headers: claudeHeaders(session),
      payload: analysis,
    });
    expect(side.statusCode, side.body).toBe(200);
    const delivered = anthropicRequests.at(-1) as {
      messages?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(delivered.messages?.[0]?.content?.[1]?.text).toBe(quoted);
    expect(delivered.messages?.[0]?.content?.[1]?.text).toContain(MARKER);
    await drainBackgroundWork();

    anthropicRequests.length = 0;
    const continued = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      remoteAddress: "127.0.0.1",
      headers: claudeHeaders(session),
      payload: {
        ...parentBody,
        messages: [
          { role: "user", content: "Check the weather" },
          { role: "assistant", content: [toolUse] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUse?.id,
                content: "Sunny",
              },
            ],
          },
          { role: "user", content: "Thanks" },
        ],
      },
    });
    expect(continued.statusCode, continued.body).toBe(200);
    expect(JSON.stringify(anthropicRequests[0])).toContain("Check the weather");
    expect(JSON.stringify(anthropicRequests[0])).not.toContain(MARKER);
  });

  test("an unverified marker line still fails closed", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      remoteAddress: "127.0.0.1",
      headers: claudeHeaders("68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6"),
      payload: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user", content: `Open the child.\n\n${MARKER}` }],
        tools: agentTools(),
      },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.body).toContain("cannot verify exact replay");
    expect(anthropicRequests).toHaveLength(0);
  });

  test("a structured side call does not rewrite trajectory metadata or the other thread", async () => {
    const mainThread = "11111111-1111-4111-8111-111111111111";
    const sideThread = "22222222-2222-4222-8222-222222222222";
    const turnMetadata = JSON.stringify({ request_kind: "label" });
    const mainPayload = {
      model: "gpt-5.5",
      stream: false,
      input: [{ role: "user", content: "Check the weather" }],
      client_metadata: { session_id: mainThread, thread_id: mainThread },
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Weather",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "archestra__execute_remedy_plan",
          description: "Execute a remedy",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "archestra__get_remedy_plans",
          description: "Read a ruling",
          parameters: { type: "object", properties: {} },
        },
      ],
    };
    const sidePayload = {
      model: "gpt-5.5",
      stream: false,
      tool_choice: "auto",
      parallel_tool_calls: false,
      client_metadata: {
        session_id: sideThread,
        thread_id: sideThread,
        "x-codex-turn-metadata": turnMetadata,
      },
      text: {
        format: {
          type: "json_schema",
          name: "label",
          strict: true,
          schema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            additionalProperties: false,
          },
        },
      },
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "collaboration",
              tools: [
                {
                  type: "function",
                  name: "spawn_agent",
                  description: "Spawn",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Return a short label." }],
        },
      ],
    };

    const opened = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-user-id": userId,
        "user-agent": "codex_cli_rs/0.153.0 (Linux 6.6; x86_64)",
        originator: "codex_cli_rs",
      },
      payload: mainPayload,
    });
    expect(opened.statusCode, opened.body).toBe(200);
    await drainBackgroundWork();

    const side = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-user-id": userId,
        "user-agent": "codex_cli_rs/0.153.0 (Linux 6.6; x86_64)",
        originator: "codex_cli_rs",
      },
      payload: sidePayload,
    });
    expect(side.statusCode, side.body).toBe(200);
    expect(side.body).not.toContain("provider-visible rewrite");
    const delivered = responsesRequests.at(-1) as {
      client_metadata?: Record<string, string>;
    };
    expect(
      delivered.client_metadata?.["x-codex-turn-metadata"],
    ).toBeUndefined();
    await drainBackgroundWork();
    const logged = await database.default
      .select({
        request: database.schema.interactionsTable.request,
        processedRequest: database.schema.interactionsTable.processedRequest,
      })
      .from(database.schema.interactionsTable)
      .where(eq(database.schema.interactionsTable.profileId, agent.id));
    const sideLog = logged.find((row) =>
      JSON.stringify(row.request).includes(sideThread),
    );
    const metadata = (
      sideLog?.request as { client_metadata?: Record<string, string> }
    )?.client_metadata;
    expect(metadata?.["x-codex-turn-metadata"]).toBe(turnMetadata);

    responsesRequests.length = 0;
    const continued = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-user-id": userId,
        "user-agent": "codex_cli_rs/0.153.0 (Linux 6.6; x86_64)",
        originator: "codex_cli_rs",
      },
      payload: {
        ...mainPayload,
        input: [
          ...mainPayload.input,
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Label" }],
          },
          { type: "message", role: "user", content: "And tomorrow?" },
        ],
      },
    });
    expect(continued.statusCode, continued.body).toBe(200);
    expect(JSON.stringify(responsesRequests[0])).toContain("Check the weather");
    expect(JSON.stringify(responsesRequests[0])).toContain("And tomorrow?");
    expect(JSON.stringify(responsesRequests[0])).not.toContain(turnMetadata);
  });

  test("a tool-bearing review retains quoted markers and required empty tools without bypassing call recording", async () => {
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async (params: unknown) => {
              responsesRequests.push(structuredClone(params));
              return {
                id: "resp_call",
                object: "response",
                created_at: 1,
                status: "completed",
                model: "gpt-5.5",
                output: [
                  {
                    type: "function_call",
                    call_id: "call_side_tool",
                    name: "curr_time",
                    arguments: "{}",
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              };
            },
          },
        }) as never,
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-user-id": userId,
        "user-agent": "codex_cli_rs/0.153.0 (Linux 6.6; x86_64)",
        originator: "codex_cli_rs",
      },
      payload: {
        model: "gpt-5.5",
        stream: false,
        tool_choice: "auto",
        text: {
          format: {
            type: "json_schema",
            name: "label",
            strict: true,
            schema: {
              type: "object",
              properties: { label: { type: "string" } },
              required: ["label"],
              additionalProperties: false,
            },
          },
        },
        input: [
          { type: "additional_tools", role: "developer", tools: [] },
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "function",
                name: "curr_time",
                description: "Clock",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[49] tool spawn_agent call: ${JSON.stringify({ message: `Quoted\n${MARKER}` })}\n`,
              },
            ],
          },
        ],
        client_metadata: {
          session_id: "33333333-3333-4333-8333-333333333333",
          thread_id: "33333333-3333-4333-8333-333333333333",
        },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("durable replay session");
    expect(response.body).toContain("appat1");
    expect(response.body).toContain("curr_time");
    const providerInput = (
      responsesRequests.at(-1) as {
        input: Array<{ tools?: unknown[]; content?: unknown }>;
      }
    ).input;
    expect(providerInput[0].tools).toEqual([]);
    expect(JSON.stringify(providerInput)).toContain(MARKER);
  });
});
