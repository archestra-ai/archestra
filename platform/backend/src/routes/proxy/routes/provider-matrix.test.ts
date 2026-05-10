import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { FinishReason, type GenerateContentResponse } from "@google/genai";
import type { SupportedProvider } from "@shared";
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import { vi } from "vitest";
import appConfig from "@/config";
import {
  InteractionModel,
  LimitValidationService,
  ModelModel,
  ToolModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { anthropicAdapterFactory } from "../adapters/anthropic";
import { azureAdapterFactory } from "../adapters/azure";
import { azureResponsesAdapterFactory } from "../adapters/azure-responses";
import { bedrockAdapterFactory } from "../adapters/bedrock";
import { cerebrasAdapterFactory } from "../adapters/cerebras";
import { cohereAdapterFactory } from "../adapters/cohere";
import { deepseekAdapterFactory } from "../adapters/deepseek";
import { geminiAdapterFactory } from "../adapters/gemini";
import { groqAdapterFactory } from "../adapters/groq";
import { minimaxAdapterFactory } from "../adapters/minimax";
import { mistralAdapterFactory } from "../adapters/mistral";
import { ollamaAdapterFactory } from "../adapters/ollama";
import { openaiAdapterFactory } from "../adapters/openai";
import { openrouterAdapterFactory } from "../adapters/openrouter";
import { perplexityAdapterFactory } from "../adapters/perplexity";
import { vllmAdapterFactory } from "../adapters/vllm";
import { xaiAdapterFactory } from "../adapters/xai";
import { zhipuaiAdapterFactory } from "../adapters/zhipuai";
import * as proxyUtils from "../utils";
import anthropicProxyRoutes from "./anthropic";
import azureProxyRoutes from "./azure";
import bedrockProxyRoutes from "./bedrock";
import cerebrasProxyRoutes from "./cerebras";
import cohereProxyRoutes from "./cohere";
import deepseekProxyRoutes from "./deepseek";
import geminiProxyRoutes from "./gemini";
import groqProxyRoutes from "./groq";
import minimaxProxyRoutes from "./minimax";
import mistralProxyRoutes from "./mistral";
import ollamaProxyRoutes from "./ollama";
import openAiProxyRoutes from "./openai";
import openrouterProxyRoutes from "./openrouter";
import perplexityProxyRoutes from "./perplexity";
import vllmProxyRoutes from "./vllm";
import xaiProxyRoutes from "./xai";
import zhipuaiProxyRoutes from "./zhipuai";

type ProviderFamily =
  | "openai"
  | "zhipuai"
  | "azure-responses"
  | "anthropic"
  | "gemini"
  | "cohere"
  | "minimax"
  | "bedrock";

type ToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
};

type RequestBuilder = {
  buildTextRequest: (params: {
    model: string;
    content: string;
  }) => Record<string, unknown>;
  buildToolRequest: (params: {
    model: string;
    content: string;
    tools: ToolDefinition[];
    stream?: boolean;
  }) => Record<string, unknown>;
  buildCompressionRequest: (params: {
    model: string;
  }) => Record<string, unknown>;
};

type ProviderTestConfig = {
  providerName: string;
  providerSlug: string;
  provider: SupportedProvider;
  family: ProviderFamily;
  routePlugin: FastifyPluginAsync;
  adapterFactory: { createClient: (...args: never[]) => unknown };
  endpoint: (agentId: string) => string;
  streamEndpoint?: (agentId: string) => string;
  headers: () => Record<string, string>;
  requestBuilder: RequestBuilder;
  model: string;
  optimizedModel: string;
  supportsDeclaredTools?: boolean;
  supportsStreamingToolCalls?: boolean;
  supportsCompression?: boolean;
  assertStreamingToolCall: (body: string) => void;
};

type ToolCallSpec = {
  name: string;
  arguments: string;
};

type UsageSpec = {
  inputTokens: number;
  outputTokens: number;
};

type HarnessOptions = {
  onRequest?: (request: unknown) => void;
  text?: string;
  model?: string;
  usage?: UsageSpec;
  nonStreamingToolCall?: ToolCallSpec | null;
  streamingToolCall?: ToolCallSpec | null;
};

const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description: "Read a file from the filesystem",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path to the file to read",
      },
    },
    required: ["file_path"],
  },
};

const TOOL_RESULT_DATA = {
  files: [
    { name: "README.md", size: 1024, type: "file" },
    { name: "src", size: 4096, type: "directory" },
    { name: "package.json", size: 512, type: "file" },
    { name: "tsconfig.json", size: 256, type: "file" },
    { name: "node_modules", size: 102400, type: "directory" },
  ],
  totalCount: 5,
  directory: ".",
};

const DEFAULT_USAGE: UsageSpec = {
  inputTokens: 100,
  outputTokens: 20,
};

function createFastifyApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < items.length) {
            return { done: false, value: items[index++] };
          }

          return { done: true, value: undefined };
        },
      };
    },
  };
}

function makeOpenAiMessages(content: string) {
  return [{ role: "user", content }];
}

function makeOpenAiCompressionRequest(model: string) {
  return {
    model,
    messages: [
      { role: "user", content: "What files are in the current directory?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "list_files",
              arguments: '{"directory": "."}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify(TOOL_RESULT_DATA),
      },
    ],
  };
}

function makeAnthropicCompressionRequest(model: string) {
  return {
    model,
    max_tokens: 1024,
    messages: [
      { role: "user", content: "What files are in the current directory?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_123",
            name: "list_files",
            input: { directory: "." },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: JSON.stringify(TOOL_RESULT_DATA),
          },
        ],
      },
    ],
  };
}

function makeGeminiCompressionRequest() {
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: "What files are in the current directory?" }],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "list_files",
              args: { directory: "." },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "list_files",
              response: TOOL_RESULT_DATA,
            },
          },
        ],
      },
    ],
  };
}

