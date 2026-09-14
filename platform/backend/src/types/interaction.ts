import {
  BillingModeSchema,
  InteractionSourceSchema,
  isLockedChatUnavailableContent,
  LOCKED_CHAT_REDACTED_VALUES,
  SupportedProvidersDiscriminatorSchema,
} from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SelectConversationChatErrorSchema } from "./conversation-chat-error";
import { DualLlmAnalysisSchema } from "./dual-llm";
import {
  ToolCallBlockSchema,
  UnsafeContextBoundarySchema,
} from "./interaction-guardrails";
import {
  Anthropic,
  Azure,
  Bedrock,
  Cerebras,
  Cohere,
  DeepSeek,
  Gemini,
  GithubCopilot,
  Groq,
  Kimi,
  Microsoft365Copilot,
  Minimax,
  Mistral,
  Ollama,
  OllamaNative,
  OpenAi,
  Openrouter,
  Perplexity,
  Vllm,
  Xai,
  Zhipuai,
} from "./llm-providers";
import { ToonSkipReasonSchema } from "./tool-result-compression";
import { VirtualApiKeyTypeSchema } from "./virtual-api-key";
import { ResourceVisibilityScopeSchema } from "./visibility";

export { InteractionSourceSchema };

export const UserInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const InteractionAuthMethodSchema = z.enum([
  "provider_key",
  "virtual_key",
  "passthrough_virtual_key",
  "jwks",
  "oauth_client_credentials",
  "oauth_user",
  "internal",
  "unknown",
]);

/**
 * Why a session has no user attached. A blank user in the logs is otherwise
 * indistinguishable from a bug, when in practice it almost always means the
 * traffic arrived on a credential that identifies no one.
 *
 * - `shared_virtual_key` — a team- or org-scoped virtual key. Only *personal*
 *   virtual keys carry an owner, so a shared key attributes to nobody. The key
 *   itself is still named, in `SessionSummary.virtualKeys`; devs connecting
 *   individually is what attributes the traffic to people.
 * - `provider_key` — the client sent its own upstream provider credential, so
 *   Archestra never saw an identity to record.
 * - `client_credentials` — an OAuth client-credentials grant: a machine, not
 *   a person.
 * - `internal` — Archestra's own traffic (embeddings, title generation).
 * - `unknown` — none of the above matched.
 */
export const SessionUnattributedReasonSchema = z.enum([
  "shared_virtual_key",
  "provider_key",
  "client_credentials",
  "internal",
  "unknown",
]);

export type SessionUnattributedReason = z.infer<
  typeof SessionUnattributedReasonSchema
>;

/**
 * The virtual API key a logged request authenticated with, resolved to
 * something a human can act on. Per-user attribution is the whole point of a
 * virtual key, so the logs have to name the key and say who it belongs to
 * rather than only reporting `auth_method = virtual_key`.
 *
 * Two different questions, deliberately kept apart:
 *
 * - **Who does this key attribute traffic to?** `ownerUserId` /
 *   `ownerUserName`, and only ever a *personal* key's author — that is the
 *   single place the proxy takes a user identity from a virtual key
 *   (`llm-proxy-handler.ts`: `virtualKeyScope === "personal"`). A shared key
 *   attributes to nobody, so both stay null on one.
 * - **Who is this key shared with?** `teams` for a team-scoped key,
 *   `createdByUserName` for whoever set it up. A shared key is not
 *   anonymous — it belongs to a team, or to the organization at somebody's
 *   hand — and answering "which shared key, shared with whom" is most of what
 *   makes a shared-key session actionable.
 *
 * Keeping them separate is what stops the second answer being read as the
 * first: a key's creator is not the person who made the request.
 */
const VirtualKeyTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const InteractionVirtualKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /**
   * `personal` = owned by one user; `team` = shared with the teams in
   * `teams`; `org` = shared with the whole organization.
   */
  scope: ResourceVisibilityScopeSchema,
  /**
   * `standard` supplied the provider credential; `passthrough` carried the
   * acting user's identity only. One request can use one of each.
   */
  keyType: VirtualApiKeyTypeSchema,
  /** Displayable token prefix (`archestra_xxxx`), never the secret itself. */
  tokenStart: z.string(),
  ownerUserId: z.string().nullable(),
  ownerUserName: z.string().nullable(),
  /**
   * Teams a team-scoped key is shared with, by name. Empty for personal and
   * org-scoped keys, and for a team key whose assignments were all removed.
   */
  teams: z.array(VirtualKeyTeamSchema),
  /**
   * Who created the key. Present regardless of scope, and never an
   * attribution: on a shared key this is the person who set it up, not the
   * person whose request was logged. Null once their account is gone.
   */
  createdByUserName: z.string().nullable(),
});

export type InteractionVirtualKey = z.infer<typeof InteractionVirtualKeySchema>;

/**
 * A failed upstream call is persisted with the provider `type` but this shape
 * in place of a provider response (the proxy error path in llm-proxy-handler).
 * The insert union and every read arm accept it so the row round-trips instead
 * of poisoning the whole interactions list on read-back.
 */
export const InteractionErrorResponseSchema = z.object({ error: z.string() });

/**
 * Request/Response schemas that accept any provider type
 * These are used for the database schema definition
 */
export const InteractionRequestSchema = z.union([
  OpenAi.API.ChatCompletionRequestSchema,
  OpenAi.API.EmbeddingRequestSchema,
  Gemini.API.GenerateContentRequestSchema,
  Anthropic.API.MessagesRequestSchema,
  Bedrock.API.ConverseRequestSchema,
  Cerebras.API.ChatCompletionRequestSchema,
  Mistral.API.ChatCompletionRequestSchema,
  Perplexity.API.ChatCompletionRequestSchema,
  Groq.API.ChatCompletionRequestSchema,
  Xai.API.ChatCompletionRequestSchema,
  Openrouter.API.ChatCompletionRequestSchema,
  Vllm.API.ChatCompletionRequestSchema,
  Ollama.API.ChatCompletionRequestSchema,
  Cohere.API.ChatRequestSchema,
  Zhipuai.API.ChatCompletionRequestSchema,
  DeepSeek.API.ChatCompletionRequestSchema,
  GithubCopilot.API.ChatCompletionRequestSchema,
  Kimi.API.ChatCompletionRequestSchema,
  Microsoft365Copilot.API.ChatCompletionRequestSchema,
  Minimax.API.ChatCompletionRequestSchema,
  OpenAi.API.ResponsesRequestSchema,
  Azure.API.ChatCompletionRequestSchema,
  Azure.API.ResponsesRequestSchema,
]);

/**
 * Embedding interactions are logged with a truncated vector preview (see
 * `buildEmbeddingInteraction`): each vector holds only its first few values plus
 * `truncatedFrom` = the full length. This interaction-only schema permits that
 * marker (on both the write and read sides) so it survives read-back
 * serialization, without polluting the canonical OpenAI embedding response
 * contract used for live proxy responses.
 */
const EmbeddingInteractionResponseSchema =
  OpenAi.API.EmbeddingResponseSchema.extend({
    data: z.array(
      z.object({
        object: z.literal("embedding"),
        embedding: z.array(z.number()),
        // Optional for the same reason as the canonical embedding schema: a
        // stored interaction from an OpenAI-compatible upstream that omitted
        // `index` must not fail the whole interaction list on read-back.
        index: z.number().optional(),
        truncatedFrom: z.number().optional(),
      }),
    ),
  });

