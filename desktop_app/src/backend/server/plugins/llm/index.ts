import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import {
  type FinishReason,
  type LanguageModelUsage,
  type StepResult,
  convertToModelMessages,
  stepCountIs,
  streamText,
} from 'ai';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createOllama } from 'ollama-ai-provider-v2';

import { type McpTools } from '@backend/archestraMcp';
import ArchestraMcpContext from '@backend/archestraMcp/context';
import config from '@backend/config';
import { getModelContextWindow } from '@backend/llms/modelContextWindows';
import toolAggregator from '@backend/llms/toolAggregator';
import Chat from '@backend/models/chat';
import CloudProviderModel from '@backend/models/cloudProvider';
import ollamaClient from '@backend/ollama/client';

interface StreamRequestBody {
  model: string;
  messages: Array<any>;
  sessionId?: string;
  provider?: string;
  requestedTools?: string[]; // Tool IDs requested by frontend
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
  chatId?: number; // Chat ID to get chat-specific tools
}

const createModelInstance = async (model: string, provider?: string) => {
  if (provider === 'ollama') {
    const baseUrl = config.ollama.server.host + '/api';
    const ollamaClient = createOllama({ baseURL: baseUrl });
    return ollamaClient(model);
  }

  const providerConfig = await CloudProviderModel.getProviderConfigForModel(model);

  if (!providerConfig) {
    return openai(model);
  }

  const { apiKey, provider: providerData } = providerConfig;
  const { type, baseUrl, headers } = providerData;

  const clientFactories = {
    anthropic: () => createAnthropic({ apiKey, baseURL: baseUrl }),
    openai: () => createOpenAI({ apiKey, baseURL: baseUrl, headers }),
    deepseek: () => createDeepSeek({ apiKey, baseURL: baseUrl || 'https://api.deepseek.com/v1' }),
    gemini: () => createGoogleGenerativeAI({ apiKey, baseURL: baseUrl }),
    ollama: () => createOllama({ baseURL: baseUrl }),
  };

  const createClient = clientFactories[type] || (() => createOpenAI({ apiKey, baseURL: baseUrl, headers }));
  const client = createClient();

  return client(model);
};