function makeCohereCompressionRequest(model: string) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What files are in the current directory?" },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "list_files",
              arguments: '{"directory": "."}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify(TOOL_RESULT_DATA),
      },
    ],
  };
}

function makeBedrockCompressionRequest(model: string) {
  return {
    modelId: model,
    messages: [
      {
        role: "user",
        content: [{ text: "What files are in the current directory?" }],
      },
      {
        role: "assistant",
        content: [
          {
            toolUse: {
              toolUseId: "tooluse_123",
              name: "list_files",
              input: { directory: "." },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: "tooluse_123",
              content: [{ text: JSON.stringify(TOOL_RESULT_DATA) }],
            },
          },
        ],
      },
    ],
  };
}

function createOpenAiLikeHarness(options: HarnessOptions = {}) {
  const requests: OpenAI.Chat.Completions.ChatCompletionCreateParams[] = [];
  const usage = options.usage ?? DEFAULT_USAGE;
  const model = options.model ?? "test-model";
  const text = options.text ?? "Mocked response";

  return {
    requests,
    client: {
      chat: {
        completions: {
          create: async (
            request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
          ) => {
            requests.push(request);
            options.onRequest?.(request);

            if (request.stream) {
              if (options.streamingToolCall) {
                const streamChunks: OpenAI.Chat.Completions.ChatCompletionChunk[] =
                  [
                    {
                      id: "chatcmpl_stream_tool",
                      object: "chat.completion.chunk",
                      created: 1,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            role: "assistant",
                            tool_calls: [
                              {
                                index: 0,
                                id: "call_stream_tool",
                                type: "function",
                                function: {
                                  name: options.streamingToolCall.name,
                                  arguments:
                                    options.streamingToolCall.arguments,
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                          logprobs: null,
                        },
                      ],
                    },
                    {
                      id: "chatcmpl_stream_tool",
                      object: "chat.completion.chunk",
                      created: 1,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: {},
                          finish_reason: "tool_calls",
                          logprobs: null,
                        },
                      ],
                      usage: {
                        prompt_tokens: usage.inputTokens,
                        completion_tokens: usage.outputTokens,
                        total_tokens: usage.inputTokens + usage.outputTokens,
                      },
                    },
                  ];
                return createAsyncIterable(streamChunks);
              }

              const streamChunks: OpenAI.Chat.Completions.ChatCompletionChunk[] =
                [
                  {
                    id: "chatcmpl_stream_text",
                    object: "chat.completion.chunk",
                    created: 1,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { role: "assistant", content: text },
                        finish_reason: null,
                        logprobs: null,
                      },
                    ],
                  },
                  {
                    id: "chatcmpl_stream_text",
                    object: "chat.completion.chunk",
                    created: 1,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {},
                        finish_reason: "stop",
                        logprobs: null,
                      },
                    ],
                    usage: {
                      prompt_tokens: usage.inputTokens,
                      completion_tokens: usage.outputTokens,
                      total_tokens: usage.inputTokens + usage.outputTokens,
                    },
                  },
                ];
              return createAsyncIterable(streamChunks);
            }

            return {
              id: "chatcmpl_nonstream",
              object: "chat.completion",
              created: 1,
              model,
              choices: [
                {
                  index: 0,
                  message: options.nonStreamingToolCall
                    ? {
                        role: "assistant",
                        content: null,
                        refusal: null,
                        tool_calls: [
                          {
                            id: "call_nonstream_tool",
                            type: "function",
                            function: {
                              name: options.nonStreamingToolCall.name,
                              arguments: options.nonStreamingToolCall.arguments,
                            },
                          },
                        ],
                      }
                    : {
                        role: "assistant",
                        content: text,
                        refusal: null,
                      },
                  finish_reason: options.nonStreamingToolCall
                    ? "tool_calls"
                    : "stop",
                  logprobs: null,
                },
              ],
              usage: {
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
                total_tokens: usage.inputTokens + usage.outputTokens,
              },
            } satisfies OpenAI.Chat.Completions.ChatCompletion;
          },
        },
      },
    },
  };
}

function createAzureResponsesHarness(options: HarnessOptions = {}) {
  const requests: Record<string, unknown>[] = [];
  const usage = options.usage ?? DEFAULT_USAGE;
  const model = options.model ?? "test-model";
  const text = options.text ?? "Mocked Azure Responses reply.";

  return {
    requests,
    client: {
      responses: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          options.onRequest?.(request);

          if (request.stream) {
            if (options.streamingToolCall) {
              const events = [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: {
                    id: "fc_123",
                    type: "function_call",
                    call_id: "call_123",
                    name: options.streamingToolCall.name,
                    arguments: "",
                  },
                },
                {
                  type: "response.function_call_arguments.delta",
                  item_id: "fc_123",
                  output_index: 0,
                  delta: options.streamingToolCall.arguments,
                },
                {
                  type: "response.function_call_arguments.done",
                  item_id: "fc_123",
                  output_index: 0,
                  arguments: options.streamingToolCall.arguments,
                },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    id: "fc_123",
                    type: "function_call",
                    call_id: "call_123",
                    name: options.streamingToolCall.name,
                    arguments: options.streamingToolCall.arguments,
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "resp_123",
                    object: "response",
                    model,
                    output: [
                      {
                        id: "fc_123",
                        type: "function_call",
                        call_id: "call_123",
                        name: options.streamingToolCall.name,
                        arguments: options.streamingToolCall.arguments,
                      },
                    ],
                    usage: {
                      input_tokens: usage.inputTokens,
                      output_tokens: usage.outputTokens,
                      total_tokens: usage.inputTokens + usage.outputTokens,
                    },
                  },
                },
              ];

              return createAsyncIterable(events);
            }

            const events = [
              {
                type: "response.output_text.delta",
                item_id: "msg_123",
                output_index: 0,
                delta: text,
              },
              {
                type: "response.completed",
                response: {
                  id: "resp_123",
                  object: "response",
                  model,
                  output: [
                    {
                      id: "msg_123",
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text }],
                    },
                  ],
                  usage: {
                    input_tokens: usage.inputTokens,
                    output_tokens: usage.outputTokens,
                    total_tokens: usage.inputTokens + usage.outputTokens,
                  },
                },
              },
            ];
            return createAsyncIterable(events);
          }

          return {
            id: "resp_nonstream",
            object: "response",
            created_at: 123,
            model,
            status: "completed",
            output: options.nonStreamingToolCall
              ? [
                  {
                    id: "fc_123",
                    type: "function_call",
                    call_id: "call_123",
                    name: options.nonStreamingToolCall.name,
                    arguments: options.nonStreamingToolCall.arguments,
                    status: "completed",
                  },
                ]
              : [
                  {
                    id: "msg_123",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text, annotations: [] }],
                  },
                ],
            usage: {
              input_tokens: usage.inputTokens,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: usage.outputTokens,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: usage.inputTokens + usage.outputTokens,
            },
          };
        },
      },
    },
  };
}

