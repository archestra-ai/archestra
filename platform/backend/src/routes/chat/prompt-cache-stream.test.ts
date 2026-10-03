import { createAnthropic } from "@ai-sdk/anthropic";
import { jsonSchema, tool } from "ai";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import MessageModel from "@/models/message";
import ModelModel from "@/models/model";
import { describe, expect, test } from "@/test";
import {
  type AnthropicWireRequest,
  anthropicRequestBlocks,
  anthropicStreamResponse,
  expectLongerTtlFirst,
} from "@/test/anthropic-messages-wire";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import chatRoutes from "./routes";

const mockCreateLLMModelForAgent = vi.hoisted(() =>
  vi.fn<typeof import("@/clients/llm-client").createLLMModelForAgent>(),
);
const mockGetChatMcpTools = vi.hoisted(() => vi.fn());

vi.mock("@/clients/llm-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients/llm-client")>()),
  createLLMModelForAgent: mockCreateLLMModelForAgent,
}));

vi.mock("@/clients/chat-mcp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients/chat-mcp-client")>()),
  getChatMcpTools: mockGetChatMcpTools,
  getChatMcpToolUiResourceUris: vi.fn().mockResolvedValue({}),
}));

// Exercise the route, agent loop, SDK serialization, response stream, and
// persistence with stubbed authentication, model selection, and MCP/upstream
// boundaries. Synthetic usage values do not establish provider cache hits.
describe("POST /api/chat Anthropic tool-loop caching", () => {
  const server = useMswServer();
  const ctx = useRouteTestApp(chatRoutes);

  describe.each([
    {
      endpoint: "native",
      anthropicNativeEndpoint: true,
      contextTrimRetry: false,
    },
    {
      endpoint: "compatible",
      anthropicNativeEndpoint: false,
      contextTrimRetry: false,
    },
    {
      endpoint: "native after context trimming",
      anthropicNativeEndpoint: true,
      contextTrimRetry: true,
    },
  ])("$endpoint endpoint", ({ anthropicNativeEndpoint, contextTrimRetry }) => {
    test("preserves tool results and applies the endpoint's caching policy", async ({
      makeAgent,
      makeConversation,
      makeMember,
    }) => {
      await makeMember(ctx.user.id, ctx.organizationId);
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        systemPrompt: "Use the available tool to inspect the synthetic API.",
      });
      const model = await ModelModel.create({
        externalId: "anthropic/claude-opus-4-6",
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        supportsToolCalling: true,
        contextLength: 200000,
        outputLength: 8192,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });
      const conversation = await makeConversation(agent.id, {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
        modelId: model.id,
      });
      mockCreateLLMModelForAgent.mockResolvedValue({
        model: createAnthropic({
          apiKey: "test-key",
          baseURL: UPSTREAM_BASE_URL,
        })(model.modelId),
        provider: "anthropic",
        apiKeySource: "org",
        anthropicNativeEndpoint,
      });

      const executedSteps: number[] = [];
      mockGetChatMcpTools.mockResolvedValue({
        inspect_api: tool({
          description: "Read the synthetic API specification or inspect a path",
          inputSchema: jsonSchema<{ step: number }>({
            type: "object",
            properties: { step: { type: "integer" } },
            required: ["step"],
            additionalProperties: false,
          }),
          execute: async ({ step }) => {
            executedSteps.push(step);
            return step === 1 ? LARGE_SPEC : `Path ${step} checked`;
          },
        }),
      });

      const requests: AnthropicWireRequest[] = [];
      server.use(
        http.post(`${UPSTREAM_BASE_URL}/messages`, async ({ request }) => {
          const body = (await request.json()) as AnthropicWireRequest;
          requests.push(body);
          if (contextTrimRetry && requests.length === 1) {
            return HttpResponse.json(
              {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message:
                    "prompt is too long: 1000034 tokens > 1000000 maximum",
                },
              },
              { status: 400 },
            );
          }
          const toolResults = anthropicRequestBlocks(body).filter(
            (block) => block.type === "tool_result",
          );
          return anthropicResponse(toolResults.length);
        }),
      );

      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/chat",
        payload: {
          id: conversation.id,
          trigger: "submit-message",
          messages: [
            ...(contextTrimRetry
              ? [
                  {
                    id: crypto.randomUUID(),
                    role: "user",
                    parts: [
                      { type: "text", text: "Earlier request. ".repeat(1000) },
                    ],
                  },
                  {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    parts: [
                      { type: "text", text: "Earlier answer. ".repeat(1000) },
                    ],
                  },
                ]
              : []),
            {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: "Inspect five API paths." }],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(FINAL_TEXT);
      expect(executedSteps).toEqual([1, 2, 3, 4, 5]);
      expect(requests).toHaveLength(contextTrimRetry ? 7 : 6);
      if (contextTrimRetry) {
        expect(JSON.stringify(requests[1].system)).toContain(
          "Earlier context was trimmed",
        );
        expect(JSON.stringify(requests[1].messages)).not.toContain(
          "Earlier request.",
        );
      }

      for (const [requestIndex, request] of requests.entries()) {
        const step = Math.max(requestIndex - Number(contextTrimRetry), 0);
        const requestBlocks = anthropicRequestBlocks(request);
        const markers = requestBlocks.filter((block) => block.cache_control);
        expectLongerTtlFirst({ request, label: `request ${requestIndex + 1}` });
        const toolResults = requestBlocks.filter(
          (block) => block.type === "tool_result",
        );
        expect(toolResults).toHaveLength(step);
        if (step > 0) {
          expect(toolResults[0].content).toBe(LARGE_SPEC);
          expect(toolResults.at(-1)?.tool_use_id).toBe(`tool_${step}`);
          if (anthropicNativeEndpoint) {
            expect(
              toolResults.at(-1)?.cache_control,
              `request ${step + 1} must cache the latest tool result`,
            ).toMatchObject({ type: "ephemeral" });
          }
        }
        if (!anthropicNativeEndpoint) {
          expect(markers).toHaveLength(0);
        }
      }

      await expect
        .poll(async () =>
          (await MessageModel.findByConversation(conversation.id)).some(
            (message) => JSON.stringify(message.content).includes(FINAL_TEXT),
          ),
        )
        .toBe(true);
      const history = await MessageModel.findByConversation(conversation.id);
      expect(JSON.stringify(history)).not.toContain("cacheControl");
      expect(JSON.stringify(history)).not.toContain("cache_control");
    });
  });
});

const UPSTREAM_BASE_URL = "https://anthropic.test/v1";
const FINAL_TEXT = "All five API paths have been inspected.";
const LARGE_SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Synthetic API", version: "1.0.0" },
  paths: Object.fromEntries(
    Array.from({ length: 400 }, (_, index) => [
      `/resources/${index}`,
      {
        get: {
          description: `Inspect synthetic resource ${index}`,
          responses: { "200": { description: "A synthetic resource" } },
        },
      },
    ]),
  ),
});

function anthropicResponse(completedSteps: number): Response {
  const nextStep = completedSteps + 1;
  return anthropicStreamResponse({
    model: "claude-opus-4-6",
    block:
      completedSteps === 5
        ? { type: "text", text: FINAL_TEXT }
        : {
            type: "tool_use",
            id: `tool_${nextStep}`,
            name: "inspect_api",
            input: { step: nextStep },
          },
  });
}
