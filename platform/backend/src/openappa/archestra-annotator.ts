import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { APICallError } from "ai";
import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import OrganizationModel from "@/models/organization";
import { generateTaggedText } from "@/utils/generate-tagged-text";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

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
  ): Promise<ArchestraAnnotationOutcome> {
    const organization = await OrganizationModel.getFirst();
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
      baseUrl: selection.baseUrl,
      chatApiKeyId: selection.chatApiKeyId,
    });
    try {
      const text = await generateTaggedText({
        model,
        tag: "annotation",
        system: `${request.system}\n\nThe annotation is one JSON object that matches this JSON schema:\n${JSON.stringify(request.schema)}`,
        prompt: request.input,
      });
      const answer = text === null ? null : parseObject(text);
      if (answer === null)
        return {
          kind: "failed",
          reason: "The model did not answer a JSON object.",
        };
      return { kind: "answered", answer };
    } catch (error) {
      const status = APICallError.isInstance(error)
        ? error.statusCode
        : undefined;
      // 429 is the provider's rate limit; 402 is Archestra's token-cost limit.
      if (status === 429 || status === 402) return { kind: "throttled" };
      logger.warn(
        {
          err: error,
          provider: selection.provider,
          model: selection.modelName,
          statusCode: status,
        },
        "OpenAPPA archestra annotator call failed",
      );
      return { kind: "failed", reason: "The model call failed." };
    }
  }
}

export const openappaArchestraAnnotator = new OpenAppaArchestraAnnotator();

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