const llmRoutes: FastifyPluginAsync = async (fastify) => {
  // Note: Tools are aggregated from both sandboxed servers and Archestra MCP server
  // Based on this doc: https://ai-sdk.dev/docs/ai-sdk-core/generating-text
  fastify.post<{ Body: StreamRequestBody }>(
    '/api/llm/stream',
    {
      schema: {
        operationId: 'streamLlmResponse',
        description: 'Stream LLM response',
        tags: ['LLM'],
      },
    },
    async (request: FastifyRequest<{ Body: StreamRequestBody }>, reply: FastifyReply) => {
      const { messages, sessionId, model = 'gpt-4o', provider, requestedTools, toolChoice, chatId } = request.body;

      try {
        // Set the chat context for Archestra MCP tools
        if (chatId) {
          ArchestraMcpContext.setCurrentChatId(chatId);
        }

        // Get tools based on chat selection or requested tools
        let tools: McpTools = {};

        if (chatId) {
          // Get chat-specific tool selection
          const chatSelectedTools = await Chat.getSelectedTools(chatId);

          if (chatSelectedTools === null) {
            // null means all tools are selected
            tools = toolAggregator.getAllTools();
          } else if (chatSelectedTools.length > 0) {
            // Use only the selected tools for this chat
            tools = toolAggregator.getToolsById(chatSelectedTools);
          }
          // If chatSelectedTools is empty array, tools remains empty (no tools enabled)
        } else if (requestedTools && requestedTools.length > 0) {
          // Fallback to requested tools if no chatId
          tools = toolAggregator.getToolsById(requestedTools);
        } else {
          // Default to all tools if no specific selection
          tools = toolAggregator.getAllTools();
        }

        const modelInstance = await createModelInstance(model, provider);

        // Detect if we're using OpenAI provider
        const providerConfig = await CloudProviderModel.getProviderConfigForModel(model);
        const isOpenAIProvider =
          provider === 'openai' ||
          providerConfig?.provider?.type === 'openai' ||
          (!provider && !providerConfig && model.startsWith('gpt-')) ||
          (!provider && !providerConfig && model.startsWith('o1-'));

        // Create the stream with the appropriate model
        const streamConfig: any = {
          model: modelInstance,
          messages: convertToModelMessages(messages),
          maxSteps: 5, // Allow multiple tool calls
          stopWhen: stepCountIs(5),
          // experimental_transform: smoothStream({
          //   delayInMs: 20, // optional: defaults to 10ms
          //   chunking: 'line', // optional: defaults to 'word'
          // }),
          onFinish: async ({
            usage,
            text,
            finishReason,
          }: {
            usage: LanguageModelUsage;
            text: string;
            finishReason: FinishReason;
          }) => {
            // Save token usage directly to the chat
            if (usage && sessionId) {
              let contextWindow: number;

              // Get context window dynamically for Ollama, use hardcoded for others
              if (provider === 'ollama') {
                contextWindow = await ollamaClient.getModelContextWindow(model);
              } else {
                contextWindow = getModelContextWindow(model);
              }

              const tokenUsage = {
                promptTokens: usage.inputTokens,
                completionTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
                model: model,
                contextWindow: contextWindow,
              };

              // Save token usage directly to the chat
              await Chat.updateTokenUsage(sessionId, tokenUsage);

              fastify.log.info(`Token usage saved for chat: ${JSON.stringify(tokenUsage)}`);
            }
          },
        };

        // Add OpenAI prompt caching configuration if using OpenAI provider
        if (isOpenAIProvider) {
          streamConfig.experimental = {
            providerOptions: {
              openai: {
                // Use chatId or sessionId as cache key for better hit rates
                // This ensures similar conversations share cached prefixes
                promptCacheKey: chatId ? `chat-${chatId}` : sessionId ? `session-${sessionId}` : undefined,
              },
            },
          };
        }

        // Only add tools and toolChoice if tools are available
        if (tools && Object.keys(tools).length > 0) {
          streamConfig.tools = tools;
          streamConfig.toolChoice = toolChoice || 'auto';
        }

        const result = streamText(streamConfig);

        // Store isOpenAIProvider for use in callback
        const shouldLogCache = isOpenAIProvider;

        return reply.send(
          result.toUIMessageStreamResponse({
            originalMessages: messages,
            onError: (error) => {
              if (error == null) {
                return 'unknown error';
              }
              if (typeof error === 'string') {
                return error;
              }
              if (error instanceof Error) {
                if ('responseBody' in error && error.responseBody) {
                  if (typeof error.responseBody === 'string') {
                    try {
                      const parsed = JSON.parse(error.responseBody);
                      return parsed.error || error.message;
                    } catch {
                      return error.message;
                    }
                  }
                }
                return error.message;
              }
              return 'An unexpected error occurred';
            },
            onFinish: (result) => {
              if (sessionId) {
                Chat.saveMessages(sessionId, result.messages);
              }

              // Log OpenAI cache metrics if available
              if (shouldLogCache && 'usage' in result && result.usage) {
                const usage = result.usage as any;
                const cachedTokens = usage?.cachedPromptTokens;
                const promptTokens = usage?.promptTokens;
                if (cachedTokens !== undefined && promptTokens) {
                  fastify.log.info(
                    `OpenAI Prompt Cache - Model: ${model}, Cached tokens: ${cachedTokens}, Total prompt tokens: ${promptTokens}, Cache hit rate: ${((cachedTokens / promptTokens) * 100).toFixed(1)}%`
                  );
                }
              }
            },
          })
        );
      } catch (error) {
        fastify.log.error('LLM streaming error:', error instanceof Error ? error.stack || error.message : error);
        return reply.code(500).send({
          error: 'Failed to stream response',
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );
};

export default llmRoutes;
