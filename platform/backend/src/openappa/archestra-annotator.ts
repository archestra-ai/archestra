import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { APICallError, generateObject, type JSONSchema7, jsonSchema } from "ai";
import { createLLMModel, isApiKeyRequired } from "@/clients/llm-client";
import config from "@/config";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import OrganizationModel from "@/models/organization";
import { OPENAPPA_ARCHESTRA_ANNOTATOR_PATH } from "@/routes/route-paths";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";
import { repairStructuredOutputText } from "@/utils/structured-output-repair";
import { openappaDeclarations } from "./declarations";

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
  /** Where the runtime posts, and the bearer it presents; the host passes both into the addon. */
  endpoint(): { url: string; token: string } {
    return {
      url: `http://127.0.0.1:${config.api.port}${OPENAPPA_ARCHESTRA_ANNOTATOR_PATH}`,
      token: openappaDeclarations.bridgeToken,
    };
  }

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
      baseUrl: selection.baseUrl,
      chatApiKeyId: selection.chatApiKeyId,
    });
    try {
      const result = await generateObject({
        model,
        schema: jsonSchema(request.schema as JSONSchema7),
        system: request.system,
        prompt: request.input,
        temperature: 0,
        experimental_repairText: repairStructuredOutputText,
      });
      const answer = result.object;
      if (
        typeof answer !== "object" ||
        answer === null ||
        Array.isArray(answer)
      )
        return {
          kind: "failed",
          reason: "The model did not answer an object.",
        };
      return { kind: "answered", answer: answer as Record<string, unknown> };
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
