import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  type SystemModelMessage,
} from "ai";
import { LRUCacheManager } from "@/cache-manager";
import { isAnthropicNativeEndpoint } from "@/clients/anthropic-endpoint";
import {
  createLLMModel,
  isApiKeyRequired,
  type LLMModel,
} from "@/clients/llm-client";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import OrganizationModel from "@/models/organization";
import { applyPromptCacheBreakpoints } from "@/routes/chat/normalization/apply-prompt-cache";
import {
  generateTaggedText,
  TRUNCATION_RETRY_FACTOR,
} from "@/utils/generate-tagged-text";
import {
  defaultMaxOutputTokens,
  resolveAgentLlmOrDefault,
  resolveModelOutputBudget,
} from "@/utils/llm-resolution";
import type { OpenappaEncryptedChat } from "./encrypted-chat";

/** The prompt the runtime's `builtin = "archestra"` annotator renders. */
type ArchestraAnnotationRequest = {
  system: string;
  input: string;
  schema: Record<string, unknown>;
};

type ArchestraAnnotationOutcome =
  | { kind: "answered"; answer: Record<string, unknown> }
  | { kind: "unconfigured"; reason: string }
  | { kind: "throttled" }
  | { kind: "failed"; reason: string };

/**
 * Answers the runtime's `builtin = "archestra"` annotator with the
 * organization's default model. The runtime owns the prompt and checks the
 * answer against the annotator's mandate; this side only picks the model and
 * returns its structured answer. The call goes through the LLM proxy as the
 * built-in OpenAPPA configuration agent, so limits, logs and cost apply.
 */
class OpenAppaArchestraAnnotator {
  async annotate(
    request: ArchestraAnnotationRequest,
    encryptedChat: OpenappaEncryptedChat | null = null,
  ): Promise<ArchestraAnnotationOutcome> {
    const organization = encryptedChat
      ? await OrganizationModel.getById(encryptedChat.organizationId)
      : await OrganizationModel.getFirst();
    if (!organization)
      return { kind: "unconfigured", reason: "No organization exists yet." };
    const agent = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG,
      organization.id,
    );
    if (!agent)
      return {
        kind: "unconfigured",
        reason: "The OpenAPPA configuration agent is not provisioned.",
      };
    // No agent: the annotator always runs on the organization default, never
    // on a model someone pinned on the configuration agent.
    const selection = await resolveAgentLlmOrDefault({
      agent: null,
      organizationId: organization.id,
    });
    if (isApiKeyRequired(selection.provider, selection.apiKey))
      return {
        kind: "unconfigured",
        reason: "No LLM provider API key is configured for this organization.",
      };

    const model = createLLMModel({
      provider: selection.provider,
      apiKey: selection.apiKey,
      agentId: agent.id,
      modelName: selection.modelName,
      source: "guardrail:annotator",
      internalCall: true,
      ...(encryptedChat
        ? {
            sessionId: encryptedChat.audit.conversationId,
            userId: encryptedChat.userId,
            encryptedChatKey: encryptedChat.audit.dek,
          }
        : {}),
      baseUrl: selection.baseUrl,
      chatApiKeyId: selection.chatApiKeyId,
    });
    const budget = defaultMaxOutputTokens(
      selection.provider,
      await resolveModelOutputBudget({
        provider: selection.provider,
        modelName: selection.modelName,
      }),
    );
    // The runtime's system prompt is identical across consults of one
    // annotator, so a breakpoint after it turns every later consult's prompt
    // into a cache read.
    const cached = (content: string): SystemModelMessage => {
      const [marked] = applyPromptCacheBreakpoints({
        provider: selection.provider,
        model: selection.modelName,
        messages: [{ role: "system", content }],
        anthropicNativeEndpoint: isAnthropicNativeEndpoint({
          provider: selection.provider,
          model: selection.modelName,
          baseUrl: selection.baseUrl,
        }),
      });
      return marked as SystemModelMessage;
    };
    try {
      const answer =
        (await structuredAnswer({
          model,
          modelKey: `${selection.provider}/${selection.modelName}`,
          system: cached(request.system),
          request,
          maxOutputTokens: budget,
        })) ??
        (await taggedAnswer({
          model,
          system: cached(
            `${request.system}\n\nThe annotation is one JSON object that matches this JSON schema:\n${JSON.stringify(request.schema)}`,
          ),
          request,
          // A fraction of the budget, so the truncation retry's extra room
          // still fits under the model's real output cap.
          maxOutputTokens:
            budget === undefined
              ? undefined
              : Math.floor(budget / TRUNCATION_RETRY_FACTOR),
        }));
      if (answer === null)
        return {
          kind: "failed",
          reason: "The model did not answer a JSON object.",
        };
      return { kind: "answered", answer };
    } catch (error) {
      const apiError = APICallError.isInstance(error) ? error : null;
      const status = apiError?.statusCode;
      // 429 is the provider's rate limit; 402 is Archestra's token-cost limit.
      if (status === 429 || status === 402) return { kind: "throttled" };
      const key = selection.chatApiKeyId
        ? await LlmProviderApiKeyModel.findById(selection.chatApiKeyId)
        : null;
      const call = `${selection.provider}/${selection.modelName}${
        key ? ` with key "${key.name}" (${key.id})` : ""
      }`;
      const reason =
        !encryptedChat && apiError && status !== undefined
          ? `The model call failed: ${call} was rejected upstream with ${status}: ${upstreamMessage(apiError)}`
          : `The model call failed: ${call}.`;
      logger.warn(
        {
          err: encryptedChat ? undefined : error,
          provider: selection.provider,
          model: selection.modelName,
          chatApiKeyId: selection.chatApiKeyId,
          chatApiKeyName: key?.name,
          statusCode: status,
        },
        "OpenAPPA archestra annotator call failed",
      );
      return { kind: "failed", reason };
    }
  }
}

