/**
 * xAI LLM Proxy Routes - OpenAI-compatible
 *
 * xAI uses an OpenAI-compatible API at https://api.x.ai/v1.
 *
 * `/responses` is served over xAI's chat completions, as the model router
 * serves it: OpenAI-compatible clients (the AI SDK's xAI provider, Kilo Code's
 * SuperGrok sign-in) send Responses requests, and the xAI SuperGrok
 * subscription upstream speaks chat completions only.
 */

import { RouteId } from "@archestra/shared";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { collectDelegationMarkers } from "@/openappa/delegation";
import { setCollectedDelegationMarkers } from "@/routes/proxy/utils/delegation-markers";
import { constructResponseSchema, UuidIdSchema, Xai } from "@/types";
import { xaiAdapterFactory } from "../adapters";
import { makeResponsesFromChatAdapterFactory } from "../adapters/openai-responses-from-chat";
import { responsesToOpenaiChat } from "../adapters/openai-responses-translator";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import { createPassthroughAuthenticator } from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";
import { createProxyPreHandler } from "./proxy-prehandler";

function handleXaiResponses(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as Xai.Types.ResponsesRequest;
  // The translation joins a message's text parts into one string, which can
  // leave a client's delegation marker mid-text (Kilo Code appends an
  // environment part after the prompt it was handed). Collect the markers
  // from the wire the client sent, where each still ends its own part.
  setCollectedDelegationMarkers(
    request,
    collectDelegationMarkers({ family: "openai:responses", body }),
  );
  const { chatBody, responsesContext } = responsesToOpenaiChat(body);
  return handleLLMProxy(
    chatBody,
    request,
    reply,
    makeResponsesFromChatAdapterFactory(xaiAdapterFactory, responsesContext),
  );
}

const xaiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const API_PREFIX = `${PROXY_API_PREFIX}/xai`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
  const RESPONSES_SUFFIX = "/responses";

  logger.debug("[UnifiedProxy] Registering unified xAI routes");

  await fastify.register(fastifyHttpProxy, {
    upstream: config.llm.xai.baseUrl,
    prefix: API_PREFIX,
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: API_PREFIX,
      endpointSuffix: [CHAT_COMPLETIONS_SUFFIX, RESPONSES_SUFFIX],
      upstream: config.llm.xai.baseUrl,
      providerName: "xAI",
      authenticate: createPassthroughAuthenticator("xai"),
    }),
  });

  fastify.post(
    `${API_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiChatCompletionsWithDefaultAgent,
        description: "Create a chat completion with xAI (uses default agent)",
        tags: ["LLM Proxy"],
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Xai.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling xAI request (default agent)",
      );
      return handleLLMProxy(request.body, request, reply, xaiAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiChatCompletionsWithAgent,
        description: "Create a chat completion with xAI for a specific agent",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Xai.API.ChatCompletionRequestSchema,
        headers: Xai.API.ChatCompletionsHeadersSchema,
        response: constructResponseSchema(Xai.API.ChatCompletionResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling xAI request (with agent)",
      );
      return handleLLMProxy(request.body, request, reply, xaiAdapterFactory);
    },
  );

  fastify.post(
    `${API_PREFIX}${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiResponsesWithDefaultAgent,
        description:
          "Create a response with xAI (uses default agent). Served over xAI's chat completions.",
        tags: ["LLM Proxy"],
        body: Xai.API.ResponsesRequestSchema,
        headers: Xai.API.ResponsesHeadersSchema,
        response: constructResponseSchema(Xai.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling xAI Responses request (default agent)",
      );
      return handleXaiResponses(request, reply);
    },
  );

  fastify.post(
    `${API_PREFIX}/:agentId${RESPONSES_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.XaiResponsesWithAgent,
        description:
          "Create a response with xAI for a specific agent. Served over xAI's chat completions.",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: Xai.API.ResponsesRequestSchema,
        headers: Xai.API.ResponsesHeadersSchema,
        response: constructResponseSchema(Xai.API.ResponsesResponseSchema),
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling xAI Responses request (with agent)",
      );
      return handleXaiResponses(request, reply);
    },
  );
};

export default xaiProxyRoutes;
