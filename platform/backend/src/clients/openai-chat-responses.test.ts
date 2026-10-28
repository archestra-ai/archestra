import { type ModelMessage, stepCountIs, streamText, tool } from "ai";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import openAiProxyRoutes from "@/routes/proxy/routes/openai";
import { afterEach, describe, expect, test } from "@/test";
import { createLLMModel } from "./llm-client";

// Exercise the actual client, proxy and SDK tool loop; only upstream HTTP is fake.
// Use local HTTP servers, as azure-chat-responses.test.ts does: the proxy closes
// its upstream iterator at the final event, and canceling an MSW-teed response
// body can otherwise deadlock.
let upstreamApp: ReturnType<typeof Fastify> | undefined;
let proxyApp: ReturnType<typeof createFastifyInstance> | undefined;

afterEach(async () => {
  proxyApp?.server.closeAllConnections();
  await proxyApp?.close();
  upstreamApp?.server.closeAllConnections();
  await upstreamApp?.close();
  upstreamApp = undefined;
  proxyApp = undefined;
});

// gpt-5.6 is a name the AI SDK already treats as a reasoning model; gpt-6 is
// not, so it depends on the client forcing reasoning.
describe.each([
  "gpt-5.6-sol",
  "gpt-6.1-sol",
  "gpt-6-luna",
])("OpenAI %s over Responses", (modelName) => {
  test("resends encrypted reasoning on the tool step that follows", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    config.llmProxy.plugins = [];
    const bodies: Array<Record<string, unknown>> = [];
    upstreamApp = Fastify();
    upstreamApp.post(
      "/v1/responses",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Record<string, unknown>;
        bodies.push(body);
        const input = body.input as Array<Record<string, unknown>>;
        // Under store:false OpenAI keeps nothing, so a reasoning item sent
        // back by id alone is rejected.
        const bareReasoning = input.some(
          (item) =>
            (item.type === "item_reference" || item.type === "reasoning") &&
            !item.encrypted_content,
        );
        if (bareReasoning) {
          return reply.code(404).send({
            error: {
              message: "Items are not persisted when `store` is set to false.",
              type: "invalid_request_error",
            },
          });
        }
        const hasResult = input.some(
          (item) => item.type === "function_call_output",
        );
        return reply.type("text/event-stream").send(
          responseStream({
            modelName,
            toolCall: !hasResult,
            encrypted:
              Array.isArray(body.include) &&
              body.include.includes("reasoning.encrypted_content"),
          }),
        );
      },
    );
    upstreamApp.post(
      "/v1/chat/completions",
      async (_request: FastifyRequest, reply: FastifyReply) =>
        reply.code(400).send({
          error: {
            message:
              "Function tools with reasoning_effort are not supported in /v1/chat/completions.",
          },
        }),
    );
    const upstreamUrl = await upstreamApp.listen({
      port: 0,
      host: "127.0.0.1",
    });
    config.llm.openai.baseUrl = `${upstreamUrl}/v1`;
    proxyApp = createFastifyInstance();
    await proxyApp.register(openAiProxyRoutes);
    const proxyUrl = await proxyApp.listen({ port: 0, host: "127.0.0.1" });
    config.api.port = Number(new URL(proxyUrl).port);
    const model = createLLMModel({
      provider: "openai",
      apiKey: "sk-test",
      agentId: agent.id,
      modelName,
      baseUrl: null,
      source: "chat",
    });
    const executedPaths: string[] = [];
    const messages: ModelMessage[] = [
      { role: "user", content: "Read the marker." },
    ];
    const result = streamText({
      model,
      messages,
      tools: {
        read_file: tool({
          inputSchema: z.object({ path: z.string() }),
          execute: async ({ path }) => {
            executedPaths.push(path);
            return "TEST_OK";
          },
        }),
      },
      temperature: 0.2,
      // What agent chat sends for a Responses-routed OpenAI model.
      providerOptions: {
        openai: { store: false, reasoningSummary: "auto" },
      },
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    expect(await result.text).toBe("The marker is TEST_OK.");
    expect(executedPaths).toEqual(["/tmp/marker.txt"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      model: modelName,
      store: false,
      include: expect.arrayContaining(["reasoning.encrypted_content"]),
      reasoning: { summary: "auto" },
    });
    // Reasoning models reject sampling parameters.
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "opaque-reasoning",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_read",
          output: "TEST_OK",
        }),
      ]),
    );
  });
});

function responseStream(params: {
  modelName: string;
  toolCall: boolean;
  encrypted: boolean;
}) {
  const reasoning = {
    type: "reasoning",
    id: "rs_test",
    ...(params.encrypted ? { encrypted_content: "opaque-reasoning" } : {}),
    summary: [{ type: "summary_text", text: "Checking the marker." }],
  };
  const output = params.toolCall
    ? {
        type: "function_call",
        id: "fc_test",
        call_id: "call_read",
        name: "read_file",
        arguments: '{"path":"/tmp/marker.txt"}',
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "The marker is TEST_OK.",
            annotations: [],
          },
        ],
      };
  const response = {
    id: "resp_test",
    object: "response",
    created_at: 1,
    model: params.modelName,
    status: "completed",
    output: [reasoning, output],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 2 },
    },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...reasoning, summary: [] },
    },
    {
      type: "response.reasoning_summary_part.added",
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      delta: "Checking the marker.",
    },
    {
      type: "response.reasoning_summary_part.done",
      item_id: "rs_test",
      output_index: 0,
      summary_index: 0,
      part: reasoning.summary[0],
    },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: params.toolCall
        ? { ...output, arguments: "" }
        : { ...output, content: [] },
    },
    params.toolCall
      ? {
          type: "response.function_call_arguments.delta",
          item_id: "fc_test",
          output_index: 1,
          delta: '{"path":"/tmp/marker.txt"}',
        }
      : {
          type: "response.output_text.delta",
          item_id: "msg_test",
          output_index: 1,
          content_index: 0,
          delta: "The marker is TEST_OK.",
        },
    { type: "response.output_item.done", output_index: 1, item: output },
    { type: "response.completed", response },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