export const openappaArchestraAnnotator = new OpenAppaArchestraAnnotator();

// === Internal ===

type AnnotationCall = {
  model: LLMModel;
  system: SystemModelMessage;
  request: ArchestraAnnotationRequest;
  maxOutputTokens: number | undefined;
};

/**
 * Models that refused the structured-output format, so later consults go
 * straight to the tagged answer instead of paying for a refused call each
 * time. Entries expire, so a provider that gains support is tried again.
 */
const structuredOutputRefusals = new LRUCacheManager<true>({
  maxSize: 256,
  defaultTtl: 60 * 60 * 1000,
});

/**
 * The answer under the provider's structured-output format, which carries the
 * schema instead of the prompt. Null when the provider refused the format or
 * answered outside it, so the caller falls back to the tagged answer; any
 * other failure propagates unchanged.
 */
async function structuredAnswer(
  call: AnnotationCall & { modelKey: string },
): Promise<Record<string, unknown> | null> {
  if (structuredOutputRefusals.get(call.modelKey)) return null;
  try {
    const { output } = await generateText({
      model: call.model,
      system: call.system,
      prompt: call.request.input,
      output: Output.object({ schema: jsonSchema(call.request.schema) }),
      maxOutputTokens: call.maxOutputTokens,
    });
    return isPlainObject(output) ? output : null;
  } catch (error) {
    if (!refusesStructuredOutput(error)) throw error;
    structuredOutputRefusals.set(call.modelKey, true);
    logger.info(
      { model: call.modelKey },
      "OpenAPPA archestra annotator: the model refused structured output; using tagged answers",
    );
    return null;
  }
}

/**
 * A rejected request shape or an answer that does not parse against the
 * schema. Authentication, rate and cost limits are not about the format.
 */
function refusesStructuredOutput(error: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(error)) return true;
  if (!APICallError.isInstance(error)) return false;
  switch (error.statusCode) {
    case 400:
    case 422:
      return true;
    default:
      return false;
  }
}

async function taggedAnswer(
  call: AnnotationCall,
): Promise<Record<string, unknown> | null> {
  const text = await generateTaggedText({
    model: call.model,
    tag: "annotation",
    system: call.system,
    prompt: call.request.input,
    maxOutputTokens: call.maxOutputTokens,
  });
  return text === null ? null : parseObject(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the upstream said, from the `error.message` every provider body and
 * Archestra's own error envelope carry, else the status text.
 */
function upstreamMessage(error: APICallError): string {
  const body = error.responseBody;
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "message" in parsed.error &&
        typeof parsed.error.message === "string"
      )
        return parsed.error.message;
    } catch {
      // Not JSON: fall through to the SDK's own message.
    }
  }
  return error.message;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}