function createAnthropicHarness(options: HarnessOptions = {}) {
  const requests: Record<string, unknown>[] = [];
  const usage = options.usage ?? DEFAULT_USAGE;
  const model = options.model ?? "claude-3-5-sonnet-20241022";
  const text = options.text ?? "Mocked Anthropic response";

  return {
    requests,
    client: {
      messages: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          options.onRequest?.(request);
          return {
            id: "msg_nonstream",
            type: "message",
            role: "assistant",
            content: options.nonStreamingToolCall
              ? [
                  {
                    type: "tool_use",
                    id: "toolu_123",
                    name: options.nonStreamingToolCall.name,
                    input: JSON.parse(options.nonStreamingToolCall.arguments),
                  },
                ]
              : [{ type: "text", text, citations: [] }],
            model,
            stop_reason: options.nonStreamingToolCall ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          } as Anthropic.Message;
        },
        stream: (request: Record<string, unknown>) => {
          requests.push(request);
          options.onRequest?.(request);

          const events: Anthropic.Messages.MessageStreamEvent[] = [
            {
              type: "message_start",
              message: {
                id: "msg_stream",
                type: "message",
                container: null,
                role: "assistant",
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                } as Anthropic.Messages.Usage,
              },
            },
          ];

          if (options.streamingToolCall) {
            events.push(
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "toolu_123",
                  caller: { type: "direct" },
                  name: options.streamingToolCall.name,
                  input: {},
                },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "input_json_delta",
                  partial_json: options.streamingToolCall.arguments,
                },
              },
              {
                type: "content_block_stop",
                index: 0,
              },
              {
                type: "message_delta",
                delta: {
                  container: null,
                  stop_reason: "tool_use",
                  stop_sequence: null,
                },
                usage: {
                  output_tokens: usage.outputTokens,
                } as Anthropic.Messages.Usage,
              },
              {
                type: "message_stop",
              },
            );
          } else {
            events.push(
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "text",
                  text: "",
                  citations: [],
                },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text },
              },
              {
                type: "content_block_stop",
                index: 0,
              },
              {
                type: "message_delta",
                delta: {
                  container: null,
                  stop_reason: "end_turn",
                  stop_sequence: null,
                },
                usage: {
                  output_tokens: usage.outputTokens,
                } as Anthropic.Messages.Usage,
              },
              {
                type: "message_stop",
              },
            );
          }

          return createAsyncIterable(events);
        },
      },
    },
  };
}

function createZhipuaiHarness(options: HarnessOptions = {}) {
  const openAiHarness = createOpenAiLikeHarness(options);

  return {
    requests: openAiHarness.requests,
    client: {
      chatCompletions: (request: Record<string, unknown>) =>
        openAiHarness.client.chat.completions.create(
          request as unknown as ChatCompletionCreateParamsNonStreaming,
        ),
      chatCompletionsStream: (request: Record<string, unknown>) =>
        openAiHarness.client.chat.completions.create({
          ...(request as unknown as ChatCompletionCreateParamsStreaming),
          stream: true,
        }),
    },
  };
}

function createGeminiHarness(options: HarnessOptions = {}) {
  const requests: Record<string, unknown>[] = [];
  const usage = options.usage ?? DEFAULT_USAGE;
  const model = options.model ?? "gemini-2.5-pro";
  const text = options.text ?? "Mocked Gemini response";

  return {
    requests,
    client: {
      models: {
        generateContent: async (request: Record<string, unknown>) => {
          requests.push(request);
          options.onRequest?.(request);
          return {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: options.nonStreamingToolCall
                    ? [
                        {
                          functionCall: {
                            name: options.nonStreamingToolCall.name,
                            args: JSON.parse(
                              options.nonStreamingToolCall.arguments,
                            ),
                          },
                        },
                      ]
                    : [{ text }],
                },
                finishReason: FinishReason.STOP,
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: usage.inputTokens,
              candidatesTokenCount: usage.outputTokens,
              totalTokenCount: usage.inputTokens + usage.outputTokens,
            },
            modelVersion: model,
            responseId: "gemini_nonstream",
          } as GenerateContentResponse;
        },
        generateContentStream: async (request: Record<string, unknown>) => {
          requests.push(request);
          options.onRequest?.(request);
          const chunks: unknown[] = options.streamingToolCall
            ? [
                {
                  candidates: [
                    {
                      content: {
                        role: "model",
                        parts: [
                          {
                            functionCall: {
                              name: options.streamingToolCall.name,
                              args: JSON.parse(
                                options.streamingToolCall.arguments,
                              ),
                            },
                          },
                        ],
                      },
                      index: 0,
                    },
                  ],
                },
                {
                  usageMetadata: {
                    promptTokenCount: usage.inputTokens,
                    candidatesTokenCount: usage.outputTokens,
                    totalTokenCount: usage.inputTokens + usage.outputTokens,
                  },
                  modelVersion: model,
                  responseId: "gemini_stream",
                },
              ]
            : [
                {
                  candidates: [
                    {
                      content: {
                        role: "model",
                        parts: [{ text }],
                      },
                      index: 0,
                    },
                  ],
                },
                {
                  usageMetadata: {
                    promptTokenCount: usage.inputTokens,
                    candidatesTokenCount: usage.outputTokens,
                    totalTokenCount: usage.inputTokens + usage.outputTokens,
                  },
                  modelVersion: model,
                  responseId: "gemini_stream",
                },
              ];

          return createAsyncIterable(chunks);
        },
      },
    },
  };
}

