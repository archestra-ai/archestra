import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  type SystemModelMessage,
} from "ai";
import { isServiceAccountUserId } from "@/auth/service-account-user-id";
import { LRUCacheManager } from "@/cache-manager";
import { isAnthropicNativeEndpoint } from "@/clients/anthropic-endpoint";
import {
  createLLMModel,
  isApiKeyRequired,
  type LLMModel,
} from "@/clients/llm-client";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import MemberModel from "@/models/member";
import OpenAppaSessionModel from "@/models/openappa-session";
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
import { clientSessionId } from "./actor";
import type { OpenappaEncryptedChat } from "./encrypted-chat";
import type { OpenappaReplayOwner } from "./replay-owner";
import { callerUserId } from "./service";

/** The trajectory a consult is made for, absent for one made off a session. */
type ConsultAttribution = {
  root: string;
  trajectory: string;
  call_id?: string;
};

/** The prompt the runtime's `builtin = "archestra"` annotator renders. */
type ArchestraAnnotationRequest = {
  system: string;
  input: string;
  schema: Record<string, unknown>;
  attribution?: ConsultAttribution;
};

/** Whose session the consult's model call is filed under. */
type CallOwner =
  | { kind: "encrypted-chat"; chat: OpenappaEncryptedChat }
  | {
      kind: "session";
      organizationId: string;
      sessionId: string;
      userId: string | undefined;
    }
  | { kind: "replay"; organizationId: string; userId: string | undefined }
  | { kind: "unattributed" };

type ArchestraAnnotationOutcome =
  | { kind: "answered"; answer: Record<string, unknown> }
  | { kind: "unconfigured"; reason: string }
  | { kind: "throttled" }
  | { kind: "failed"; reason: string };

/**
 * Answers the runtime's `builtin = "archestra"` annotator with the model
 * Guardrails settings pick for annotators, else the organization's default. The runtime owns the prompt and checks the
 * answer against the annotator's mandate; this side only picks the model and
 * returns its structured answer. The call goes through the LLM proxy as the
 * built-in OpenAPPA configuration agent, so limits, logs and cost apply.
 */
