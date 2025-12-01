import { describe, expect, test } from "@/test";
import InteractionModel from "./interaction";

describe("Interaction Storage Format", () => {
  test("OpenAI request with tool messages stores content correctly", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const openAiRequest = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "Hello" },
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function" as const,
              function: {
                name: "get_weather",
                arguments: '{"location": "London"}',
              },
            },
          ],
          refusal: null,
        },
        {
          role: "tool" as const,
          tool_call_id: "call_123",
          content: '{"temperature": 20, "condition": "sunny"}',
        },
      ],
    };

    const interaction = await InteractionModel.create({
      agentId: agent.id,
      type: "openai:chatCompletions",
      request: openAiRequest,
      response: {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now() / 1000,
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Test", refusal: null },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
    });

    const retrieved = await InteractionModel.findById(interaction.id);

    // Check that tool message content is stored as string (not double-stringified)
    const toolMessage = retrieved?.request.messages[2];
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.role).toBe("tool");
    expect(typeof toolMessage?.content).toBe("string");
    expect(toolMessage?.content).toBe('{"temperature": 20, "condition": "sunny"}');

    // Verify it's a parseable JSON string
    const parsedContent = JSON.parse(toolMessage?.content as string);
    expect(parsedContent).toEqual({ temperature: 20, condition: "sunny" });
  });

  test("Anthropic request with tool results stores content correctly", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const anthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        { role: "user" as const, content: "Hello" },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "toolu_123",
              name: "get_weather",
              input: { location: "London" },
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "toolu_123",
              content: '{"temperature": 20, "condition": "sunny"}',
            },
          ],
        },
      ],
    };

    const interaction = await InteractionModel.create({
      agentId: agent.id,
      type: "anthropic:messages",
      request: anthropicRequest,
      response: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Test", citations: null }],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    const retrieved = await InteractionModel.findById(interaction.id);

    // Check that tool result content is stored as string (not double-stringified)
    const userMessage = retrieved?.request.messages[2];
    expect(userMessage).toBeDefined();
    expect(userMessage?.role).toBe("user");
    expect(Array.isArray(userMessage?.content)).toBe(true);

    const toolResult = (userMessage?.content as Array<any>)[0];
    expect(toolResult.type).toBe("tool_result");
    expect(typeof toolResult.content).toBe("string");
    expect(toolResult.content).toBe('{"temperature": 20, "condition": "sunny"}');

    // Verify it's a parseable JSON string
    const parsedContent = JSON.parse(toolResult.content);
    expect(parsedContent).toEqual({ temperature: 20, condition: "sunny" });
  });

  test("comparing OpenAI and Anthropic storage formats", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    // Both should store tool results as JSON strings
    const toolResultData = { temperature: 20, condition: "sunny" };
    const toolResultString = JSON.stringify(toolResultData);

    // OpenAI
    const openAiInteraction = await InteractionModel.create({
      agentId: agent.id,
      type: "openai:chatCompletions",
      request: {
        model: "gpt-4",
        messages: [
          { role: "user" as const, content: "Hello" },
          {
            role: "tool" as const,
            tool_call_id: "call_123",
            content: toolResultString,
          },
        ],
      },
      response: {
        id: "test",
        object: "chat.completion",
        created: Date.now() / 1000,
        model: "gpt-4",
        choices: [],
      },
    });

    // Anthropic
    const anthropicInteraction = await InteractionModel.create({
      agentId: agent.id,
      type: "anthropic:messages",
      request: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          { role: "user" as const, content: "Hello" },
          {
            role: "user" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: "toolu_123",
                content: toolResultString,
              },
            ],
          },
        ],
      },
      response: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    const openAiRetrieved = await InteractionModel.findById(openAiInteraction.id);
    const anthropicRetrieved = await InteractionModel.findById(anthropicInteraction.id);

    // Get the tool result content from each
    const openAiToolContent = openAiRetrieved?.request.messages[1].content;
    const anthropicToolContent = (anthropicRetrieved?.request.messages[1].content as Array<any>)[0].content;

    console.log("OpenAI tool content type:", typeof openAiToolContent);
    console.log("OpenAI tool content value:", openAiToolContent);
    console.log("Anthropic tool content type:", typeof anthropicToolContent);
    console.log("Anthropic tool content value:", anthropicToolContent);

    // Both should be identical JSON strings
    expect(typeof openAiToolContent).toBe("string");
    expect(typeof anthropicToolContent).toBe("string");
    expect(openAiToolContent).toBe(toolResultString);
    expect(anthropicToolContent).toBe(toolResultString);

    // Both should parse to the same object
    expect(JSON.parse(openAiToolContent as string)).toEqual(toolResultData);
    expect(JSON.parse(anthropicToolContent as string)).toEqual(toolResultData);
  });
});
