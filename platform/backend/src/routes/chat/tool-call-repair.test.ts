import { InvalidToolInputError } from "ai";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { createDirectLLMModel } from "@/clients/llm-client";
import { useMswServer } from "@/test/msw";
import { createToolCallRepair } from "./tool-call-repair";

describe("tool-call repair provider compatibility", () => {
  const server = useMswServer();

  test.each([
    "claude-sonnet-5",
    "claude-sonnet-4-5",
  ])("repairs malformed arguments with the real %s client", async (modelName) => {
    let requests = 0;
    let thinking: unknown;
    server.use(
      http.post(
        "https://repair.example.com/v1/messages",
        async ({ request }) => {
          requests++;
          const body = (await request.json()) as Record<string, unknown>;
          thinking = body.thinking;
          if (
            thinking &&
            body.temperature !== undefined &&
            body.temperature !== 1
          ) {
            return HttpResponse.json(
              {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message:
                    "Unsupported sampling setting for a reasoning request",
                },
              },
              { status: 400 },
            );
          }
          const object = { query: "synthetic search" };
          const tools = body.tools as { name: string }[] | undefined;
          return HttpResponse.json({
            id: "msg_repair",
            type: "message",
            role: "assistant",
            model: modelName,
            content: tools?.length
              ? [
                  {
                    type: "tool_use",
                    id: "repair_result",
                    name: tools[0].name,
                    input: object,
                  },
                ]
              : [{ type: "text", text: JSON.stringify(object) }],
            stop_reason: tools?.length ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
          });
        },
      ),
    );
    const input = '{"query">"synthetic search"}';
    const repair = createToolCallRepair({
      toolNames: ["search"],
      logContext: {},
      createRepairModel: async () =>
        createDirectLLMModel({
          provider: "anthropic",
          apiKey: "synthetic-key",
          modelName,
          baseUrl: "https://repair.example.com",
        }),
    });
    const repaired = await repair({
      toolCall: {
        type: "tool-call",
        toolCallId: "call_search",
        toolName: "search",
        input,
      },
      error: new InvalidToolInputError({
        toolName: "search",
        toolInput: input,
        cause: new SyntaxError("Malformed synthetic input"),
      }),
      inputSchema: async () => ({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      }),
      tools: {},
      messages: [],
      system: undefined,
    });

    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired?.input ?? "")).toEqual({
      query: "synthetic search",
    });
    expect(repaired?.toolCallId).toBe("call_search");
    expect(requests).toBe(1);
    expect(thinking).toEqual(
      modelName === "claude-sonnet-5"
        ? { type: "adaptive", display: "summarized" }
        : undefined,
    );
  });
});
