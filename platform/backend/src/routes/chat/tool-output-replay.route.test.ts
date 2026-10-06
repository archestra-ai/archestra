import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, tool } from "ai";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { mcpToolToModelOutput } from "@/clients/chat-tool-builder";
import MessageModel from "@/models/message";
import ModelModel from "@/models/model";
import {
  captureRewriteRequest,
  RewriteProjectionError,
} from "@/openappa/rewrite-projection";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import chatRoutes from "./routes";

const mockCreateLLMModelForAgent = vi.hoisted(() => vi.fn());
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

const UPSTREAM = "https://chat-replay.test/v1";
const FINAL_TEXT = "The synthetic results are complete.";
const TOOL_NAMES = ["rich_result", "control_result", "json_result"];
type WireRequest = {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

describe("POST /api/chat tool-output replay", () => {
  const server = useMswServer();
  const ctx = useRouteTestApp(chatRoutes);

  test("replays persisted MCP and control outputs with their live model bytes", async ({
    makeAgent,
    makeConversation,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const model = await ModelModel.create({
      externalId: "openai/gpt-4o-mini",
      provider: "openai",
      modelId: "gpt-4o-mini",
      supportsToolCalling: true,
      contextLength: 128000,
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
      model: createOpenAI({ apiKey: "test-key", baseURL: UPSTREAM }).chat(
        model.modelId,
      ),
      provider: "openai",
      apiKeySource: "org",
    });

    const richOutput = {
      content: '  Synthetic record.\nKeep whitespace and {"quoted":true}.\n',
      _meta: { display: "UI attribution only" },
      rawContent: [{ type: "text", text: "UI copy of the record" }],
    };
    const controlOutput = {
      content: "Synthetic control acknowledgement.\n",
      _meta: { display: "UI control status only" },
    };
    const jsonOutput = '{"content":"Actual JSON data","retain":[1,2]}';
    const executed: string[] = [];
    const inputSchema = jsonSchema({ type: "object", properties: {} });
    mockGetChatMcpTools.mockResolvedValue({
      rich_result: tool({
        inputSchema,
        execute: async () => {
          executed.push("rich_result");
          return richOutput;
        },
        toModelOutput: ({ output }) => mcpToolToModelOutput({ output }),
      }),
      control_result: tool({
        inputSchema,
        execute: async () => {
          executed.push("control_result");
          return controlOutput;
        },
        toModelOutput: ({ output }) => mcpToolToModelOutput({ output }),
      }),
      // A real JSON result without an MCP converter must not be unwrapped.
      json_result: tool({
        inputSchema,
        execute: async () => {
          executed.push("json_result");
          return jsonOutput;
        },
      }),
    });

    const requests: WireRequest[] = [];
    server.use(
      http.post(`${UPSTREAM}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as WireRequest;
        requests.push(body);
        const completed = body.messages.filter((m) => m.role === "tool").length;
        return completionStream(completed);
      }),
    );
    const send = (messages: unknown[]) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/chat",
        payload: { id: conversation.id, trigger: "submit-message", messages },
      });
    const userMessage = (text: string) => ({
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }],
    });

    const first = await send([userMessage("Read the synthetic results.")]);
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain(FINAL_TEXT);
    expect(requests).toHaveLength(4);
    const live = requests[3];
    expect(
      live.messages.filter((m) => m.role === "tool").map((m) => m.content),
    ).toEqual([richOutput.content, controlOutput.content, jsonOutput]);

    await expect
      .poll(async () =>
        (await MessageModel.findByConversation(conversation.id)).some(
          (message) => JSON.stringify(message.content).includes(FINAL_TEXT),
        ),
      )
      .toBe(true);
    const history = (
      await MessageModel.findByConversation(conversation.id)
    ).map((message) => message.content);
    expect(JSON.stringify(history)).toContain("UI attribution only");
    expect(JSON.stringify(history)).toContain("rawContent");

    const second = await send([...history, userMessage("Repeat the answer.")]);
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain(FINAL_TEXT);
    expect(requests).toHaveLength(5);
    expect(executed).toEqual(TOOL_NAMES);

    // Use the real exact-replay boundary, not a permissive result-text matcher.
    const liveBody = structuredClone(live);
    expect(requests[4].messages.slice(0, live.messages.length)).toEqual(
      live.messages,
    );
    const capture = captureRewriteRequest(liveBody, "openai:chatCompletions");
    const initial = capture.project(liveBody, new Map(), {
      allowInitial: true,
    });
    const replayBody = structuredClone(requests[4]);
    const replay = captureRewriteRequest(
      replayBody,
      "openai:chatCompletions",
    ).project(
      replayBody,
      new Map(initial.records.map((record) => [record.key, record])),
      { heads: initial.heads },
    ).request as WireRequest;
    expect(replay.messages.slice(0, live.messages.length)).toEqual(
      live.messages,
    );
    const changedBody = structuredClone(requests[4]);
    const changedResult = changedBody.messages.find(
      (m) => m.tool_call_id === "call_1",
    );
    if (!changedResult) throw new Error("Missing synthetic control result");
    changedResult.content = "Changed acknowledgement";
    const changedCapture = captureRewriteRequest(
      changedBody,
      "openai:chatCompletions",
    );
    expect(() =>
      changedCapture.project(
        changedBody,
        new Map(initial.records.map((record) => [record.key, record])),
        { heads: initial.heads },
      ),
    ).toThrow(RewriteProjectionError);
  });
});

function completionStream(completed: number): Response {
  const nextTool = TOOL_NAMES[completed];
  const base = {
    id: `chatcmpl-${completed}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini",
  };
  const chunks = [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: nextTool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${completed}`,
                    type: "function",
                    function: { name: nextTool, arguments: "{}" },
                  },
                ],
              }
            : { role: "assistant", content: FINAL_TEXT },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: nextTool ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    },
  ];
  return new HttpResponse(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}