class OpenAppaArchestraAnnotator {
  async annotate(params: {
    request: ArchestraAnnotationRequest;
    encryptedChat: OpenappaEncryptedChat | null;
    replay: OpenappaReplayOwner | null;
    /** Aborts the model work once the runtime stops waiting for the answer. */
    abortSignal: AbortSignal;
  }): Promise<ArchestraAnnotationOutcome> {
    const { request, encryptedChat, replay, abortSignal } = params;
    const owner: CallOwner = encryptedChat
      ? { kind: "encrypted-chat", chat: encryptedChat }
      : replay
        ? {
            kind: "replay",
            organizationId: replay.organizationId,
            userId: replay.userId ?? undefined,
          }
        : await sessionOwner(request.attribution);
    const organization = await ownerOrganization(owner);
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
    // The model Guardrails settings pick for annotators, else the organization
    // default; never a model someone pinned on the configuration agent.
    const { annotatorModelId, annotatorLlmApiKeyId } =
      await GuardrailsDeploymentModel.get();
    const selection = await resolveAgentLlmOrDefault({
      agent: { modelId: annotatorModelId, llmApiKeyId: annotatorLlmApiKeyId },
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
      ...ownerIdentity(owner),
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
    // The schema stays in the prompt under structured output too: some
    // providers' JSON mode carries no schema. The prompt is identical across
    // consults of one annotator, so a breakpoint after it turns every later
    // consult's prompt, structured or tagged, into a cache read.
    const [system] = applyPromptCacheBreakpoints({
      provider: selection.provider,
      model: selection.modelName,
      messages: [
        {
          role: "system",
          content: `${request.system}\n\nThe annotation is one JSON object that matches this JSON schema:\n${JSON.stringify(request.schema)}`,
        },
      ],
      anthropicNativeEndpoint: isAnthropicNativeEndpoint({
        provider: selection.provider,
        model: selection.modelName,
        baseUrl: selection.baseUrl,
      }),
    }) as SystemModelMessage[];
    // A fraction of the budget, so the tagged truncation retry's extra room
    // still fits under the model's real output cap. Both forms reserve the
    // same, so the format is all that tells one request from the other.
    const maxOutputTokens =
      budget === undefined
        ? undefined
        : Math.floor(budget / TRUNCATION_RETRY_FACTOR);
    const call = { model, system, request, maxOutputTokens, abortSignal };
    const formatKey = JSON.stringify([
      selection.provider,
      selection.modelName,
      selection.baseUrl,
      request.schema,
    ]);
    const startedAt = Date.now();
    try {
      const structured = await structuredAnswer({ ...call, formatKey });
      const answer =
        structured.kind === "answered"
          ? structured.answer
          : await taggedAnswer(call);
      if (answer === null)
        return {
          kind: "failed",
          reason: "The model did not answer a JSON object.",
        };
      // The same request was answered without the format, so the format is
      // what failed.
      switch (structured.kind) {
        case "refused":
          formatStrikes.set(formatKey, STRIKES_TO_SKIP_FORMAT);
          logger.info(
            { provider: selection.provider, model: selection.modelName },
            "OpenAPPA archestra annotator: the model refused structured output; using tagged answers",
          );
          break;
        case "unparsed":
          formatStrikes.set(formatKey, (formatStrikes.get(formatKey) ?? 0) + 1);
          break;
        case "answered":
        case "skipped":
          break;
      }
      return { kind: "answered", answer };
    } catch (error) {
      if (abortSignal.aborted) {
        logger.warn(
          {
            provider: selection.provider,
            model: selection.modelName,
            elapsedMs: Date.now() - startedAt,
          },
          "OpenAPPA archestra annotator: the runtime stopped waiting for the model call",
        );
        return {
          kind: "failed",
          reason: "The runtime stopped waiting for the annotation.",
        };
      }
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

/**
 * The session row the runtime's attribution names, with its user when that
 * user still belongs to the session's organization; a service account has no
 * users row to name. No matching row leaves the call unattributed, as a
 * consult made off a session is.
 */
async function sessionOwner(
  attribution: ConsultAttribution | undefined,
): Promise<CallOwner> {
  if (!attribution) return { kind: "unattributed" };
  const session = await OpenAppaSessionModel.findByTrajectory(attribution);
  if (!session) return { kind: "unattributed" };
  const caller = callerUserId(session.callerId);
  const member =
    caller && !isServiceAccountUserId(caller)
      ? await MemberModel.getByUserId(caller, session.organizationId)
      : undefined;
  return {
    kind: "session",
    organizationId: session.organizationId,
    sessionId: clientSessionId(session.sessionId),
    userId: member?.userId,
  };
}

function ownerOrganization(owner: CallOwner) {
  switch (owner.kind) {
    case "encrypted-chat":
      return OrganizationModel.getById(owner.chat.organizationId);
    case "session":
    case "replay":
      return OrganizationModel.getById(owner.organizationId);
    case "unattributed":
      return OrganizationModel.getFirst();
  }
}

function ownerIdentity(owner: CallOwner) {
  switch (owner.kind) {
    case "encrypted-chat":
      return {
        sessionId: owner.chat.audit.conversationId,
        userId: owner.chat.userId,
        encryptedChatKey: owner.chat.audit.dek,
      };
    case "session":
      return { sessionId: owner.sessionId, userId: owner.userId };
    case "replay":
      return { userId: owner.userId };
    case "unattributed":
      return {};
  }
}

type AnnotationCall = {
  model: LLMModel;
  system: SystemModelMessage;
  request: ArchestraAnnotationRequest;
  maxOutputTokens: number | undefined;
  abortSignal: AbortSignal;
};

/**
 * Strikes against the structured-output format per model endpoint and schema,
 * each counted when the tagged answer then went through: a rejected request
 * is enough at once, an answer outside the schema counts one, and a structured
 * answer clears them. At the limit later consults go straight to the tagged
 * answer instead of paying for a failed call each time; entries expire, so a
 * provider that gains support is tried again.
 */
const formatStrikes = new LRUCacheManager<number>({
  maxSize: 256,
  defaultTtl: 60 * 60 * 1000,
});
const STRIKES_TO_SKIP_FORMAT = 2;

/**
 * The answer under the provider's structured-output format, which carries the
 * schema beside the prompt. `refused`: the provider rejected the request.
 * `unparsed`: this answer fell outside the schema. `skipped`: the format has
 * failed here too often lately. All but `answered` fall back to the tagged
 * answer; authentication, rate and cost limits propagate unchanged.
 */
async function structuredAnswer(
  call: AnnotationCall & { formatKey: string },
): Promise<
  | { kind: "answered"; answer: Record<string, unknown> }
  | { kind: "refused" }
  | { kind: "unparsed" }
  | { kind: "skipped" }
> {
  if ((formatStrikes.get(call.formatKey) ?? 0) >= STRIKES_TO_SKIP_FORMAT)
    return { kind: "skipped" };
  try {
    const { output } = await generateText({
      model: call.model,
      system: call.system,
      prompt: call.request.input,
      output: Output.object({ schema: jsonSchema(call.request.schema) }),
      maxOutputTokens: call.maxOutputTokens,
      abortSignal: call.abortSignal,
    });
    if (!isPlainObject(output)) return { kind: "unparsed" };
    formatStrikes.delete(call.formatKey);
    return { kind: "answered", answer: output };
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) return { kind: "unparsed" };
    if (!APICallError.isInstance(error)) throw error;
    switch (error.statusCode) {
      case 400:
      case 422:
        return { kind: "refused" };
      default:
        throw error;
    }
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
    abortSignal: call.abortSignal,
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
