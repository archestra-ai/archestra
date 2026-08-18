import {
  anthropicThinksByDefault,
  type InteractionSource,
  providerHasMultipleSurfaces,
} from "@archestra/shared";
import {
  createLLMModel,
  isApiKeyRequired,
  type LLMModel,
} from "@/clients/llm-client";
import { APICallError } from "ai";
import ModelModel from "@/models/model";
import type { Agent } from "@/types";
import { resolveAgentLlmOrDefault } from "@/utils/llm-resolution";

type ResolvedBatchModel =
  | { ok: true; model: LLMModel; temperature: number | undefined }
  | { ok: false; error: string };

/**
 * Resolve the analysis agent's model exactly the way the row executor does,
 * shared so the grid-chat route cannot drift from it. Carries the two
 * hard-won provider guards: the `supportedEndpoints` lookup (Responses-only
 * models on multi-surface providers 400 on chat/completions without it) and
 * the reasoning-model temperature omission (thinking-by-default models reject
 * an explicit temperature outright).
 */
export async function resolveBatchAnalysisModel(params: {
  agent: Agent;
  organizationId: string;
  userId: string;
  source: InteractionSource;
}): Promise<ResolvedBatchModel> {
  const llm = await resolveAgentLlmOrDefault({
    agent: params.agent,
    organizationId: params.organizationId,
    userId: params.userId,
  });

  if (isApiKeyRequired(llm.provider, llm.apiKey)) {
    return {
      ok: false,
      error: `No API key configured for provider ${llm.provider}`,
    };
  }

  const supportedEndpoints = providerHasMultipleSurfaces(llm.provider)
    ? ((await ModelModel.findByProviderAndModelId(llm.provider, llm.modelName))
        ?.supportedEndpoints ?? null)
    : null;

  return {
    ok: true,
    model: createLLMModel({
      provider: llm.provider,
      apiKey: llm.apiKey,
      modelName: llm.modelName,
      baseUrl: llm.baseUrl,
      agentId: params.agent.id,
      userId: params.userId,
      source: params.source,
      chatApiKeyId: llm.chatApiKeyId,
      supportedEndpoints,
    }),
    temperature: extractionTemperature(llm.provider, llm.modelName),
  };
}

/**
 * Reasoning models reject an explicit sampling temperature outright —
 * Anthropic 400s with "temperature may only be set to 1 when thinking is
 * enabled or in adaptive mode" on its thinking-by-default generations, and
 * OpenAI's reasoning generations 400 on any value but the default. For those,
 * omit the knob; everywhere else keep 0 for run-to-run comparability.
 */
function extractionTemperature(
  provider: string,
  modelName: string,
): number | undefined {
  if (provider === "anthropic" && anthropicThinksByDefault(modelName)) {
    return undefined;
  }
  const id = modelName.toLowerCase();
  if (
    provider === "openai" &&
    (/^o\d/.test(id) || (id.startsWith("gpt-5") && !id.includes("gpt-5-chat")))
  ) {
    return undefined;
  }
  return 0;
}

/**
 * @public — shared by the executor and grid-chat route
 *
 * A provider error's HTTP statusText alone ("Bad Request") tells the user
 * nothing actionable. When the SDK preserved the response body, surface the
 * provider's own message with it.
 */
export function describeModelCallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!APICallError.isInstance(error) || !error.responseBody) {
    return message;
  }
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(error.responseBody) as {
      error?: { message?: string };
    };
    detail = parsed.error?.message;
  } catch {
    detail = error.responseBody;
  }
  if (!detail || detail === message) return message;
  return `${message} — ${detail.slice(0, 300)}`;
}
