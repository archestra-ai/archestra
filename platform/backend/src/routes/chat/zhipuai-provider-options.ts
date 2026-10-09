import {
  supportsThinkingEffort,
  type ThinkingEffortSetting,
} from "@archestra/shared";

/**
 * GLM-5.3 always thinks; the chat's relative depths map to low/high/max.
 * An unset depth preserves the provider default rather than selecting a level.
 * @see https://docs.z.ai/guides/llm/glm-5.3
 */
export function buildZhipuAiProviderOptions(params: {
  provider: string;
  selectedModel: string;
  thinkingEffort: ThinkingEffortSetting;
}): { reasoningEffort: "low" | "high" | "max" } | undefined {
  const { provider, selectedModel, thinkingEffort } = params;
  if (
    provider !== "zhipuai" ||
    thinkingEffort === null ||
    !supportsThinkingEffort(provider, selectedModel)
  ) {
    return undefined;
  }
  const effort = { low: "low", medium: "high", high: "max" } as const;
  return { reasoningEffort: effort[thinkingEffort] };
}