export const InteractionResponseSchema = z.union([
  OpenAi.API.ChatCompletionResponseSchema,
  EmbeddingInteractionResponseSchema,
  Gemini.API.GenerateContentResponseSchema,
  Anthropic.API.MessagesResponseSchema,
  Bedrock.API.ConverseResponseSchema,
  Cerebras.API.ChatCompletionResponseSchema,
  Mistral.API.ChatCompletionResponseSchema,
  Perplexity.API.ChatCompletionResponseSchema,
  Groq.API.ChatCompletionResponseSchema,
  Xai.API.ChatCompletionResponseSchema,
  Openrouter.API.ChatCompletionResponseSchema,
  Vllm.API.ChatCompletionResponseSchema,
  Ollama.API.ChatCompletionResponseSchema,
  Cohere.API.ChatResponseSchema,
  Zhipuai.API.ChatCompletionResponseSchema,
  DeepSeek.API.ChatCompletionResponseSchema,
  GithubCopilot.API.ChatCompletionResponseSchema,
  Kimi.API.ChatCompletionResponseSchema,
  Microsoft365Copilot.API.ChatCompletionResponseSchema,
  Minimax.API.ChatCompletionResponseSchema,
  OpenAi.API.ResponsesResponseSchema,
  Azure.API.ChatCompletionResponseSchema,
  Azure.API.ResponsesResponseSchema,
  InteractionErrorResponseSchema,
]);

/**
 * The two shapes a locked chat's content takes when it is not
 * available to the reader: encrypted under the browser key (locked), or never
 * stored (redacted). Neither resembles a provider payload, so every read arm
 * has to accept them explicitly — otherwise one locked-chat row 500s the whole
 * interactions list rather than rendering as unavailable.
 */
const LockedChatUnavailableContentSchema = z.union([
  z.object({ __lockedChatSealed: z.string() }),
  z.object({ __redacted: z.enum(LOCKED_CHAT_REDACTED_VALUES) }),
]);

const extendedFields = {
  source: InteractionSourceSchema.nullable().optional(),
  authMethod: InteractionAuthMethodSchema.nullable().optional(),
  toonSkipReason: ToonSkipReasonSchema.nullable().optional(),
  dualLlmAnalyses: z.array(DualLlmAnalysisSchema).nullable().optional(),
  unsafeContextBoundary: UnsafeContextBoundarySchema.nullable().optional(),
  toolCallBlock: ToolCallBlockSchema.nullable().optional(),
};

/**
 * Base database schema without discriminated union
 * This is what Drizzle actually returns from the database
 */
const BaseSelectInteractionSchema = createSelectSchema(
  schema.interactionsTable,
  {
    ...extendedFields,
    // Required on read: the column is NOT NULL, so every row carries a concrete
    // BillingMode. (The default override belongs on the insert schema only.)
    billingMode: BillingModeSchema,
  },
);

/**
 * Delta-encoding bookkeeping columns. They live on the Drizzle table (and so on
 * the row the model reads) so the delta manager can walk parent chains, but they
 * are internal plumbing: the `request` / `processedRequest` returned by the model
 * is always fully reconstructed, so these must never leak into the public API
 * surface (OpenAPI spec, generated response types). Omit them from every response
 * schema. The internal row type stays available via Drizzle's `$inferSelect`.
 */
const DELTA_ENCODING_COLUMNS = {
  threadId: true,
  parentId: true,
  requestSharedPrefix: true,
  processedRequestSharedPrefix: true,
  requestLastMessageIdx: true,
  requestLastMessageHash: true,
} as const;

/**
 * Server-side plumbing for the same reason as the delta columns: it tells the
 * read path which key a row's content is under. Clients never need it — a
 * locked row already announces itself through the sentinel in the content
 * field, which also carries the conversation id — so it stays out of the
 * public API surface rather than widening it for nothing.
 */
const INTERNAL_ENCRYPTION_COLUMNS = { lockedChatConversationId: true } as const;