function createCohereHarness(options: HarnessOptions = {}) {
  const requests: Record<string, unknown>[] = [];
  const usage = options.usage ?? DEFAULT_USAGE;
  const model = options.model ?? "command-r-plus-08-2024";
  const text = options.text ?? "Mocked Cohere response";

  return {
    requests,
    client: {
      chat: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          options.onRequest?.(request);
          return {
            id: "cohere_nonstream",
            message: {
              role: "assistant",
              content: options.nonStreamingToolCall
                ? []
                : [{ type: "text", text }],
              tool_calls: options.nonStreamingToolCall
                ? [
                    {
                      id: "call_123",
                      type: "function",
                      function: {
                        name: options.nonStreamingToolCall.name,
                        arguments: options.nonStreamingToolCall.arguments,
                      },
                    },
                  ]
                : undefined,
            },
            finish_reason: options.nonStreamingToolCall
              ? "TOOL_CALL"
              : "COMPLETE",
            usage: {
              tokens: {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
              },
            },
            model,
          };
        },
        stream: async (request: Record<string, unknown>) => {
          requests.push(request);
          options.onRequest?.(request);
          const chunks: unknown[] = options.streamingToolCall
            ? [
                {
                  type: "message-start",
                },
                {
                  type: "tool-call-start",
                  index: 0,
                  delta: {
                    message: {
                      tool_calls: [
                        {
                          id: "call_123",
                          type: "function",
                          function: {
                            name: options.streamingToolCall.name,
                            arguments: "",
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  type: "tool-call-delta",
                  index: 0,
                  delta: {
                    message: {
                      tool_calls: [
                        {
                          id: "call_123",
                          type: "function",
                          function: {
                            name: options.streamingToolCall.name,
                            arguments: options.streamingToolCall.arguments,
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  type: "message-end",
                  delta: {
                    finish_reason: "TOOL_CALL",
                    usage: {
                      tokens: {
                        input_tokens: usage.inputTokens,
                        output_tokens: usage.outputTokens,
                      },
                    },
                  },
                },
              ]
            : [
                {
                  type: "message-start",
                },
                {
                  type: "content-delta",
                  delta: {
                    message: {
                      content: [{ type: "text", text }],
                    },
                  },
                },
                {
                  type: "message-end",
                  delta: {
                    finish_reason: "COMPLETE",
                    usage: {
                      tokens: {
                        input_tokens: usage.inputTokens,
                        output_tokens: usage.outputTokens,
                      },
                    },
                  },
                },
              ];

          return createAsyncIterable(chunks);
        },
      },
    },
  };
}

function createMinimaxHarness(options: HarnessOptions = {}) {
  const requests: Record<string, unknown>[] = [];
  const usage = options.usage ?? DEFAULT_USAGE;
  const model = options.model ?? "MiniMax-M2.1";
  const text = options.text ?? "Mocked MiniMax response";

  return {
    requests,
    client: {
      chatCompletions: async (request: Record<string, unknown>) => {
        requests.push(request);
        options.onRequest?.(request);
        return {
          id: "minimax_nonstream",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: options.nonStreamingToolCall
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_123",
                        type: "function",
                        function: {
                          name: options.nonStreamingToolCall.name,
                          arguments: options.nonStreamingToolCall.arguments,
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: text,
                  },
              finish_reason: options.nonStreamingToolCall
                ? "tool_calls"
                : "stop",
            },
          ],
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        };
      },
      chatCompletionsStream: async (request: Record<string, unknown>) => {
        requests.push(request);
        options.onRequest?.(request);
        const chunks: unknown[] = options.streamingToolCall
          ? [
              {
                id: "minimax_stream",
                object: "chat.completion.chunk",
                created: 1,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_123",
                          type: "function",
                          function: {
                            name: options.streamingToolCall.name,
                            arguments: options.streamingToolCall.arguments,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: "minimax_stream",
                object: "chat.completion.chunk",
                created: 1,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "tool_calls",
                  },
                ],
                usage: {
                  prompt_tokens: usage.inputTokens,
                  completion_tokens: usage.outputTokens,
                  total_tokens: usage.inputTokens + usage.outputTokens,
                },
              },
            ]
          : [
              {
                id: "minimax_stream",
                object: "chat.completion.chunk",
                created: 1,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: text },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: "minimax_stream",
                object: "chat.completion.chunk",
                created: 1,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: usage.inputTokens,
                  completion_tokens: usage.outputTokens,
                  total_tokens: usage.inputTokens + usage.outputTokens,
                },
              },
            ];

        return createAsyncIterable(chunks);
      },
    },
  };
}

function createBedrockHarness(options: HarnessOptions = {}) {
  const requests: Record<string, unknown>[] = [];
  const usage = options.usage ?? DEFAULT_USAGE;
  const text = options.text ?? "Mocked Bedrock response";

  return {
    requests,
    client: {
      converse: async (modelId: string, request: Record<string, unknown>) => {
        requests.push({ modelId, ...request });
        options.onRequest?.({ modelId, ...request });
        return {
          $metadata: { requestId: "bedrock_nonstream" },
          output: {
            message: {
              role: "assistant",
              content: options.nonStreamingToolCall
                ? [
                    {
                      toolUse: {
                        toolUseId: "tooluse_123",
                        name: options.nonStreamingToolCall.name,
                        input: JSON.parse(
                          options.nonStreamingToolCall.arguments,
                        ),
                      },
                    },
                  ]
                : [{ text }],
            },
          },
          stopReason: options.nonStreamingToolCall ? "tool_use" : "end_turn",
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
        };
      },
      converseStream: async (
        modelId: string,
        request: Record<string, unknown>,
      ) => {
        requests.push({ modelId, ...request });
        options.onRequest?.({ modelId, ...request });
        const events: unknown[] = options.streamingToolCall
          ? [
              {
                contentBlockStart: {
                  contentBlockIndex: 0,
                  start: {
                    toolUse: {
                      toolUseId: "tooluse_123",
                      name: options.streamingToolCall.name,
                    },
                  },
                },
              },
              {
                contentBlockDelta: {
                  contentBlockIndex: 0,
                  delta: {
                    toolUse: {
                      input: options.streamingToolCall.arguments,
                    },
                  },
                },
              },
              {
                contentBlockStop: {
                  contentBlockIndex: 0,
                },
              },
              {
                metadata: {
                  usage: {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                  },
                },
              },
              {
                messageStop: {
                  stopReason: "tool_use",
                },
              },
            ]
          : [
              {
                contentBlockDelta: {
                  contentBlockIndex: 0,
                  delta: {
                    text,
                  },
                },
              },
              {
                metadata: {
                  usage: {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                  },
                },
              },
              {
                messageStop: {
                  stopReason: "end_turn",
                },
              },
            ];

        return createAsyncIterable(events);
      },
    },
  };
}

function createHarness(family: ProviderFamily, options: HarnessOptions = {}) {
  switch (family) {
    case "openai":
      return createOpenAiLikeHarness(options);
    case "zhipuai":
      return createZhipuaiHarness(options);
    case "azure-responses":
      return createAzureResponsesHarness(options);
    case "anthropic":
      return createAnthropicHarness(options);
    case "gemini":
      return createGeminiHarness(options);
    case "cohere":
      return createCohereHarness(options);
    case "minimax":
      return createMinimaxHarness(options);
    case "bedrock":
      return createBedrockHarness(options);
  }
}

function makeOpenAiCompatibleBuilder(defaultModel: string): RequestBuilder {
  return {
    buildTextRequest: ({ model, content }) => ({
      model: model || defaultModel,
      messages: makeOpenAiMessages(content),
    }),
    buildToolRequest: ({ model, content, tools, stream = false }) => ({
      model: model || defaultModel,
      stream,
      messages: makeOpenAiMessages(content),
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    }),
    buildCompressionRequest: ({ model }) =>
      makeOpenAiCompressionRequest(model || defaultModel),
  };
}

function makeAnthropicBuilder(defaultModel: string): RequestBuilder {
  return {
    buildTextRequest: ({ model, content }) => ({
      model: model || defaultModel,
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    }),
    buildToolRequest: ({ model, content, tools, stream = false }) => ({
      model: model || defaultModel,
      max_tokens: 1024,
      stream,
      messages: [{ role: "user", content }],
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    }),
    buildCompressionRequest: ({ model }) =>
      makeAnthropicCompressionRequest(model || defaultModel),
  };
}

function makeGeminiBuilder(_defaultModel: string): RequestBuilder {
  return {
    buildTextRequest: ({ content }) => ({
      contents: [{ role: "user", parts: [{ text: content }] }],
    }),
    buildToolRequest: ({ content, tools }) => ({
      contents: [{ role: "user", parts: [{ text: content }] }],
      tools: [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ],
    }),
    buildCompressionRequest: () => makeGeminiCompressionRequest(),
  };
}

function makeAzureResponsesBuilder(defaultModel: string): RequestBuilder {
  return {
    buildTextRequest: ({ model, content }) => ({
      model: model || defaultModel,
      input: content,
    }),
    buildToolRequest: ({ model, content, tools, stream = false }) => ({
      model: model || defaultModel,
      stream,
      input: content,
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    }),
    buildCompressionRequest: ({ model }) => ({
      model: model || defaultModel,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "What files are in the current directory?",
            },
          ],
        },
        {
          type: "function_call",
          call_id: "call_123",
          name: "list_files",
          arguments: '{"directory": "."}',
        },
        {
          type: "function_call_output",
          call_id: "call_123",
          output: JSON.stringify(TOOL_RESULT_DATA),
        },
      ],
    }),
  };
}

