import type { ThinkingEffortSetting } from "@archestra/shared";
import { getBedrockReasoningFamily } from "@archestra/shared/bedrock-models";

/** Locally validated settings error whose actionable message is safe for chat. */
export class BedrockThinkingConfigurationError extends Error {}

/** Only verified families get reasoning options; default leaves the provider unchanged. */
export function buildBedrockThinkingOptions(params: {
  provider: string;
  selectedModel: string;
  thinkingEffort: ThinkingEffortSetting;
  maxOutputTokens: number;
  hasExplicitOutputLimit: boolean;
  temperature?: number;
}) {
  const { provider, selectedModel, thinkingEffort, maxOutputTokens } = params;
  if (provider !== "bedrock" || thinkingEffort === null) return undefined;
  const family = getBedrockReasoningFamily(selectedModel);
  if (family === null) return undefined;
  if (family === "nova" && thinkingEffort === "high") {
    if (params.hasExplicitOutputLimit) {
      throw new BedrockThinkingConfigurationError(
        "Nova High reasoning cannot honor the configured output-token limit. Choose Low or Medium reasoning, or ask an administrator to remove the explicit output limit.",
      );
    }
    if (params.temperature !== undefined) {
      throw new BedrockThinkingConfigurationError(
        "Nova High reasoning cannot be combined with a temperature override. Remove temperature or choose Low or Medium reasoning.",
      );
    }
  }
  return {
    // Nova high must omit maxTokens. Only the automatic ceiling is omitted;
    // an explicit operator or model cap is never silently bypassed.
    maxOutputTokens:
      family === "nova" && thinkingEffort === "high"
        ? undefined
        : maxOutputTokens,
    providerOptions: {
      reasoningConfig: {
        type: family === "nova" ? ("enabled" as const) : ("adaptive" as const),
        maxReasoningEffort: thinkingEffort,
        ...(family === "claude-adaptive"
          ? { display: "summarized" as const }
          : {}),
      },
    },
  };
}
