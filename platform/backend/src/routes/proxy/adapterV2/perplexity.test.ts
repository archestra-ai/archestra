import { describe, expect, test } from "@/test";
import type { Perplexity } from "@/types";
import { perplexityAdapterFactory } from "./perplexity";

function createMockResponse(
    message: Perplexity.Types.ChatCompletionsResponse["choices"][0]["message"],
    usage?: Partial<Perplexity.Types.Usage>,
): Perplexity.Types.ChatCompletionsResponse {
    return {
        id: "chat-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "sonar",
        choices: [
            {
                index: 0,
                message: {
                    ...message,
                    content: message.content ?? null,
                },
                finish_reason: message.tool_calls ? "tool_calls" : "stop",
            },
        ],
        usage: {
            prompt_tokens: usage?.prompt_tokens ?? 100,
            completion_tokens: usage?.completion_tokens ?? 50,
            total_tokens:
                (usage?.prompt_tokens ?? 100) + (usage?.completion_tokens ?? 50),
        },
    };
}

function createMockRequest(
    messages: Perplexity.Types.ChatCompletionsRequest["messages"],
    options?: Partial<Perplexity.Types.ChatCompletionsRequest>,
): Perplexity.Types.ChatCompletionsRequest {
    return {
        model: "sonar",
        messages,
        ...options,
    };
}

describe("PerplexityResponseAdapter", () => {
    describe("getToolCalls", () => {
        test("converts function tool calls to common format", () => {
            const response = createMockResponse({
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_123",
                        type: "function",
                        function: {
                            name: "test_tool",
                            arguments: '{"param1": "value1", "param2": 42}',
                        },
                    },
                ],
            });

            const adapter = perplexityAdapterFactory.createResponseAdapter(response);
            const result = adapter.getToolCalls();

            expect(result).toEqual([
                {
                    id: "call_123",
                    name: "test_tool",
                    arguments: { param1: "value1", param2: 42 },
                },
            ]);
        });

        test("handles invalid JSON in arguments gracefully", () => {
            const response = createMockResponse({
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_789",
                        type: "function",
                        function: {
                            name: "broken_tool",
                            arguments: "invalid json{",
                        },
                    },
                ],
            });

            const adapter = perplexityAdapterFactory.createResponseAdapter(response);
            const result = adapter.getToolCalls();

            expect(result).toEqual([
                {
                    id: "call_789",
                    name: "broken_tool",
                    arguments: {},
                },
            ]);
        });

        test("handles multiple tool calls", () => {
            const response = createMockResponse({
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_1",
                        type: "function",
                        function: {
                            name: "tool_one",
                            arguments: '{"param": "value1"}',
                        },
                    },
                    {
                        id: "call_2",
                        type: "function",
                        function: {
                            name: "tool_two",
                            arguments: '{"param": "value2"}',
                        },
                    },
                ],
            });

            const adapter = perplexityAdapterFactory.createResponseAdapter(response);
            const result = adapter.getToolCalls();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                id: "call_1",
                name: "tool_one",
                arguments: { param: "value1" },
            });
            expect(result[1]).toEqual({
                id: "call_2",
                name: "tool_two",
                arguments: { param: "value2" },
            });
        });
    });

    describe("getText", () => {
        test("extracts text content from response", () => {
            const response = createMockResponse({
                role: "assistant",
                content: "Hello, world!",
            });

            const adapter = perplexityAdapterFactory.createResponseAdapter(response);
            expect(adapter.getText()).toBe("Hello, world!");
        });

        test("returns empty string when content is null", () => {
            const response = createMockResponse({
                role: "assistant",
                content: null,
            });

            const adapter = perplexityAdapterFactory.createResponseAdapter(response);
            expect(adapter.getText()).toBe("");
        });
    });

    describe("getUsage", () => {
        test("extracts usage tokens from response", () => {
            const response = createMockResponse(
                { role: "assistant", content: "Test" },
                { prompt_tokens: 150, completion_tokens: 75 },
            );

            const adapter = perplexityAdapterFactory.createResponseAdapter(response);
            const usage = adapter.getUsage();

            expect(usage).toEqual({
                inputTokens: 150,
                outputTokens: 75,
            });
        });
    });

    describe("toRefusalResponse", () => {
        test("creates refusal response with provided message", () => {
            const response = createMockResponse({
                role: "assistant",
                content: "Original content",
            });

            const adapter = perplexityAdapterFactory.createResponseAdapter(response);
            const refusal = adapter.toRefusalResponse(
                "Full refusal",
                "Tool call blocked by policy",
            );

            expect(refusal.choices[0].message.content).toBe(
                "Tool call blocked by policy",
            );
            expect(refusal.choices[0].finish_reason).toBe("stop");
        });
    });
});