const BaseSelectInteractionResponseSchema = BaseSelectInteractionSchema.omit({
  ...DELTA_ENCODING_COLUMNS,
  ...INTERNAL_ENCRYPTION_COLUMNS,
}).extend({
  chatErrors: z.array(SelectConversationChatErrorSchema).optional(),
  /**
   * Name of `connectorId`'s knowledge base connector, resolved within the
   * caller's organization. Null once the connector is gone; absent on endpoints
   * that do not resolve it.
   */
  connectorName: z.string().nullable().optional(),
  /**
   * `virtualKeyId` resolved to its key and owner, within the caller's
   * organization. Null when the request used no standard virtual key (or the
   * key has since been deleted); absent on endpoints that do not resolve it.
   */
  virtualKey: InteractionVirtualKeySchema.nullable().optional(),
  /**
   * Same for `passthroughVirtualKeyId` — the key that carried the acting
   * user's identity. Tracked separately because one request can present a
   * standard key for the provider credential and a passthrough key for the
   * user.
   */
  passthroughVirtualKey: InteractionVirtualKeySchema.nullable().optional(),
});

/**
 * Schema for computed request type field
 * - "main": Primary conversation requests (have Task tool for Claude Code)
 * - "subagent": Background/utility requests (no Task tool, prompt suggestions, etc.)
 */
export const RequestTypeSchema = z.enum(["main", "subagent"]);

/**
 * Scalar fields rendered by an interaction-list row. Large request, response,
 * analysis and guardrail payloads stay behind the individual detail endpoint.
 */
export const InteractionSummarySchema = BaseSelectInteractionSchema.pick({
  id: true,
  profileId: true,
  externalAgentId: true,
  sessionId: true,
  model: true,
  baselineModel: true,
  billingMode: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  cost: true,
  baselineCost: true,
  toonTokensBefore: true,
  toonTokensAfter: true,
  toonCostSavings: true,
  toonSkipReason: true,
  createdAt: true,
}).extend({
  type: SupportedProvidersDiscriminatorSchema,
  externalAgentIdLabel: z.string().nullable(),
});

/**
 * Persisted `request` / `processedRequest` payloads are re-validated on
 * read-back, and the provider schemas inevitably drift from what was actually
 * persisted (see FinishReasonSchema; delta-reconstructed requests can also be
 * partial). Without a fallback, one nonconforming row 500s the entire
 * GET /api/interactions response, so every read arm falls back to serializing
 * the raw persisted object when it no longer matches the canonical schema.
 * The canonical schema stays first so conforming rows keep precise OpenAPI
 * types. Responses have their own guard: normalizeInteractionResponse below.
 */
const LoosePersistedPayloadSchema = z.record(z.string(), z.unknown());

const withReadFallback = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, LoosePersistedPayloadSchema]);

/**
 * Each arm's read schema accepts either the provider response, a persisted
 * error response, or unavailable locked-chat content, so a failed interaction
 * (stored with the provider `type`) and a locked-chat one both still serialize
 * on read-back.
 */
const withErrorResponse = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([
    schema,
    InteractionErrorResponseSchema,
    LockedChatUnavailableContentSchema,
  ]);

/**
 * Discriminated union schema for API responses
 * This provides type safety based on the type field
 */
