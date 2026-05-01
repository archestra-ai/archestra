import { hasArchestraTokenPrefix, RouteId } from "@shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isBedrockIamAuthEnabled } from "@/clients/bedrock-credentials";
import logger from "@/logging";
import {
  fetchBedrockModels,
  fetchBedrockModelsViaIam,
} from "@/routes/chat/model-fetchers/bedrock";
import {
  ApiError,
  Bedrock,
  constructResponseSchema,
  OpenAi,
  UuidIdSchema,
} from "@/types";
import { makeBedrockOpenaiAdapterFactory } from "../adapters/bedrock-openai";
import { openaiToConverse } from "../adapters/bedrock-openai-translator";
import { PROXY_API_PREFIX, PROXY_BODY_LIMIT } from "../common";
import {
  attemptJwksAuth,
  resolveAgent,
  validateVirtualApiKey,
  virtualKeyRateLimiter,
} from "../llm-proxy-auth";
import { handleLLMProxy } from "../llm-proxy-handler";

type FastifyRequestLike = Pick<FastifyRequest, "ip" | "raw">;

/**
 * OpenAI ↔ Bedrock Converse compatibility routes.
 *
 * Accepts an OpenAI ChatCompletions request at /v1/bedrock/openai/chat/completions,
 * translates it to a Converse body, runs it through the existing LLM proxy
 * pipeline using the Bedrock adapter (auth, policies, TOON, cost, logging),
 * and translates the Converse response / event stream back to OpenAI on the
 * way out.
 */
const bedrockOpenaiProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const BEDROCK_OPENAI_PREFIX = `${PROXY_API_PREFIX}/bedrock/openai`;
  const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

  logger.info(
    "[UnifiedProxy] Registering Bedrock OpenAI-compatible chat completion routes",
  );

  fastify.post(
    `${BEDROCK_OPENAI_PREFIX}${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.BedrockOpenaiChatCompletionsWithDefaultAgent,
        description:
          "Call Amazon Bedrock models using the OpenAI ChatCompletions wire format (default agent)",
        tags: ["LLM Proxy"],
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Bedrock OpenAI chat completions (default agent)",
      );
      await assertBedrockCredentialResolvable(request, undefined);
      const { converseBody, openaiContext } = openaiToConverse(request.body);
      return handleLLMProxy(
        converseBody,
        request,
        reply,
        makeBedrockOpenaiAdapterFactory(openaiContext),
      );
    },
  );

  fastify.post(
    `${BEDROCK_OPENAI_PREFIX}/:agentId${CHAT_COMPLETIONS_SUFFIX}`,
    {
      bodyLimit: PROXY_BODY_LIMIT,
      schema: {
        operationId: RouteId.BedrockOpenaiChatCompletionsWithAgent,
        description:
          "Call Amazon Bedrock models using the OpenAI ChatCompletions wire format (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: OpenAi.API.ChatCompletionRequestSchema,
        headers: Bedrock.API.ConverseHeadersSchema,
      },
    },
    async (request, reply) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Bedrock OpenAI chat completions (with agent)",
      );
      await assertBedrockCredentialResolvable(request, request.params.agentId);
      const { converseBody, openaiContext } = openaiToConverse(request.body);
      return handleLLMProxy(
        converseBody,
        request,
        reply,
        makeBedrockOpenaiAdapterFactory(openaiContext),
      );
    },
  );

  const ModelsListResponseSchema = z.object({
    object: z.literal("list"),
    data: z.array(
      z.object({
        id: z.string(),
        object: z.literal("model"),
        created: z.number(),
        owned_by: z.string(),
      }),
    ),
  });

  const ModelsHeadersSchema = z.object({
    authorization: z
      .string()
      .optional()
      .describe("Bearer token: Archestra virtual API key for Bedrock"),
  });

  /**
   * Early auth gate for chat completions. `handleLLMProxy` would otherwise
   * happily pass `apiKey: undefined` to `bedrockAdapter.createClient` when
   * neither a bearer nor IAM is available, producing a confusing SigV4 failure
   * instead of a 401. This mirrors the explicit gate in `handleListModels`:
   *   - If any Bearer token is present, defer to `handleLLMProxy` (it will
   *     validate virtual key / raw bearer / reject as appropriate).
   *   - Otherwise, allow the request only if JWKS resolves, or IAM is enabled.
   */
  async function assertBedrockCredentialResolvable(
    request: FastifyRequestLike,
    agentId: string | undefined,
  ): Promise<void> {
    const rawAuthHeader = request.raw.headers.authorization as
      | string
      | undefined;
    if (/^Bearer\s+.+$/i.test(rawAuthHeader ?? "")) return;

    const resolvedAgent = await resolveAgent(agentId);
    const jwksResult = await attemptJwksAuth(
      request as unknown as Parameters<typeof attemptJwksAuth>[0],
      resolvedAgent,
      "bedrock",
    );
    if (jwksResult) return;

    if (!isBedrockIamAuthEnabled()) {
      throw new ApiError(
        401,
        "Authentication required. Provide a Bedrock API key or virtual API key via Authorization: Bearer <token>.",
      );
    }
  }

  /**
   * Resolve Bedrock credentials using the same auth chain as the chat
   * completions route (`handleLLMProxy`):
   *   1. JWKS (agent-configured external IdP, if any)
   *   2. Platform-managed virtual API key (Bearer arch_*)
   *   3. Raw Bedrock bearer API key (Bearer <token>)
   *   4. IAM credential provider fallback (no bearer token)
   */
  async function handleListModels(
    request: FastifyRequestLike,
    agentId: string | undefined,
  ) {
    const rawAuthHeader = request.raw.headers.authorization as
      | string
      | undefined;
    const tokenMatch = rawAuthHeader?.match(/^Bearer\s+(.+)$/i);
    const bearerToken = tokenMatch?.[1];

    let apiKey: string | undefined;
    let baseUrl: string | undefined;

    // 1. JWKS auth if the agent has an external identity provider configured.
    const resolvedAgent = await resolveAgent(agentId);
    const jwksResult = await attemptJwksAuth(
      request as unknown as Parameters<typeof attemptJwksAuth>[0],
      resolvedAgent,
      "bedrock",
    );
    if (jwksResult) {
      logger.info("[BedrockOpenai] auth: jwks");
      apiKey = jwksResult.apiKey;
      baseUrl = jwksResult.baseUrl;
    } else if (bearerToken) {
      if (hasArchestraTokenPrefix(bearerToken)) {
        logger.info("[BedrockOpenai] auth: virtual-key");
        await virtualKeyRateLimiter.check(request.ip);
        try {
          const resolved = await validateVirtualApiKey(bearerToken, "bedrock");
          apiKey = resolved.apiKey;
          baseUrl = resolved.baseUrl;
        } catch (err) {
          await virtualKeyRateLimiter.recordFailure(request.ip);
          throw err;
        }
      } else {
        logger.info("[BedrockOpenai] auth: raw-bearer");
        apiKey = bearerToken;
      }
    } else if (isBedrockIamAuthEnabled()) {
      logger.info("[BedrockOpenai] auth: iam");
    }

    // 4. If no bearer key was resolved (no token, or a virtual key whose
    // parent ChatAPIKey has no secret), the only remaining option is IAM.
    // Gate on the IAM flag so behavior matches `bedrockAdapter.createClient`
    // in the inference path — we don't silently use ambient AWS creds when
    // the operator hasn't enabled IAM.
    if (!apiKey && !isBedrockIamAuthEnabled()) {
      throw new ApiError(
        401,
        "Authentication required. Provide a Bedrock API key or virtual API key via Authorization: Bearer <token>.",
      );
    }

    let models: Awaited<ReturnType<typeof fetchBedrockModels>>;
    if (apiKey) {
      logger.info("[BedrockOpenai] fetching models via api key");
      models = await fetchBedrockModels(apiKey, baseUrl);
    } else {
      logger.info("[BedrockOpenai] fetching models via IAM");
      models = await fetchBedrockModelsViaIam();
    }

    const createdUnix = Math.floor(Date.now() / 1000);
    return {
      object: "list" as const,
      data: models.map((m) => ({
        id: m.id,
        object: "model" as const,
        created: createdUnix,
        owned_by: "bedrock",
      })),
    };
  }

  fastify.get(
    `${BEDROCK_OPENAI_PREFIX}/models`,
    {
      schema: {
        operationId: RouteId.BedrockOpenaiListModelsWithDefaultAgent,
        description:
          "List Amazon Bedrock models (via ListInferenceProfiles) in OpenAI models-list format",
        tags: ["LLM Proxy"],
        headers: ModelsHeadersSchema,
        response: constructResponseSchema(ModelsListResponseSchema),
      },
    },
    async (request) => {
      logger.debug(
        { url: request.url },
        "[UnifiedProxy] Handling Bedrock OpenAI list models (default agent)",
      );
      return handleListModels(request, undefined);
    },
  );

  fastify.get(
    `${BEDROCK_OPENAI_PREFIX}/:agentId/models`,
    {
      schema: {
        operationId: RouteId.BedrockOpenaiListModelsWithAgent,
        description:
          "List Amazon Bedrock models (via ListInferenceProfiles) in OpenAI models-list format (specific agent)",
        tags: ["LLM Proxy"],
        params: z.object({ agentId: UuidIdSchema }),
        headers: ModelsHeadersSchema,
        response: constructResponseSchema(ModelsListResponseSchema),
      },
    },
    async (request) => {
      logger.debug(
        { url: request.url, agentId: request.params.agentId },
        "[UnifiedProxy] Handling Bedrock OpenAI list models (with agent)",
      );
      return handleListModels(request, request.params.agentId);
    },
  );
};

export default bedrockOpenaiProxyRoutes;