describe("PerplexityRequestAdapter", () => {
    describe("getModel", () => {
        test("returns original model by default", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                model: "sonar-pro",
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            expect(adapter.getModel()).toBe("sonar-pro");
        });

        test("returns modified model after setModel", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                model: "sonar",
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            adapter.setModel("sonar-pro");
            expect(adapter.getModel()).toBe("sonar-pro");
        });
    });

    describe("isStreaming", () => {
        test("returns true when stream is true", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                stream: true,
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            expect(adapter.isStreaming()).toBe(true);
        });

        test("returns false when stream is false", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                stream: false,
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            expect(adapter.isStreaming()).toBe(false);
        });

        test("returns false when stream is undefined", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }]);

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            expect(adapter.isStreaming()).toBe(false);
        });
    });

    describe("getTools", () => {
        test("extracts function tools from request", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "get_weather",
                            description: "Get weather for a location",
                            parameters: {
                                type: "object",
                                properties: {
                                    location: { type: "string" },
                                },
                            },
                        },
                    },
                ],
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            const tools = adapter.getTools();

            expect(tools).toEqual([
                {
                    name: "get_weather",
                    description: "Get weather for a location",
                    inputSchema: {
                        type: "object",
                        properties: {
                            location: { type: "string" },
                        },
                    },
                },
            ]);
        });

        test("returns empty array when no tools", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }]);

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            expect(adapter.getTools()).toEqual([]);
        });
    });

    describe("toProviderRequest", () => {
        test("applies model change to request", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                model: "sonar",
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            adapter.setModel("sonar-pro");
            const result = adapter.toProviderRequest();

            expect(result.model).toBe("sonar-pro");
        });

        test("strips tools for models that do not support them", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                model: "sonar",
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "test_tool",
                            description: "A test tool",
                            parameters: { type: "object", properties: {} },
                        },
                    },
                ],
                tool_choice: "auto",
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            const result = adapter.toProviderRequest();

            expect(result.tools).toBeUndefined();
            expect(result.tool_choice).toBeUndefined();
        });

        test("keeps tools for sonar-pro model", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                model: "sonar-pro",
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "test_tool",
                            description: "A test tool",
                            parameters: { type: "object", properties: {} },
                        },
                    },
                ],
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            const result = adapter.toProviderRequest();

            expect(result.tools).toBeDefined();
            expect(result.tools).toHaveLength(1);
        });

        test("keeps tools for sonar-reasoning-pro model", () => {
            const request = createMockRequest([{ role: "user", content: "Hello" }], {
                model: "sonar-reasoning-pro",
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "test_tool",
                            description: "A test tool",
                            parameters: { type: "object", properties: {} },
                        },
                    },
                ],
            });

            const adapter = perplexityAdapterFactory.createRequestAdapter(request);
            const result = adapter.toProviderRequest();

            expect(result.tools).toBeDefined();
            expect(result.tools).toHaveLength(1);
        });
    });
});

describe("perplexityAdapterFactory", () => {
    describe("extractApiKey", () => {
        test("returns authorization header as-is (Bearer token)", () => {
            const headers = { authorization: "Bearer pplx-test-key-123" };
            const apiKey = perplexityAdapterFactory.extractApiKey(headers);
            expect(apiKey).toBe("Bearer pplx-test-key-123");
        });

        test("returns authorization header as-is (non-Bearer)", () => {
            const headers = { authorization: "pplx-test-key-123" };
            const apiKey = perplexityAdapterFactory.extractApiKey(headers);
            expect(apiKey).toBe("pplx-test-key-123");
        });

        test("returns undefined when no authorization header", () => {
            const headers = {} as unknown as Perplexity.Types.ChatCompletionsHeaders;
            const apiKey = perplexityAdapterFactory.extractApiKey(headers);
            expect(apiKey).toBeUndefined();
        });
    });

    describe("provider info", () => {
        test("has correct provider name", () => {
            expect(perplexityAdapterFactory.provider).toBe("perplexity");
        });

        test("has correct interaction type", () => {
            expect(perplexityAdapterFactory.interactionType).toBe(
                "perplexity:chatCompletions",
            );
        });
    });
});
