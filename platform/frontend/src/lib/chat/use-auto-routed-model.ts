import { requiresOpenAiResponsesApi } from "@archestra/shared";
import type { ChatSetupAgent } from "@/lib/chat/use-chat-setup-options";
import type { LlmModel } from "@/lib/llm-models.query";
import { useOrganizationDefaultModelSummary } from "@/lib/organization.query";

/** The models an auto routed session can land on, by display name. */
export type AutoRoutedTiers = { fast: string; normal: string; smart: string };

/**
 * Whether picking a model makes the chat auto routed: the organization routes,
 * the agent has no model, key, pool or runtime of its own, and the model is the
 * organization default (the normal tier). Chat sends an OpenAI model that needs
 * the Responses API over it, which the router does not handle, so that model
 * is never routed.
 */
export function useAutoRoutedModel(
  agent: ChatSetupAgent | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { data: organizationDefault } =
    useOrganizationDefaultModelSummary(enabled);
  const defaultModelId = organizationDefault?.model?.id ?? null;
  const agentFollowsDefault =
    !!agent &&
    agent.runtime === null &&
    !agent.modelId &&
    !agent.llmApiKeyId &&
    !agent.modelPoolId;
  const routing = organizationDefault?.autoRouting;
  const tiers: AutoRoutedTiers | null =
    agentFollowsDefault && routing?.active
      ? {
          fast: routing.tiers.fast.displayName,
          normal: routing.tiers.normal.displayName,
          smart: routing.tiers.smart.displayName,
        }
      : null;
  return {
    isOrganizationDefault: (dbId: string | undefined) =>
      !!dbId && dbId === defaultModelId,
    /** The tiers a chat on this model is routed across, or null when it isn't. */
    tiersFor: (
      model: Pick<LlmModel, "dbId" | "id" | "provider"> | undefined,
    ) =>
      tiers &&
      model &&
      model.dbId === defaultModelId &&
      !(model.provider === "openai" && requiresOpenAiResponsesApi(model.id))
        ? tiers
        : null,
  };
}

/** "GPT-6 Luna, GPT-6.1 Sol or GPT-6 Astra" */
export function autoRoutedChoices(tiers: AutoRoutedTiers) {
  return `${tiers.fast}, ${tiers.normal} or ${tiers.smart}`;
}
