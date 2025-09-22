import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createOllama } from 'ollama-ai-provider-v2';

import ollamaClient from '@backend/clients/ollama';
import config from '@backend/config';
import Chat from '@backend/models/chat';
import CloudProviderModel from '@backend/models/cloudProvider';
import { archestraMcpContext } from '@backend/server/plugins/mcp';
import toolService from '@backend/services/tool';
import { type McpTools } from '@backend/types';

import sharedConfig from '../../../../config';
import { getModelContextWindow } from './modelContextWindows';

interface StreamRequestBody {
  model: string;
  messages: Array<any>;
  sessionId?: string;
  provider?: string;
  requestedTools?: string[]; // Tool IDs requested by frontend
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
  chatId?: number; // Chat ID to get chat-specific tools
}

const { vercelSdk: vercelSdkConfig } = sharedConfig;

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
      const isOllama = provider === 'ollama';

      try {
        // Set the chat context for Archestra MCP tools
        if (chatId) {
          archestraMcpContext.setCurrentChatId(chatId);
        }

        // Get tools based on chat selection or requested tools
        let tools: McpTools = {};

        if (chatId) {
          // Get chat-specific tool selection
          const chatSelectedTools = await Chat.getSelectedTools(chatId);

          if (chatSelectedTools === null) {
            // null means all tools are selected
            tools = toolService.getAllTools();
          } else if (chatSelectedTools.length > 0) {
            // Use only the selected tools for this chat
            tools = toolService.getToolsById(chatSelectedTools);
          }
          // If chatSelectedTools is empty array, tools remains empty (no tools enabled)
        } else if (requestedTools && requestedTools.length > 0) {
          // Fallback to requested tools if no chatId
          tools = toolService.getToolsById(requestedTools);
        } else {
          // Default to all tools if no specific selection
          tools = toolService.getAllTools();
        }

        // Wrap tools with approval logic
        const wrappedTools: any = {};
        for (const [toolId, tool] of Object.entries(tools)) {
          wrappedTools[toolId] = toolService.wrapToolWithApproval(tool, toolId, sessionId || '', chatId || 0);
        }

        // Create the stream with the appropriate model
        const streamConfig: Parameters<typeof streamText>[0] = {
          model: await createModelInstance(model, provider),
          messages: convertToModelMessages(messages),
          stopWhen: stepCountIs(vercelSdkConfig.maxToolCalls),
          providerOptions: {
            /**
             * The following options are available for the OpenAI provider
             * https://ai-sdk.dev/providers/ai-sdk-providers/openai#responses-models
             */
            openai: {
              /**
               * A cache key for manual prompt caching control.
               * Used by OpenAI to cache responses for similar requests to optimize your cache hit rates.
               */
              ...(chatId || sessionId
                ? {
                    promptCacheKey: chatId ? `chat-${chatId}` : sessionId ? `session-${sessionId}` : undefined,
                  }
                : {}),
              /**
               * maxToolCalls for the most part is handled by stopWhen, but openAI provider also has its
               * own unique config for this
               */
              maxToolCalls: vercelSdkConfig.maxToolCalls,
            },
            ollama: {},
          },
          onFinish: async ({ response, usage, text: _text, finishReason: _finishReason }) => {
            if (usage && sessionId) {
              const tokenUsage = {
                promptTokens: usage.inputTokens,
                completionTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
                model: model,
                contextWindow: isOllama
                  ? await ollamaClient.getModelContextWindow(model)
                  : getModelContextWindow(model),
              };

              await Chat.updateTokenUsage(sessionId, tokenUsage);

              fastify.log.info(`Token usage saved for chat: ${JSON.stringify(tokenUsage)}`);
            }
          },
        };

        // Only add tools and toolChoice if tools are available
        if (wrappedTools && Object.keys(wrappedTools).length > 0) {
          streamConfig.tools = wrappedTools;
          streamConfig.toolChoice = toolChoice || 'auto';
        }

        const result = streamText(streamConfig);

        return reply.send(
          result.toUIMessageStreamResponse({
            originalMessages: messages,
            onError: (error) => {
              return JSON.stringify(error);
            },
            onFinish: ({ messages }) => {
              if (sessionId) {
                // Check if last message has empty parts and strip it if so
                if (messages.length > 0 && messages[messages.length - 1].parts.length === 0) {
                  messages = messages.slice(0, -1);
                }
                // Only save if there are messages remaining
                if (messages.length > 0) {
                  Chat.saveMessages(sessionId, messages);
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
