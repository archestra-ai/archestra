import { describe, expect, test } from "@/test";
import { AnthropicTransformer } from "./transformer";

describe("AnthropicTransformer", () => {
  const transformer = new AnthropicTransformer();

  // ========== PROVIDER IDENTIFICATION ==========
  describe("provider", () => {
    test("returns anthropic as provider name", () => {
      expect(transformer.provider).toBe("anthropic");
    });
  });

  describe("requestToOpenAI", () => {
    test("converts basic Anthropic request to OpenAI format", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user" as const, content: "Hello, Claude!" }],
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      expect(result.model).toBe("claude-3-5-sonnet-20241022");
      expect(result.max_tokens).toBe(1024);
      expect(result.messages).toEqual([
        { role: "user", content: "Hello, Claude!" },
      ]);
    });

    test("converts system param to system message", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: "You are a helpful assistant.",
        messages: [{ role: "user" as const, content: "Hello!" }],
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      expect(result.messages[0]).toEqual({
        role: "system",
        content: "You are a helpful assistant.",
      });
      expect(result.messages[1]).toEqual({
        role: "user",
        content: "Hello!",
      });
    });

    test("converts system array to system message", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        system: [
          { type: "text" as const, text: "First system part." },
          { type: "text" as const, text: "Second system part." },
        ],
        messages: [{ role: "user" as const, content: "Hello!" }],
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      expect(result.messages[0]).toEqual({
        role: "system",
        content: "First system part.\nSecond system part.",
      });
    });

    test("converts tool_result blocks to tool messages", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          {
            role: "assistant" as const,
            content: [
              {
                type: "tool_use" as const,
                id: "tool_123",
                name: "get_weather",
                input: { city: "London" },
              },
            ],
          },
          {
            role: "user" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: "tool_123",
                content: '{"temp": 15, "conditions": "cloudy"}',
              },
            ],
          },
        ],
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      // First message should be assistant with tool_calls
      const assistantMsg = result.messages[0];
      expect(assistantMsg.role).toBe("assistant");
      if (assistantMsg.role === "assistant" && "tool_calls" in assistantMsg) {
        expect(assistantMsg.tool_calls).toEqual([
          {
            id: "tool_123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"London"}',
            },
          },
        ]);
      }

      // Second message should be tool message
      const toolMsg = result.messages[1];
      expect(toolMsg.role).toBe("tool");
      if (toolMsg.role === "tool" && "tool_call_id" in toolMsg) {
        expect(toolMsg.tool_call_id).toBe("tool_123");
      }
      expect(toolMsg.content).toBe('{"temp": 15, "conditions": "cloudy"}');
    });

    test("converts Anthropic tools to OpenAI function tools", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user" as const, content: "Get the weather" }],
        tools: [
          {
            name: "get_weather",
            description: "Get the current weather",
            input_schema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          },
        ],
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      expect(result.tools).toEqual([
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          },
        },
      ]);
    });

    test("converts tool_choice: any to required", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user" as const, content: "Hello" }],
        tool_choice: { type: "any" as const },
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      expect(result.tool_choice).toBe("required");
    });

    test("converts tool_choice: tool to function specification", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user" as const, content: "Hello" }],
        tool_choice: { type: "tool" as const, name: "get_weather" },
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      expect(result.tool_choice).toEqual({
        type: "function",
        function: { name: "get_weather" },
      });
    });
  });

  describe("requestFromOpenAI", () => {
    test("converts basic OpenAI request to Anthropic format", () => {
      const openaiReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user" as const, content: "Hello, Claude!" }],
      };

      const result = transformer.requestFromOpenAI(openaiReq);

      expect(result.model).toBe("claude-3-5-sonnet-20241022");
      expect(result.max_tokens).toBe(1024);
      expect(result.messages).toEqual([
        { role: "user", content: "Hello, Claude!" },
      ]);
    });

    test("extracts system messages to system param", () => {
      const openaiReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          { role: "system" as const, content: "You are a helpful assistant." },
          { role: "user" as const, content: "Hello!" },
        ],
      };

      const result = transformer.requestFromOpenAI(openaiReq);

      expect(result.system).toBe("You are a helpful assistant.");
      expect(result.messages).toEqual([{ role: "user", content: "Hello!" }]);
    });

    test("converts tool messages to tool_result blocks", () => {
      const openaiReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          {
            role: "assistant" as const,
            content: null,
            tool_calls: [
              {
                id: "tool_123",
                type: "function" as const,
                function: {
                  name: "get_weather",
                  arguments: '{"city":"London"}',
                },
              },
            ],
          },
          {
            role: "tool" as const,
            tool_call_id: "tool_123",
            content: '{"temp": 15}',
          },
        ],
      };

      const result = transformer.requestFromOpenAI(openaiReq);

      // Assistant message should have tool_use blocks
      expect(result.messages[0]).toEqual({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_123",
            name: "get_weather",
            input: { city: "London" },
          },
        ],
      });

      // Tool result should be in user message
      expect(result.messages[1]).toEqual({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_123",
            content: '{"temp": 15}',
          },
        ],
      });
    });

    test("converts OpenAI tools to Anthropic custom tools", () => {
      const openaiReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user" as const, content: "Get the weather" }],
        tools: [
          {
            type: "function" as const,
            function: {
              name: "get_weather",
              description: "Get the current weather",
              parameters: {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
              },
            },
          },
        ],
      };

      const result = transformer.requestFromOpenAI(openaiReq);

      expect(result.tools).toEqual([
        {
          name: "get_weather",
          description: "Get the current weather",
          input_schema: {
            type: "object",
            properties: {
              city: { type: "string" },
            },
          },
        },
      ]);
    });

    test("converts tool_choice: required to any", () => {
      const openaiReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user" as const, content: "Hello" }],
        tool_choice: "required" as const,
      };

      const result = transformer.requestFromOpenAI(openaiReq);

      expect(result.tool_choice).toEqual({ type: "any" });
    });

    test("defaults max_tokens to 4096 if not provided", () => {
      const openaiReq = {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user" as const, content: "Hello!" }],
      };

      const result = transformer.requestFromOpenAI(openaiReq);

      expect(result.max_tokens).toBe(4096);
    });
  });

  describe("responseToOpenAI", () => {
    test("converts text response to OpenAI format", () => {
      const anthropicResp = {
        id: "msg_123",
        type: "message" as const,
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: "Hello! How can I help you?",
            citations: null,
          },
        ],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "end_turn" as const,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      };

      const result = transformer.responseToOpenAI(anthropicResp);

      expect(result.id).toBe("msg_123");
      expect(result.object).toBe("chat.completion");
      expect(result.model).toBe("claude-3-5-sonnet-20241022");
      expect(result.choices[0].message.role).toBe("assistant");
      expect(result.choices[0].message.content).toBe(
        "Hello! How can I help you?",
      );
      expect(result.choices[0].finish_reason).toBe("stop");
      expect(result.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      });
    });

    test("converts tool_use response to OpenAI format", () => {
      const anthropicResp = {
        id: "msg_456",
        type: "message" as const,
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "tool_789",
            name: "get_weather",
            input: { city: "London" },
          },
        ],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "tool_use" as const,
        stop_sequence: null,
        usage: {
          input_tokens: 15,
          output_tokens: 25,
        },
      };

      const result = transformer.responseToOpenAI(anthropicResp);

      expect(result.choices[0].message.tool_calls).toEqual([
        {
          id: "tool_789",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"city":"London"}',
          },
        },
      ]);
      expect(result.choices[0].finish_reason).toBe("tool_calls");
    });

    test("handles mixed text and tool_use content", () => {
      const anthropicResp = {
        id: "msg_mixed",
        type: "message" as const,
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: "Let me check the weather.",
            citations: null,
          },
          {
            type: "tool_use" as const,
            id: "tool_weather",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "tool_use" as const,
        stop_sequence: null,
        usage: {
          input_tokens: 20,
          output_tokens: 30,
        },
      };

      const result = transformer.responseToOpenAI(anthropicResp);

      expect(result.choices[0].message.content).toBe(
        "Let me check the weather.",
      );
      expect(result.choices[0].message.tool_calls).toHaveLength(1);
      const toolCall = result.choices[0].message.tool_calls?.[0];
      if (toolCall && toolCall.type === "function") {
        expect(toolCall.function.name).toBe("get_weather");
      }
    });
  });

  describe("responseFromOpenAI", () => {
    test("converts OpenAI text response to Anthropic format", () => {
      const openaiResp = {
        id: "chatcmpl-123",
        object: "chat.completion" as const,
        created: 1234567890,
        model: "claude-3-5-sonnet-20241022",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant" as const,
              content: "Hello! How can I help you?",
            },
            finish_reason: "stop" as const,
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      };

      const result = transformer.responseFromOpenAI(openaiResp);

      expect(result.id).toBe("chatcmpl-123");
      expect(result.type).toBe("message");
      expect(result.role).toBe("assistant");
      expect(result.content).toEqual([
        { type: "text", text: "Hello! How can I help you?", citations: null },
      ]);
      expect(result.stop_reason).toBe("end_turn");
      expect(result.usage).toEqual({
        input_tokens: 10,
        output_tokens: 20,
      });
    });

    test("converts OpenAI tool_calls response to Anthropic format", () => {
      const openaiResp = {
        id: "chatcmpl-456",
        object: "chat.completion" as const,
        created: 1234567890,
        model: "claude-3-5-sonnet-20241022",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant" as const,
              content: null,
              tool_calls: [
                {
                  id: "call_789",
                  type: "function" as const,
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"London"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls" as const,
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40,
        },
      };

      const result = transformer.responseFromOpenAI(openaiResp);

      expect(result.content).toEqual([
        {
          type: "tool_use",
          id: "call_789",
          name: "get_weather",
          input: { city: "London" },
        },
      ]);
      expect(result.stop_reason).toBe("tool_use");
    });
  });

  describe("round-trip transformations", () => {
    test("requestToOpenAI → requestFromOpenAI preserves essential data", () => {
      const originalRequest = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 2048,
        system: "Be helpful.",
        messages: [
          { role: "user" as const, content: "Hello!" },
          {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "Hi there!" }],
          },
          { role: "user" as const, content: "How are you?" },
        ],
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "auto" as const },
        temperature: 0.7,
      };

      const normalized = transformer.requestToOpenAI(originalRequest);
      const transformed = transformer.requestFromOpenAI(normalized);

      expect(transformed.model).toBe(originalRequest.model);
      expect(transformed.max_tokens).toBe(originalRequest.max_tokens);
      expect(transformed.system).toBe(originalRequest.system);
      expect(transformed.temperature).toBe(originalRequest.temperature);
      expect(transformed.tool_choice).toEqual(originalRequest.tool_choice);
      expect(transformed.tools?.[0]?.name).toBe("test_tool");
    });

    test("responseToOpenAI → responseFromOpenAI preserves essential data", () => {
      const originalResponse = {
        id: "msg_roundtrip",
        type: "message" as const,
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "Round trip test!", citations: null },
        ],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "end_turn" as const,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
      };

      const transformed = transformer.responseToOpenAI(originalResponse);
      const denormalized = transformer.responseFromOpenAI(transformed);

      expect(denormalized.id).toBe(originalResponse.id);
      expect(denormalized.model).toBe(originalResponse.model);
      expect(denormalized.stop_reason).toBe(originalResponse.stop_reason);
      expect(denormalized.usage.input_tokens).toBe(
        originalResponse.usage.input_tokens,
      );
      expect(denormalized.usage.output_tokens).toBe(
        originalResponse.usage.output_tokens,
      );
      expect(denormalized.content[0]).toEqual(originalResponse.content[0]);
    });
  });

  // ========== TOOL CHOICE MAPPING ==========
  describe("tool_choice mapping", () => {
    describe("normalizeToolChoice (Anthropic → OpenAI)", () => {
      test("converts auto tool_choice", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          tool_choice: { type: "auto" as const },
        };
        const result = transformer.requestToOpenAI(anthropicReq);
        expect(result.tool_choice).toBe("auto");
      });

      test("converts any tool_choice to required", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          tool_choice: { type: "any" as const },
        };
        const result = transformer.requestToOpenAI(anthropicReq);
        expect(result.tool_choice).toBe("required");
      });

      test("converts none tool_choice", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          tool_choice: { type: "none" as const },
        };
        const result = transformer.requestToOpenAI(anthropicReq);
        expect(result.tool_choice).toBe("none");
      });

      test("converts specific tool choice", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          tool_choice: { type: "tool" as const, name: "get_weather" },
        };
        const result = transformer.requestToOpenAI(anthropicReq);
        expect(result.tool_choice).toEqual({
          type: "function",
          function: { name: "get_weather" },
        });
      });

      test("returns undefined when tool_choice is not provided", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
        };

        const result = transformer.requestToOpenAI(anthropicReq);
        expect(result.tool_choice).toBeUndefined();
      });
    });

    describe("transformToolChoice (OpenAI → Anthropic)", () => {
      test.each([
        ["auto", { type: "auto" }],
        ["required", { type: "any" }],
        ["none", { type: "none" }],
        [
          { type: "function", function: { name: "my_tool" } },
          { type: "tool", name: "my_tool" },
        ],
      ])("converts OpenAI tool_choice %j to Anthropic %j", (openaiChoice, expectedAnthropic) => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          tool_choice: openaiChoice as
            | "auto"
            | "required"
            | "none"
            | { type: "function"; function: { name: string } },
        };

        const result = transformer.requestFromOpenAI(openaiReq);
        expect(result.tool_choice).toEqual(expectedAnthropic);
      });
    });
  });

  // ========== STOP REASON MAPPING ==========
  describe("stop_reason mapping", () => {
    test.each([
      ["end_turn", "stop"],
      ["tool_use", "tool_calls"],
      ["max_tokens", "length"],
      [null, null],
    ])("maps Anthropic stop_reason %s to OpenAI finish_reason %s", (anthropicReason, expectedOpenAI) => {
      const anthropicResp = {
        id: "msg_test",
        type: "message" as const,
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Test", citations: null }],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: anthropicReason as
          | "end_turn"
          | "tool_use"
          | "max_tokens"
          | null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const result = transformer.responseToOpenAI(anthropicResp);
      expect(result.choices[0].finish_reason).toBe(expectedOpenAI);
    });

    test.each([
      ["stop", "end_turn"],
      ["tool_calls", "tool_use"],
      ["length", "max_tokens"],
      [null, null],
    ])("maps OpenAI finish_reason %s to Anthropic stop_reason %s", (openaiReason, expectedAnthropic) => {
      // TODO: ikonstantinov - OpenAI types don't allow null for finish_reason, using 'as any' to test null case
      const openaiResp = {
        id: "chatcmpl-test",
        object: "chat.completion" as const,
        created: 1234567890,
        model: "claude-3-5-sonnet-20241022",
        choices: [
          {
            index: 0,
            message: { role: "assistant" as const, content: "Test" },
            finish_reason: openaiReason as
              | "stop"
              | "tool_calls"
              | "length"
              | null,
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        // biome-ignore lint/suspicious/noExplicitAny: See TODO above
      } as any;

      const result = transformer.responseFromOpenAI(openaiResp);
      expect(result.stop_reason).toBe(expectedAnthropic);
    });
  });

  // ========== USAGE CALCULATION ==========
  describe("usage calculation", () => {
    test("correctly calculates total_tokens from input and output", () => {
      const anthropicResp = {
        id: "msg_usage",
        type: "message" as const,
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Test", citations: null }],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "end_turn" as const,
        stop_sequence: null,
        usage: {
          input_tokens: 150,
          output_tokens: 75,
        },
      };

      const result = transformer.responseToOpenAI(anthropicResp);

      expect(result.usage).toEqual({
        prompt_tokens: 150,
        completion_tokens: 75,
        total_tokens: 225,
      });
    });

    test("handles zero tokens", () => {
      const anthropicResp = {
        id: "msg_zero",
        type: "message" as const,
        role: "assistant" as const,
        content: [],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      };

      const result = transformer.responseToOpenAI(anthropicResp);

      expect(result.usage).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
    });
  });

  // ========== EDGE CASES ==========
  describe("edge cases", () => {
    describe("empty content handling", () => {
      test("handles empty messages array", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [],
        };

        const result = transformer.requestToOpenAI(anthropicReq);
        expect(result.messages).toEqual([]);
      });

      test("handles empty tool_result content", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [
            {
              role: "user" as const,
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "tool_empty",
                  content: "",
                },
              ],
            },
          ],
        };

        const result = transformer.requestToOpenAI(anthropicReq);
        const toolMsg = result.messages[0];
        expect(toolMsg.role).toBe("tool");
        expect(toolMsg.content).toBe("");
      });

      test("handles tool_result with undefined content", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [
            {
              role: "user" as const,
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "tool_undefined",
                  content: undefined,
                },
              ],
            },
          ],
        };

        const result = transformer.requestToOpenAI(anthropicReq);
        const toolMsg = result.messages[0];
        expect(toolMsg.role).toBe("tool");
        expect(toolMsg.content).toBe("");
      });
    });

    describe("tool with no arguments", () => {
      test("handles tool_use with empty input object", () => {
        const anthropicResp = {
          id: "msg_no_args",
          type: "message" as const,
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "tool_no_args",
              name: "get_time",
              input: {},
            },
          ],
          model: "claude-3-5-sonnet-20241022",
          stop_reason: "tool_use" as const,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        };

        const result = transformer.responseToOpenAI(anthropicResp);

        const toolCall = result.choices[0].message.tool_calls?.[0];
        expect(toolCall).toBeDefined();
        if (toolCall && toolCall.type === "function") {
          expect(toolCall.function.arguments).toBe("{}");
        }
      });

      test("OpenAI tool_calls with empty arguments string", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [
            {
              role: "assistant" as const,
              content: null,
              tool_calls: [
                {
                  id: "call_empty",
                  type: "function" as const,
                  function: {
                    name: "get_time",
                    arguments: "{}",
                  },
                },
              ],
            },
          ],
        };

        const result = transformer.requestFromOpenAI(openaiReq);
        const assistantContent = result.messages[0].content;

        expect(Array.isArray(assistantContent)).toBe(true);
        if (Array.isArray(assistantContent)) {
          const toolUse = assistantContent.find((b) => b.type === "tool_use");
          expect(toolUse).toBeDefined();
          if (toolUse && "input" in toolUse) {
            expect(toolUse.input).toEqual({});
          }
        }
      });
    });

    describe("multiple system messages", () => {
      test("combines multiple system messages with double newline", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [
            {
              role: "system" as const,
              content: "You are a helpful assistant.",
            },
            { role: "system" as const, content: "Be concise." },
            { role: "user" as const, content: "Hello!" },
          ],
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.system).toBe(
          "You are a helpful assistant.\n\nBe concise.",
        );
      });
    });

    describe("assistant message with string content", () => {
      test("handles assistant message with simple string content", () => {
        const anthropicReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [
            { role: "user" as const, content: "Hello" },
            { role: "assistant" as const, content: "Hi there!" },
            { role: "user" as const, content: "How are you?" },
          ],
        };

        const result = transformer.requestToOpenAI(anthropicReq);

        const assistantMsg = result.messages[1];
        expect(assistantMsg.role).toBe("assistant");
        expect(assistantMsg.content).toBe("Hi there!");
      });
    });

    describe("stop sequences", () => {
      test("converts string stop to stop_sequences array", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          stop: "END",
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.stop_sequences).toEqual(["END"]);
      });

      test("passes array stop as stop_sequences", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          stop: ["END", "STOP", "DONE"],
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.stop_sequences).toEqual(["END", "STOP", "DONE"]);
      });

      test("handles undefined stop", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.stop_sequences).toBeUndefined();
      });
    });

    describe("temperature and top_p", () => {
      test("preserves temperature when provided", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          temperature: 0.5,
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.temperature).toBe(0.5);
      });

      test("preserves top_p when provided", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          top_p: 0.9,
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.top_p).toBe(0.9);
      });

      test("handles temperature 0", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          temperature: 0,
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.temperature).toBe(0);
      });
    });

    describe("streaming flag", () => {
      test("preserves stream: true", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          stream: true,
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.stream).toBe(true);
      });

      test("preserves stream: false", () => {
        const openaiReq = {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 1024,
          messages: [{ role: "user" as const, content: "Hello" }],
          stream: false,
        };

        const result = transformer.requestFromOpenAI(openaiReq);

        expect(result.stream).toBe(false);
      });
    });
  });

  // ========== MULTIPLE TOOL CALLS ==========
  describe("multiple tool calls", () => {
    test("handles multiple tool_use blocks in response", () => {
      const anthropicResp = {
        id: "msg_multi_tools",
        type: "message" as const,
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: "I'll check both locations.",
            citations: null,
          },
          {
            type: "tool_use" as const,
            id: "tool_1",
            name: "get_weather",
            input: { city: "London" },
          },
          {
            type: "tool_use" as const,
            id: "tool_2",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
        model: "claude-3-5-sonnet-20241022",
        stop_reason: "tool_use" as const,
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 100 },
      };

      const result = transformer.responseToOpenAI(anthropicResp);

      expect(result.choices[0].message.tool_calls).toHaveLength(2);
      expect(result.choices[0].message.tool_calls?.[0].id).toBe("tool_1");
      expect(result.choices[0].message.tool_calls?.[1].id).toBe("tool_2");
      expect(result.choices[0].message.content).toBe(
        "I'll check both locations.",
      );
    });

    test("handles multiple tool_result blocks in user message", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: "tool_1",
                content: '{"temp": 15}',
              },
              {
                type: "tool_result" as const,
                tool_use_id: "tool_2",
                content: '{"temp": 22}',
              },
            ],
          },
        ],
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      // Should produce two separate tool messages
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("tool");
      expect(result.messages[1].role).toBe("tool");

      if (result.messages[0].role === "tool") {
        expect(
          (result.messages[0] as { tool_call_id: string }).tool_call_id,
        ).toBe("tool_1");
      }
      if (result.messages[1].role === "tool") {
        expect(
          (result.messages[1] as { tool_call_id: string }).tool_call_id,
        ).toBe("tool_2");
      }
    });
  });

  // ========== TOOL_RESULT WITH TEXT CONTENT ==========
  describe("mixed tool_result and text content", () => {
    test("handles user message with both tool_result and text", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: "tool_123",
                content: '{"result": "success"}',
              },
              {
                type: "text" as const,
                text: "Please analyze this result.",
              },
            ],
          },
        ],
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      // Should produce tool message followed by user message
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("tool");
      expect(result.messages[1].role).toBe("user");
      expect(result.messages[1].content).toBe("Please analyze this result.");
    });
  });

  // ========== CONTENT BLOCK ARRAY IN TOOL RESULT ==========
  describe("tool_result content formats", () => {
    test("handles tool_result with array content blocks", () => {
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "tool_result" as const,
                tool_use_id: "tool_blocks",
                content: [
                  { type: "text" as const, text: "First part." },
                  { type: "text" as const, text: "Second part." },
                ],
              },
            ],
          },
        ],
      };

      const result = transformer.requestToOpenAI(anthropicReq);

      expect(result.messages[0].role).toBe("tool");
      expect(result.messages[0].content).toBe("First part.\nSecond part.");
    });
  });

  // ========== FILTERS NON-CUSTOM TOOLS ==========
  describe("tool type filtering", () => {
    test("filters out non-custom tools from Anthropic request", () => {
      // Use unknown to bypass strict typing for this edge case test
      const anthropicReq = {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1024,
        messages: [{ role: "user" as const, content: "Hello" }],
        tools: [
          {
            name: "custom_tool",
            description: "A custom tool",
            input_schema: { type: "object", properties: {} },
          },
          {
            type: "computer_20241022",
            name: "computer",
            display_width_px: 1024,
            display_height_px: 768,
          },
        ],
      } as unknown as Parameters<typeof transformer.requestToOpenAI>[0];

      const result = transformer.requestToOpenAI(anthropicReq);

      // Should only include the custom tool
      expect(result.tools).toHaveLength(1);
      const tool = result.tools?.[0];
      expect(tool?.type).toBe("function");
      if (tool?.type === "function") {
        expect(tool.function.name).toBe("custom_tool");
      }
    });
  });

  // ========== STREAMING CHUNK CONVERSION ==========
  describe("streaming chunk conversion", () => {
    // Helper to create message_start event with minimal required fields
    // biome-ignore lint/suspicious/noExplicitAny: Test helper with SDK type casting
    const createMessageStartEvent = (overrides: Record<string, any> = {}) =>
      ({
        type: "message_start",
        message: {
          id: "msg_123",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-3-5-sonnet-20241022",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
          ...overrides,
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK types require many optional fields
      }) as any;

    test("createStreamTransformer returns a new transformer instance", () => {
      const converter = transformer.createStreamTransformer();
      expect(converter).toBeDefined();
      expect(typeof converter.toOpenAI).toBe("function");
      expect(typeof converter.writeFromOpenAI).toBe("function");
      expect(typeof converter.isToolChunk).toBe("function");
    });

    test("converts message_start event to initial OpenAI chunk", () => {
      const converter = transformer.createStreamTransformer();
      const event = createMessageStartEvent();

      const result = converter.toOpenAI(event);

      expect(result).not.toBeNull();
      expect(result?.object).toBe("chat.completion.chunk");
      expect(result?.model).toBe("claude-3-5-sonnet-20241022");
      expect(result?.choices[0].delta.role).toBe("assistant");
      expect(result?.usage?.prompt_tokens).toBe(10);
    });

    test("converts text_delta to content chunk", () => {
      const converter = transformer.createStreamTransformer();

      // First emit message_start to initialize model
      converter.toOpenAI(createMessageStartEvent());

      // Then content block start
      converter.toOpenAI({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
        // biome-ignore lint/suspicious/noExplicitAny: SDK types require many optional fields
      } as any);

      // Now the delta
      const result = converter.toOpenAI({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });

      expect(result).not.toBeNull();
      expect(result?.choices[0].delta.content).toBe("Hello");
    });

    test("converts tool_use block to tool_calls chunk", () => {
      const converter = transformer.createStreamTransformer();

      // Initialize with message_start
      converter.toOpenAI(createMessageStartEvent());

      // Tool use content block start
      const result = converter.toOpenAI({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: {},
        },
      });

      expect(result).not.toBeNull();
      expect(result?.choices[0].delta.tool_calls).toHaveLength(1);
      expect(result?.choices[0].delta.tool_calls?.[0].id).toBe("toolu_123");
      expect(result?.choices[0].delta.tool_calls?.[0].function?.name).toBe(
        "get_weather",
      );
    });

    test("converts input_json_delta to tool arguments chunk", () => {
      const converter = transformer.createStreamTransformer();

      // Initialize
      converter.toOpenAI(createMessageStartEvent());

      converter.toOpenAI({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "get_weather",
          input: {},
        },
      });

      const result = converter.toOpenAI({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city": "' },
      });

      expect(result).not.toBeNull();
      expect(result?.choices[0].delta.tool_calls?.[0].function?.arguments).toBe(
        '{"city": "',
      );
    });

    test("isToolChunk correctly identifies tool chunks", () => {
      const converter = transformer.createStreamTransformer();

      const toolChunk = {
        id: "chatcmpl-123",
        object: "chat.completion.chunk" as const,
        created: 1234567890,
        model: "claude-3-5-sonnet-20241022",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "toolu_123",
                  type: "function" as const,
                  function: { name: "test", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };

      const textChunk = {
        id: "chatcmpl-123",
        object: "chat.completion.chunk" as const,
        created: 1234567890,
        model: "claude-3-5-sonnet-20241022",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
          },
        ],
      };

      expect(converter.isToolChunk(toolChunk)).toBe(true);
      expect(converter.isToolChunk(textChunk)).toBe(false);
    });

    test("returns null for ping events", () => {
      const converter = transformer.createStreamTransformer();

      // Ping events exist at runtime but not in TS types
      const pingEvent = { type: "ping" } as unknown as Parameters<
        typeof converter.toOpenAI
      >[0];
      const result = converter.toOpenAI(pingEvent);

      expect(result).toBeNull();
    });

    test("returns null for message_stop event", () => {
      const converter = transformer.createStreamTransformer();
      const result = converter.toOpenAI({ type: "message_stop" });
      expect(result).toBeNull();
    });

    test("converts message_delta with stop_reason to finish chunk", () => {
      const converter = transformer.createStreamTransformer();

      // Initialize
      converter.toOpenAI(createMessageStartEvent());

      const result = converter.toOpenAI({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 15 },
        // biome-ignore lint/suspicious/noExplicitAny: SDK types require many optional fields
      } as any);

      expect(result).not.toBeNull();
      expect(result?.choices[0].finish_reason).toBe("stop");
      expect(result?.usage?.completion_tokens).toBe(15);
    });

    test("tracks tool indices correctly across multiple tools", () => {
      const converter = transformer.createStreamTransformer();

      // Initialize
      converter.toOpenAI(createMessageStartEvent());

      // First tool
      const tool1 = converter.toOpenAI({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "tool_a",
          input: {},
        },
      });
      expect(tool1?.choices[0].delta.tool_calls?.[0].index).toBe(0);

      // End first tool block
      converter.toOpenAI({ type: "content_block_stop", index: 0 });

      // Second tool
      const tool2 = converter.toOpenAI({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_2",
          name: "tool_b",
          input: {},
        },
      });
      expect(tool2?.choices[0].delta.tool_calls?.[0].index).toBe(1);
    });
  });
});