function makeCohereBuilder(defaultModel: string): RequestBuilder {
  return {
    buildTextRequest: ({ model, content }) => ({
      model: model || defaultModel,
      messages: [{ role: "user", content: [{ type: "text", text: content }] }],
    }),
    buildToolRequest: ({ model, content, tools, stream = false }) => ({
      model: model || defaultModel,
      stream,
      messages: [{ role: "user", content: [{ type: "text", text: content }] }],
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
    }),
    buildCompressionRequest: ({ model }) =>
      makeCohereCompressionRequest(model || defaultModel),
  };
}

function makeBedrockBuilder(defaultModel: string): RequestBuilder {
  return {
    buildTextRequest: ({ model, content }) => ({
      modelId: model || defaultModel,
      messages: [{ role: "user", content: [{ text: content }] }],
    }),
    buildToolRequest: ({ model, content, tools, stream = false }) => ({
      modelId: model || defaultModel,
      _isStreaming: stream,
      messages: [{ role: "user", content: [{ text: content }] }],
      toolConfig: {
        tools: tools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: { json: tool.parameters },
          },
        })),
      },
    }),
    buildCompressionRequest: ({ model }) =>
      makeBedrockCompressionRequest(model || defaultModel),
  };
}

function makeConfig(
  params: Omit<ProviderTestConfig, "assertStreamingToolCall"> & {
    assertStreamingToolCall?: (body: string) => void;
  },
): ProviderTestConfig {
  return {
    ...params,
    assertStreamingToolCall:
      params.assertStreamingToolCall ??
      ((body) => {
        expect(body).toContain("data:");
        expect(body).toContain("read_file");
      }),
  };
}

