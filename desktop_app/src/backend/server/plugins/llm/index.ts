import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createOllama } from 'ollama-ai-provider-v2';

import ArchestraMcpContext from '@backend/archestraMcp/context';
import config from '@backend/config';
import toolAggregator from '@backend/llms/toolAggregator';
import Chat from '@backend/models/chat';
import CloudProviderModel from '@backend/models/cloudProvider';

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
        let tools = {};

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
          // onError({ error }) {
          // },
        };

        // Only add tools and toolChoice if tools are available
        if (Object.keys(tools).length > 0) {
          // Truncate tool names to 64 characters for LLM compatibility
          const truncatedTools: typeof tools = {};
          for (const [toolId, tool] of Object.entries(tools)) {
            const truncatedToolName = tool.name && tool.name.length > 64 ? tool.name.substring(0, 64) : tool.name;

            truncatedTools[toolId] = {
              ...tool,
              name: truncatedToolName,
            };
          }

          streamConfig.tools = truncatedTools;
          streamConfig.toolChoice = toolChoice || 'auto';
        }

        const result = streamText(streamConfig);

        return reply.send(
          result.toUIMessageStreamResponse({
            originalMessages: messages,
            onFinish: ({ messages: finalMessages }) => {
              if (sessionId) {
                Chat.saveMessages(sessionId, finalMessages);
              }
            },
          })
        );
      } catch (error) {
        fastify.log.error('LLM streaming error:', error);
        return reply.code(500).send({
          error: 'Failed to stream response',
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  );
};

export default llmRoutes;
