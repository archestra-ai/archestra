import { type ModelMessage, stepCountIs, streamText, tool } from "ai";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import azureProxyRoutes from "@/routes/proxy/routes/azure";
import { afterEach, describe, expect, test } from "@/test";
import { createLLMModel } from "./llm-client";

// Exercise the actual client, proxy and SDK tool loop; only upstream HTTP is fake.
// Use local HTTP servers: the proxy closes its upstream iterator at the final
// event, and canceling an MSW-teed response body can otherwise deadlock.
let upstreamApp: ReturnType<typeof Fastify> | undefined;
let proxyApp: ReturnType<typeof createProxyApp> | undefined;

afterEach(async () => {
  proxyApp?.server.closeAllConnections();
  await proxyApp?.close();
  upstreamApp?.server.closeAllConnections();
  await upstreamApp?.close();
  upstreamApp = undefined;
  proxyApp = undefined;
});

describe.each([
  "gpt-5.4",
  "gpt-6.1-sol",
  "gpt-6-luna",
])("Azure %s", (modelName) => {
  test("streams a tool turn and replays it on the next turn through Responses", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    config.llm.azure.baseUrl = "";
    config.llmProxy.plugins = [];
    const bodies: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    const proxyUrls: string[] = [];
    upstreamApp = Fastify();
    upstreamApp.post(
      "/openai/v1/responses",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Record<string, unknown>;
        bodies.push(body);
        urls.push(request.url);
        expect(request.headers["api-key"]).toBe("test-key");
        const input = body.input as Array<Record<string, unknown>>;
        expect(input.some((item) => item.type === "item_reference")).toBe(
          false,
        );
        const hasResult = input.some(
          (item) => item.type === "function_call_output",
        );
        return reply
          .type("text/event-stream")
          .send(responseStream({ modelName, toolCall: !hasResult }));
      },
    );
    upstreamApp.post(
      "/openai/v1/chat/completions",
      async (_request: FastifyRequest, reply: FastifyReply) =>
        reply.code(400).send({
          error: {
            message:
              "This deployment requires Responses for reasoning with function tools.",
          },
        }),
    );
    const upstreamUrl = await upstreamApp.listen({
      port: 0,
      host: "127.0.0.1",
    });
    proxyApp = createProxyApp();
    proxyApp.addHook("onRequest", async (request) => {
      proxyUrls.push(request.url);
    });
    await proxyApp.register(azureProxyRoutes);
    const proxyUrl = await proxyApp.listen({ port: 0, host: "127.0.0.1" });
    config.api.port = Number(new URL(proxyUrl).port);
    const model = createLLMModel({
      provider: "azure",
      apiKey: "test-key",
      agentId: agent.id,
      modelName,
      baseUrl: `${upstreamUrl}/openai/v1`,
      source: "chat",
    });
    const executedPaths: string[] = [];
    const tools = {
      read_file: tool({
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => {
          executedPaths.push(path);
          return "TEST_OK";
        },
      }),
    };
    const messages: ModelMessage[] = [
      { role: "user", content: "Read the marker." },
    ];
    const result = streamText({
      model,
      messages,
      tools,
      maxOutputTokens: 256,
      providerOptions: { openai: { reasoningEffort: "low", store: true } },
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    const parts = [];
    for await (const part of result.fullStream) parts.push(part);
    expect(await result.text).toBe("The marker is TEST_OK.");
    expect(executedPaths).toEqual(["/tmp/marker.txt"]);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning-delta",
          text: "Checking the marker.",
        }),
        expect.objectContaining({ type: "tool-call", toolName: "read_file" }),
        expect.objectContaining({ type: "tool-result", output: "TEST_OK" }),
      ]),
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      model: modelName,
      store: false,
      max_output_tokens: 256,
      include: expect.arrayContaining(["reasoning.encrypted_content"]),
      tools: expect.arrayContaining([
        expect.objectContaining({ type: "function", name: "read_file" }),
      ]),
    });
    // The SDK knows this reasoning family and must preserve its chosen effort.
    if (modelName === "gpt-5.4") {
      expect(bodies[0].reasoning).toMatchObject({ effort: "low" });
    }
    expect(bodies[0]).not.toHaveProperty("max_tokens");
    expect(bodies[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "opaque-reasoning",
        }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_read",
          name: "read_file",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_read",
          output: "TEST_OK",
        }),
      ]),
    );
    const followup = streamText({
      model,
      tools,
      messages: [
        ...messages,
        ...(await result.response).messages,
        { role: "user", content: "Repeat the marker." },
      ],
      maxRetries: 0,
    });
    expect(await followup.text).toBe("The marker is TEST_OK.");
    expect(bodies).toHaveLength(3);
    expect(bodies[2].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call_read",
        }),
        expect.objectContaining({
          type: "function_call_output",
          output: "TEST_OK",
        }),
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({ text: "The marker is TEST_OK." }),
          ]),
        }),
      ]),
    );
    expect(
      new URL(proxyUrls[0], proxyUrl).searchParams.get("api-version"),
    ).toBe(config.llm.azure.responsesApiVersion);
    expect(new URL(urls[0], upstreamUrl).searchParams.has("api-version")).toBe(
      false,
    );
  });
});

function createProxyApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

function responseStream(params: { modelName: string; toolCall: boolean }) {
  const reasoning = {
    type: "reasoning",
    id: "rs_test",
    encrypted_content: "opaque-reasoning",
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