const providerConfigsByProvider = {
  openai: makeConfig({
    providerName: "OpenAI",
    providerSlug: "openai",
    provider: "openai",
    family: "openai",
    routePlugin: openAiProxyRoutes,
    adapterFactory: openaiAdapterFactory,
    endpoint: (agentId) => `/v1/openai/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("gpt-4o"),
    model: "gpt-4o",
    optimizedModel: "gpt-4o-mini",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  gemini: makeConfig({
    providerName: "Gemini",
    providerSlug: "gemini",
    provider: "gemini",
    family: "gemini",
    routePlugin: geminiProxyRoutes,
    adapterFactory: geminiAdapterFactory,
    endpoint: (agentId) =>
      `/v1/gemini/${agentId}/v1beta/models/gemini-2.5-pro:generateContent`,
    streamEndpoint: (agentId) =>
      `/v1/gemini/${agentId}/v1beta/models/gemini-2.5-pro:streamGenerateContent`,
    headers: () => ({
      "x-goog-api-key": "test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeGeminiBuilder("gemini-2.5-pro"),
    model: "gemini-2.5-pro",
    optimizedModel: "gemini-2.5-flash",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  anthropic: makeConfig({
    providerName: "Anthropic",
    providerSlug: "anthropic",
    provider: "anthropic",
    family: "anthropic",
    routePlugin: anthropicProxyRoutes,
    adapterFactory: anthropicAdapterFactory,
    endpoint: (agentId) => `/v1/anthropic/${agentId}/v1/messages`,
    headers: () => ({
      "x-api-key": "test-key",
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    }),
    requestBuilder: makeAnthropicBuilder("claude-3-5-sonnet-20241022"),
    model: "claude-3-5-sonnet-20241022",
    optimizedModel: "claude-3-5-haiku-20241022",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  bedrock: makeConfig({
    providerName: "Bedrock",
    providerSlug: "bedrock",
    provider: "bedrock",
    family: "bedrock",
    routePlugin: bedrockProxyRoutes,
    adapterFactory: bedrockAdapterFactory,
    endpoint: (agentId) => `/v1/bedrock/${agentId}/converse`,
    streamEndpoint: (agentId) => `/v1/bedrock/${agentId}/converse-stream`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeBedrockBuilder(
      "anthropic.claude-3-sonnet-20240229-v1:0",
    ),
    model: "anthropic.claude-3-sonnet-20240229-v1:0",
    optimizedModel: "amazon.nova-lite-v1:0",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
    assertStreamingToolCall(body) {
      expect(body).toContain("read_file");
      expect(body).toContain("tooluse_123");
    },
  }),
  cohere: makeConfig({
    providerName: "Cohere",
    providerSlug: "cohere",
    provider: "cohere",
    family: "cohere",
    routePlugin: cohereProxyRoutes,
    adapterFactory: cohereAdapterFactory,
    endpoint: (agentId) => `/v1/cohere/${agentId}/chat`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeCohereBuilder("command-r-plus-08-2024"),
    model: "command-r-plus-08-2024",
    optimizedModel: "command-r-08-2024",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: false,
    supportsCompression: true,
  }),
  cerebras: makeConfig({
    providerName: "Cerebras",
    providerSlug: "cerebras",
    provider: "cerebras",
    family: "openai",
    routePlugin: cerebrasProxyRoutes,
    adapterFactory: cerebrasAdapterFactory,
    endpoint: (agentId) => `/v1/cerebras/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder(
      "llama-4-scout-17b-16e-instruct",
    ),
    model: "llama-4-scout-17b-16e-instruct",
    optimizedModel: "llama-3.3-70b",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  mistral: makeConfig({
    providerName: "Mistral",
    providerSlug: "mistral",
    provider: "mistral",
    family: "openai",
    routePlugin: mistralProxyRoutes,
    adapterFactory: mistralAdapterFactory,
    endpoint: (agentId) => `/v1/mistral/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("mistral-large-latest"),
    model: "mistral-large-latest",
    optimizedModel: "ministral-8b-latest",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  perplexity: makeConfig({
    providerName: "Perplexity",
    providerSlug: "perplexity",
    provider: "perplexity",
    family: "openai",
    routePlugin: perplexityProxyRoutes,
    adapterFactory: perplexityAdapterFactory,
    endpoint: (agentId) => `/v1/perplexity/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("sonar-pro"),
    model: "sonar-pro",
    optimizedModel: "sonar",
    supportsDeclaredTools: false,
    supportsStreamingToolCalls: false,
    supportsCompression: false,
  }),
  groq: makeConfig({
    providerName: "Groq",
    providerSlug: "groq",
    provider: "groq",
    family: "openai",
    routePlugin: groqProxyRoutes,
    adapterFactory: groqAdapterFactory,
    endpoint: (agentId) => `/v1/groq/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("llama-3.3-70b-versatile"),
    model: "llama-3.3-70b-versatile",
    optimizedModel: "llama-3.1-8b-instant",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  xai: makeConfig({
    providerName: "xAI",
    providerSlug: "xai",
    provider: "xai",
    family: "openai",
    routePlugin: xaiProxyRoutes,
    adapterFactory: xaiAdapterFactory,
    endpoint: (agentId) => `/v1/xai/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("grok-2-1212"),
    model: "grok-2-1212",
    optimizedModel: "grok-2-mini",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  openrouter: makeConfig({
    providerName: "OpenRouter",
    providerSlug: "openrouter",
    provider: "openrouter",
    family: "openai",
    routePlugin: openrouterProxyRoutes,
    adapterFactory: openrouterAdapterFactory,
    endpoint: (agentId) => `/v1/openrouter/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("openai/gpt-4o"),
    model: "openai/gpt-4o",
    optimizedModel: "openai/gpt-4o-mini",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  vllm: makeConfig({
    providerName: "vLLM",
    providerSlug: "vllm",
    provider: "vllm",
    family: "openai",
    routePlugin: vllmProxyRoutes,
    adapterFactory: vllmAdapterFactory,
    endpoint: (agentId) => `/v1/vllm/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder(
      "meta-llama/Llama-3.1-8B-Instruct",
    ),
    model: "meta-llama/Llama-3.1-8B-Instruct",
    optimizedModel: "meta-llama/Llama-3.1-70B-Instruct",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  ollama: makeConfig({
    providerName: "Ollama",
    providerSlug: "ollama",
    provider: "ollama",
    family: "openai",
    routePlugin: ollamaProxyRoutes,
    adapterFactory: ollamaAdapterFactory,
    endpoint: (agentId) => `/v1/ollama/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("llama3.2"),
    model: "llama3.2",
    optimizedModel: "llama3.2:1b",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  zhipuai: makeConfig({
    providerName: "Zhipu AI",
    providerSlug: "zhipuai",
    provider: "zhipuai",
    family: "zhipuai",
    routePlugin: zhipuaiProxyRoutes,
    adapterFactory: zhipuaiAdapterFactory,
    endpoint: (agentId) => `/v1/zhipuai/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("glm-4.5-flash"),
    model: "glm-4.5-flash",
    optimizedModel: "glm-4-flash",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  deepseek: makeConfig({
    providerName: "DeepSeek",
    providerSlug: "deepseek",
    provider: "deepseek",
    family: "openai",
    routePlugin: deepseekProxyRoutes,
    adapterFactory: deepseekAdapterFactory,
    endpoint: (agentId) => `/v1/deepseek/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("deepseek-chat"),
    model: "deepseek-chat",
    optimizedModel: "deepseek-reasoner",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  minimax: makeConfig({
    providerName: "Minimax",
    providerSlug: "minimax",
    provider: "minimax",
    family: "minimax",
    routePlugin: minimaxProxyRoutes,
    adapterFactory: minimaxAdapterFactory,
    endpoint: (agentId) => `/v1/minimax/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("MiniMax-M2.1"),
    model: "MiniMax-M2.1",
    optimizedModel: "MiniMax-M1",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
  azure: makeConfig({
    providerName: "Azure",
    providerSlug: "azure",
    provider: "azure",
    family: "openai",
    routePlugin: azureProxyRoutes,
    adapterFactory: azureAdapterFactory,
    endpoint: (agentId) => `/v1/azure/${agentId}/chat/completions`,
    headers: () => ({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    }),
    requestBuilder: makeOpenAiCompatibleBuilder("gpt-4o"),
    model: "gpt-4o",
    optimizedModel: "gpt-4o-mini",
    supportsDeclaredTools: true,
    supportsStreamingToolCalls: true,
    supportsCompression: true,
  }),
} satisfies Record<SupportedProvider, ProviderTestConfig>;

const azureResponsesConfig = makeConfig({
  providerName: "Azure Responses",
  providerSlug: "azure-responses",
  provider: "azure",
  family: "azure-responses",
  routePlugin: azureProxyRoutes,
  adapterFactory: azureResponsesAdapterFactory,
  endpoint: (agentId) => `/v1/azure/${agentId}/responses`,
  headers: () => ({
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  }),
  requestBuilder: makeAzureResponsesBuilder("gpt-4.1"),
  model: "gpt-4.1",
  optimizedModel: "gpt-4.1-mini",
  supportsDeclaredTools: true,
  supportsStreamingToolCalls: true,
  supportsCompression: false,
  assertStreamingToolCall(body) {
    expect(body).toContain("response.completed");
    expect(body).toContain("read_file");
  },
});

const providerConfigs = [
  ...Object.values(providerConfigsByProvider),
  azureResponsesConfig,
] satisfies ProviderTestConfig[];

describe("LLM proxy provider matrix", () => {
  let app: FastifyInstance;
  const originalVllmEnabled = appConfig.llm.vllm.enabled;
  const originalVllmBaseUrl = appConfig.llm.vllm.baseUrl;
  const originalAzureBaseUrl = appConfig.llm.azure.baseUrl;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    appConfig.llm.vllm.enabled = originalVllmEnabled;
    appConfig.llm.vllm.baseUrl = originalVllmBaseUrl;
    appConfig.llm.azure.baseUrl = originalAzureBaseUrl;
    if (app) {
      await app.close();
    }
  });

  for (const config of providerConfigs) {
    describe(config.providerName, () => {
      async function setupRoute(
        _agent: Agent,
        harnessOptions: HarnessOptions = {},
      ) {
        app = createFastifyApp();
        if (config.provider === "vllm") {
          appConfig.llm.vllm.enabled = true;
          appConfig.llm.vllm.baseUrl = "http://localhost:8000/v1";
        }
        if (config.provider === "azure") {
          appConfig.llm.azure.baseUrl = "";
        }
        const harness = createHarness(config.family, {
          model: config.model,
          ...harnessOptions,
        });
        vi.spyOn(config.adapterFactory, "createClient").mockImplementation(
          () =>
            (config.provider === "azure" && config.family === "openai"
              ? {
                  apiKey: "test-key",
                  baseUrl: undefined,
                  defaultHeaders: undefined,
                  fetch: undefined,
                  openai: harness.client,
                }
              : harness.client) as never,
        );
        await app.register(config.routePlugin);
        return harness;
      }

      test.skipIf(config.supportsDeclaredTools === false)(
        "persists declared tools from LLM proxy requests",
        async ({ makeAgent }) => {
          const agent = await makeAgent({
            agentType: "llm_proxy",
            name: `${config.providerName} proxy`,
          });
          await setupRoute(agent, {
            nonStreamingToolCall: {
              name: READ_FILE_TOOL.name,
              arguments: '{"file_path":"/tmp/test.txt"}',
            },
          });

          const response = await app.inject({
            method: "POST",
            url: config.endpoint(agent.id),
            headers: config.headers(),
            payload: config.requestBuilder.buildToolRequest({
              model: config.model,
              content: "Read a file",
              tools: [READ_FILE_TOOL],
            }),
          });

          expect(response.statusCode).toBe(200);

          const secondResponse = await app.inject({
            method: "POST",
            url: config.endpoint(agent.id),
            headers: config.headers(),
            payload: config.requestBuilder.buildToolRequest({
              model: config.model,
              content: "Read a file again",
              tools: [READ_FILE_TOOL],
            }),
          });

          expect(secondResponse.statusCode).toBe(200);

          const storedTool = await ToolModel.findByName(READ_FILE_TOOL.name);
          expect(storedTool).not.toBeNull();
          expect(await ToolModel.countByName(READ_FILE_TOOL.name)).toBe(1);
        },
      );

      test("stores execution IDs on interactions", async ({ makeAgent }) => {
        const agent = await makeAgent({
          name: `${config.providerName} execution`,
        });
        await ModelModel.upsert({
          externalId: `${config.provider}/${config.model}`,
          provider: config.provider,
          modelId: config.model,
          inputModalities: null,
          outputModalities: null,
          customPricePerMillionInput: "20000.00",
          customPricePerMillionOutput: "30000.00",
          lastSyncedAt: new Date(),
        });
        await setupRoute(agent);

        const executionId = randomUUID();
        const response = await app.inject({
          method: "POST",
          url: config.endpoint(agent.id),
          headers: {
            ...config.headers(),
            "x-archestra-execution-id": executionId,
          },
          payload: config.requestBuilder.buildTextRequest({
            model: config.model,
            content: "Hello from execution metrics",
          }),
        });

        expect(response.statusCode).toBe(200);

        const interactions =
          await InteractionModel.getAllInteractionsForProfile(agent.id);
        expect(
          interactions.some(
            (interaction) => interaction.executionId === executionId,
          ),
        ).toBe(true);
      });

      test.skipIf(config.supportsStreamingToolCalls === false)(
        "streams tool calls through the proxy",
        async ({ makeAgent }) => {
          const agent = await makeAgent({
            name: `${config.providerName} stream`,
          });
          await setupRoute(agent, {
            streamingToolCall: {
              name: READ_FILE_TOOL.name,
              arguments: '{"file_path":"/tmp/test.txt"}',
            },
          });

          const response = await app.inject({
            method: "POST",
            url: config.streamEndpoint?.(agent.id) ?? config.endpoint(agent.id),
            headers: config.headers(),
            payload: config.requestBuilder.buildToolRequest({
              model: config.model,
              content: "Stream a tool call",
              tools: [READ_FILE_TOOL],
              stream: true,
            }),
          });

          expect(response.statusCode).toBe(200);
          if (config.family === "openai") {
            expect(response.headers["content-type"]).toContain(
              "text/event-stream",
            );
          }
          config.assertStreamingToolCall(response.body);
        },
      );

      test("applies optimized models before provider execution", async ({
        makeAgent,
      }) => {
        const agent = await makeAgent({
          name: `${config.providerName} optimization`,
        });
        const optimizedModelSpy = vi
          .spyOn(proxyUtils.costOptimization, "getOptimizedModel")
          .mockResolvedValue(config.optimizedModel);

        const harness = await setupRoute(agent);

        const response = await app.inject({
          method: "POST",
          url: config.endpoint(agent.id),
          headers: config.headers(),
          payload: config.requestBuilder.buildTextRequest({
            model: config.model,
            content: "x".repeat(1100),
          }),
        });

        expect(response.statusCode).toBe(200);
        expect(optimizedModelSpy).toHaveBeenCalled();
        expect(JSON.stringify(harness.requests.at(-1))).toContain(
          config.optimizedModel,
        );
      });

      test.skipIf(config.supportsCompression === false)(
        "toggles TOON compression before provider execution",
        async ({ makeAgent }) => {
          const agent = await makeAgent({
            name: `${config.providerName} compression`,
          });
          vi.spyOn(proxyUtils.toonConversion, "shouldApplyToonCompression")
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);

          const enabledHarness = await setupRoute(agent);
          const enabledResponse = await app.inject({
            method: "POST",
            url: config.endpoint(agent.id),
            headers: config.headers(),
            payload: config.requestBuilder.buildCompressionRequest({
              model: config.model,
            }),
          });

          expect(enabledResponse.statusCode).toBe(200);
          expect(JSON.stringify(enabledHarness.requests.at(-1))).toMatch(
            /files\[5\]/,
          );

          await app.close();
          const disabledHarness = await setupRoute(agent);
          const disabledResponse = await app.inject({
            method: "POST",
            url: config.endpoint(agent.id),
            headers: config.headers(),
            payload: config.requestBuilder.buildCompressionRequest({
              model: config.model,
            }),
          });

          expect(disabledResponse.statusCode).toBe(200);
          expect(JSON.stringify(disabledHarness.requests.at(-1))).toContain(
            "README.md",
          );
        },
      );

      test("blocks requests when token cost limits are exceeded", async ({
        makeAgent,
      }) => {
        const agent = await makeAgent({
          name: `${config.providerName} limits`,
        });
        vi.spyOn(
          LimitValidationService,
          "checkLimitsBeforeRequest",
        ).mockResolvedValue([
          "Refusal",
          "The token cost limit has been exceeded.",
        ]);
        await setupRoute(agent);

        const blockedResponse = await app.inject({
          method: "POST",
          url: config.endpoint(agent.id),
          headers: config.headers(),
          payload: config.requestBuilder.buildTextRequest({
            model: config.model,
            content: "Will this get blocked?",
          }),
        });

        expect(blockedResponse.statusCode).toBe(429);
        expect(blockedResponse.json()).toMatchObject({
          error: {
            code: "token_cost_limit_exceeded",
          },
        });
      });
    });
  }
});