export const SelectInteractionSchema = z.discriminatedUnion("type", [
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["openai:chatCompletions"]),
    request: withReadFallback(OpenAi.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(OpenAi.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(OpenAi.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["openai:responses"]),
    request: withReadFallback(OpenAi.API.ResponsesRequestSchema),
    processedRequest: withReadFallback(OpenAi.API.ResponsesRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(OpenAi.API.ResponsesResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["openai:embeddings"]),
    request: withReadFallback(OpenAi.API.EmbeddingRequestSchema),
    processedRequest: withReadFallback(OpenAi.API.EmbeddingRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(EmbeddingInteractionResponseSchema),
  }),
  // Gemini embeddings are persisted through the OpenAI-compatible embedding
  // client, so they share OpenAI's embedding request/response shape.
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["gemini:embeddings"]),
    request: withReadFallback(OpenAi.API.EmbeddingRequestSchema),
    processedRequest: withReadFallback(OpenAi.API.EmbeddingRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(EmbeddingInteractionResponseSchema),
  }),
  // Bedrock (Titan) embeddings are normalized to the OpenAI embedding shape.
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["bedrock:embeddings"]),
    request: withReadFallback(OpenAi.API.EmbeddingRequestSchema),
    processedRequest: withReadFallback(OpenAi.API.EmbeddingRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(EmbeddingInteractionResponseSchema),
  }),
  // Cohere (direct) embeddings are normalized to the OpenAI embedding shape.
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["cohere:embeddings"]),
    request: withReadFallback(OpenAi.API.EmbeddingRequestSchema),
    processedRequest: withReadFallback(OpenAi.API.EmbeddingRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(EmbeddingInteractionResponseSchema),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["gemini:generateContent"]),
    request: withReadFallback(Gemini.API.GenerateContentRequestSchema),
    processedRequest: withReadFallback(Gemini.API.GenerateContentRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Gemini.API.GenerateContentResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["anthropic:messages"]),
    request: withReadFallback(Anthropic.API.MessagesRequestSchema),
    processedRequest: withReadFallback(Anthropic.API.MessagesRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Anthropic.API.MessagesResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["bedrock:converse"]),
    request: withReadFallback(Bedrock.API.ConverseRequestSchema),
    processedRequest: withReadFallback(Bedrock.API.ConverseRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Bedrock.API.ConverseResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  // Bedrock InvokeModel carries the Anthropic Messages wire format.
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["bedrock:invoke"]),
    request: withReadFallback(Bedrock.API.InvokeRequestSchema),
    processedRequest: withReadFallback(Bedrock.API.InvokeRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Bedrock.API.InvokeResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["cerebras:chatCompletions"]),
    request: withReadFallback(Cerebras.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Cerebras.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Cerebras.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["mistral:chatCompletions"]),
    request: withReadFallback(Mistral.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Mistral.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Mistral.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["perplexity:chatCompletions"]),
    request: withReadFallback(Perplexity.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(
      Perplexity.API.ChatCompletionRequestSchema,
    )
      .nullable()
      .optional(),
    response: withErrorResponse(Perplexity.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["groq:chatCompletions"]),
    request: withReadFallback(Groq.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Groq.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Groq.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["xai:chatCompletions"]),
    request: withReadFallback(Xai.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Xai.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Xai.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["openrouter:chatCompletions"]),
    request: withReadFallback(Openrouter.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(
      Openrouter.API.ChatCompletionRequestSchema,
    )
      .nullable()
      .optional(),
    response: withErrorResponse(Openrouter.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["vllm:chatCompletions"]),
    request: withReadFallback(Vllm.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Vllm.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Vllm.API.ChatCompletionResponseSchema),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["ollama:chatCompletions"]),
    request: withReadFallback(Ollama.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Ollama.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Ollama.API.ChatCompletionResponseSchema),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["ollama-native:chat"]),
    request: withReadFallback(OllamaNative.API.ChatRequestSchema),
    processedRequest: withReadFallback(OllamaNative.API.ChatRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(OllamaNative.API.ChatResponseSchema),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["cohere:chat"]),
    request: withReadFallback(Cohere.API.ChatRequestSchema),
    processedRequest: withReadFallback(Cohere.API.ChatRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Cohere.API.ChatResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["zhipuai:chatCompletions"]),
    request: withReadFallback(Zhipuai.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Zhipuai.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Zhipuai.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["deepseek:chatCompletions"]),
    request: withReadFallback(DeepSeek.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(DeepSeek.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(DeepSeek.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["kimi:chatCompletions"]),
    request: withReadFallback(Kimi.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Kimi.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Kimi.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["github-copilot:chatCompletions"]),
    request: withReadFallback(GithubCopilot.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(
      GithubCopilot.API.ChatCompletionRequestSchema,
    )
      .nullable()
      .optional(),
    response: withErrorResponse(GithubCopilot.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["microsoft-365-copilot:chatCompletions"]),
    request: withReadFallback(
      Microsoft365Copilot.API.ChatCompletionRequestSchema,
    ),
    processedRequest: withReadFallback(
      Microsoft365Copilot.API.ChatCompletionRequestSchema,
    )
      .nullable()
      .optional(),
    response: withErrorResponse(
      Microsoft365Copilot.API.ChatCompletionResponseSchema,
    ),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["minimax:chatCompletions"]),
    request: withReadFallback(Minimax.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Minimax.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Minimax.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["azure:chatCompletions"]),
    request: withReadFallback(Azure.API.ChatCompletionRequestSchema),
    processedRequest: withReadFallback(Azure.API.ChatCompletionRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Azure.API.ChatCompletionResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["azure:responses"]),
    request: withReadFallback(Azure.API.ResponsesRequestSchema),
    processedRequest: withReadFallback(Azure.API.ResponsesRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Azure.API.ResponsesResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["perplexity:responses"]),
    request: withReadFallback(Perplexity.API.ResponsesRequestSchema),
    processedRequest: withReadFallback(Perplexity.API.ResponsesRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(Perplexity.API.ResponsesResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
  BaseSelectInteractionResponseSchema.extend({
    type: z.enum(["github-copilot:responses"]),
    request: withReadFallback(GithubCopilot.API.ResponsesRequestSchema),
    processedRequest: withReadFallback(GithubCopilot.API.ResponsesRequestSchema)
      .nullable()
      .optional(),
    response: withErrorResponse(GithubCopilot.API.ResponsesResponseSchema),
    requestType: RequestTypeSchema.optional(),
    /** Resolved prompt name if externalAgentId matches a prompt ID */
    externalAgentIdLabel: z.string().nullable().optional(),
  }),
]);

/**
 * Per-`type` read schema for the `response` field, derived from the
 * discriminated union above so it can never drift from the arms.
 */
const responseSchemaByInteractionType = new Map<string, z.ZodTypeAny>(
  SelectInteractionSchema.options.map((arm) => [
    arm.shape.type.options[0],
    arm.shape.response,
  ]),
);

/**
 * Coerce a stored `response` that no longer matches its provider's read schema
 * (provider-schema drift, partial/aborted-stream bodies, legacy error shapes)
 * into a serializable sentinel, so a single unparseable row can't 500 the whole
 * interactions list. Returns the response unchanged when it already conforms.
 */
export function normalizeInteractionResponse(
  type: string,
  response: unknown,
): unknown {
  // A locked-chat row's content is deliberately unavailable, not malformed.
  // Both sentinels would fail the provider schema below, and reporting them as
  // corrupt would be actively misleading — one means "encrypted, an escrow
  // holder can recover it", the other "never stored".
  if (isLockedChatUnavailableContent(response)) {
    return response;
  }
  const schema = responseSchemaByInteractionType.get(type);
  if (!schema) {
    return response;
  }
  return schema.safeParse(response).success
    ? response
    : { error: "Malformed stored interaction response" };
}

export const InsertInteractionSchema = createInsertSchema(
  schema.interactionsTable,
  {
    ...extendedFields,
    // Optional on write: the column has a DB default ("metered"), so callers may
    // omit it. The proxy write path sets it explicitly (buildInteractionRecord).
    billingMode: BillingModeSchema.optional(),
    type: SupportedProvidersDiscriminatorSchema,
    request: InteractionRequestSchema,
    processedRequest: InteractionRequestSchema.nullable().optional(),
    response: InteractionResponseSchema,
  },
).extend({
  // Override profileId - required for proxy interactions, nullable for system interactions
  // (e.g., knowledge base embeddings/reranking have no associated profile)
  profileId: z.string().uuid().nullable(),
});

export type UserInfo = z.infer<typeof UserInfoSchema>;

export type Interaction = z.infer<typeof SelectInteractionSchema>;
export type InteractionSummary = z.infer<typeof InteractionSummarySchema>;
export type InsertInteraction = z.infer<typeof InsertInteractionSchema>;
export type InteractionAuthMethod = z.infer<typeof InteractionAuthMethodSchema>;

export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;
export type InteractionResponse = z.infer<typeof InteractionResponseSchema>;

/**
 * TOON skip reason counts for session summaries
 */
export const ToonSkipReasonCountsSchema = z.object({
  applied: z.number(),
  notEnabled: z.number(),
  notEffective: z.number(),
  noToolResults: z.number(),
});

/** Max length of `lastUserMessagePreview` on session summaries. */
export const LAST_USER_MESSAGE_PREVIEW_MAX_LENGTH = 200;

/**
 * Session summary schema for the sessions endpoint
 */
export const SessionSummarySchema = z.object({
  sessionId: z.string().nullable(),
  sessionSource: z.string().nullable(),
  source: InteractionSourceSchema.nullable(),
  sources: z.array(InteractionSourceSchema),
  interactionId: z.string().nullable(), // Only set for single interactions (null session)
  requestCount: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCacheReadTokens: z.number(),
  totalCacheWriteTokens: z.number(),
  /** Full list-price estimate for the session (all rows, regardless of billing mode). */
  totalCost: z.string().nullable(),
  /** Billed spend: list-price `cost` of metered rows only (null when none). */
  totalBilledCost: z.string().nullable(),
  /** Would-be list-price cost of subscription-covered rows (null when none). */
  totalSubscriptionCost: z.string().nullable(),
  totalBaselineCost: z.string().nullable(),
  totalToonCostSavings: z.string().nullable(),
  totalCacheSavings: z.string().nullable(),
  toonSkipReasonCounts: ToonSkipReasonCountsSchema,
  firstRequestTime: z.date(),
  lastRequestTime: z.date(),
  models: z.array(z.string()),
  profileId: z.string().nullable(), // null when profile was deleted
  profileName: z.string().nullable(),
  externalAgentIds: z.array(z.string()),
  externalAgentIdLabels: z.array(z.string().nullable()), // Resolved prompt names
  authMethods: z.array(InteractionAuthMethodSchema),
  authenticatedAppNames: z.array(z.string()),
  userNames: z.array(z.string()),
  /**
   * Ids of the users the session's interactions are attributed to. Prefer
   * these over `userNames` for correlation: display names are not unique, so
   * two members sharing one collapse into a single `userNames` entry.
   *
   * Empty when no interaction in the session carried a user identity — which
   * is the normal case for team- and org-scoped virtual keys and raw provider
   * keys,
   * neither of which identifies a user. `unattributedReason` says which.
   */
  userIds: z.array(z.string()),
  /**
   * Why `userIds` is empty, or null when the session is attributed. Lets the
   * UI distinguish "this key identifies nobody" from "something is broken".
   */
  unattributedReason: z.union([SessionUnattributedReasonSchema, z.null()]),
  /**
   * Every virtual key the session's requests authenticated with — standard and
   * passthrough alike, deduplicated and ordered by name. Names the key behind
   * `authMethods`, which on its own says a virtual key was used but not which
   * one, and carries the owner so an attributed session shows the link rather
   * than leaving `userNames` to imply it.
   *
   * Empty when no request in the session used a virtual key.
   */
  virtualKeys: z.array(InteractionVirtualKeySchema),
  /**
   * Short preview of the session's last user message, computed server-side
   * from the reconstructed request. The raw request body is intentionally
   * never returned by the listing — shipping full bodies OOM-killed the
   * platform container (T-1015). Fetch bodies per interaction via
   * GET /api/interactions when needed.
   */
  lastUserMessagePreview: z
    .string()
    .max(LAST_USER_MESSAGE_PREVIEW_MAX_LENGTH)
    .nullable()
    .describe(
      "Short preview (max 200 chars) of the session's last user message. Raw request bodies are not returned by this listing.",
    ),
  /** Interaction backing the preview and latest-conversation detail view. */
  lastInteractionId: z.string().uuid().nullable(),
  lastInteractionType: z.string().nullable(),
  conversationTitle: z.string().nullable(),
  claudeCodeTitle: z.string().nullable(),
});

export type SessionSummary = z.infer<typeof SessionSummarySchema>;
