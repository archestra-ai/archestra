import { describe, expect, test } from "vitest";
import { MessagesRequestSchema, MessagesResponseSchema } from "./api";

function roundTrip(value: unknown) {
  return JSON.parse(JSON.stringify(MessagesRequestSchema.parse(value)));
}

describe("MessagesRequestSchema", () => {
  // Fastify replaces request.body with the Zod parse result, so any thinking
  // field this schema drops never reaches the upstream provider, and any value
  // it rejects fails the whole request with a 400. `display` is what turns
  // thinking text on in responses: the chat client injects it for models that
  // think by default, and external proxy clients may send it themselves.
  test.each([
    { type: "adaptive" },
    { type: "adaptive", display: "summarized" },
    { type: "enabled", budget_tokens: 2048, display: "omitted" },
    // Claude Code sends this on interactive requests.
    { type: "adaptive", display: "updates" },
    {
      type: "enabled",
      budget_tokens: 2048,
      display: "updates",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
    { type: "between_tools" },
    { type: "adaptive", display: "summarized", option_from_a_future_beta: 1 },
    { type: "mode_from_a_future_beta", option_from_a_future_beta: 1 },
  ])("keeps thinking config %j through body validation", (thinking) => {
    const parsed = MessagesRequestSchema.parse({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      thinking,
    });

    expect(parsed.thinking).toEqual(thinking);
  });

  test("accepts Claude Code custom tools without a type", () => {
    const parsed = MessagesRequestSchema.parse({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    expect(parsed.tools?.[0]).toMatchObject({ name: "Read" });
  });

  test("keeps top-level and block cache markers and strips unsupported fields", () => {
    const topLevel = { type: "ephemeral", ttl: "1h" };
    const systemMarker = { type: "ephemeral", ttl: "5m" };
    const messageMarker = { type: "ephemeral", ttl: "1h" };
    const parsed = roundTrip({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      cache_control: topLevel,
      not_a_supported_field: "drop-me",
      system: [{ type: "text", text: "sys", cache_control: systemMarker }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: messageMarker }],
        },
      ],
    });

    expect(parsed.cache_control).toEqual(topLevel);
    expect(parsed.system[0].cache_control).toEqual(systemMarker);
    expect(parsed.messages[0].content[0].cache_control).toEqual(messageMarker);
    expect(parsed).not.toHaveProperty("not_a_supported_field");
  });

  test("forwards Anthropic tool types the schema does not enumerate", () => {
    // Fastify replaces request.body with the Zod parse result. A closed
    // discriminatedUnion on tools[].type 400s the whole Claude Code request
    // (`body/tools/N/type Invalid input`) before the proxy or OpenAPPA runs.
    const searchTool = {
      name: "tool_search_tool_bm25",
      type: "tool_search_tool_bm25_20251119",
      cache_control: { type: "ephemeral" },
    };
    const mcpToolset = {
      type: "mcp_toolset",
      mcp_server_name: "my_gateway",
    };
    const parsed = MessagesRequestSchema.parse({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
      tools: [
        {
          name: "Read",
          input_schema: { type: "object", properties: {} },
        },
        { type: "bash_20250124", name: "bash" },
        searchTool,
        mcpToolset,
      ],
    });

    expect(parsed.tools).toEqual([
      {
        name: "Read",
        input_schema: { type: "object", properties: {} },
      },
      { type: "bash_20250124", name: "bash" },
      searchTool,
      mcpToolset,
    ]);
  });
});

describe("MessagesResponseSchema", () => {
  test("accepts a response that omits stop_sequence", () => {
    const result = MessagesResponseSchema.safeParse({
      id: "msg_1",
      content: [{ type: "text", text: "hi", citations: null }],
      model: "claude-sonnet-4-5",
      role: "assistant",
      stop_reason: "end_turn",
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(result.success).toBe(true);
  });
});
