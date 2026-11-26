import {
  getAgentRuntimeModelCompatibility,
  getAgentRuntimeProviderCompatibility,
  providerSupportsChat,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindForRuntimeCommand,
} from "@archestra/shared";
import type { AgentRuntimeConfig } from "@/components/agent-runtime-fields";
import type { LlmModel } from "@/lib/llm-models.query";

// The account cards of a runtime, as words: what an agent's own settings and
// its runtime's settings both show under "Credentials to use". One
// source, so the two cannot name an account differently.

type CardText = { title: string; description: string };
type RuntimeShape = Pick<AgentRuntimeConfig, "command" | "inferenceProtocol">;

/** Each person's Claude subscription, on a runtime that runs Claude Code. */
export const CLAUDE_SUBSCRIPTION_CARD: CardText = {
  title: "Each person's Claude subscription",
  description:
    "Everyone connects their own Claude account once. No cost limits. A run's container only gets a short-lived key.",
};

/** The company's own connection: every runtime has it. */
export function companyApiKeyCard(appName: string): CardText {
  return {
    title: "Provider API key",
    description: `An LLM provider key set up in ${appName}. Cost limits apply. A run's container only gets a short-lived key.`,
  };
}

/**
 * The personal subscription a runtime other than Claude Code can run on, or
 * null where it has none: Codex on ChatGPT.
 */
export function runtimeSubscriptionKind(
  command: string | null | undefined,
): SubscriptionCredentialKind | null {
  return subscriptionKindForRuntimeCommand(command);
}

/** The card for that subscription: "Each person's ChatGPT subscription". */
export function personalSubscriptionCard(
  kind: SubscriptionCredentialKind,
): CardText {
  // The provider's own name, whatever it calls its plan: the card says
  // "subscription" itself, and the account is the provider's.
  const name = SUBSCRIPTION_CREDENTIALS[kind].label.replace(
    / subscription$/i,
    "",
  );
  return {
    title: `Each person's ${name} subscription`,
    description: `Everyone connects their own ${name} account once. No cost limits. A run's container only gets a short-lived key.`,
  };
}

/** Whether a runtime can call a provider at all. */
export function runtimeCallsProvider(
  runtime: RuntimeShape,
  provider: SupportedProvider,
): boolean {
  return getAgentRuntimeProviderCompatibility({
    inferenceProtocol: runtime.inferenceProtocol,
    runtimeCommand: runtime.command,
    provider,
  }).compatible;
}

/**
 * Whether a provider's connection can be a runtime's company account. The
 * key answers conversations, so the provider has to chat. A runtime with a
 * subscription of its own runs its company key on that vendor too: Codex
 * on OpenAI.
 */
export function runtimeCompanyProviderFits(
  runtime: RuntimeShape,
  provider: SupportedProvider,
): boolean {
  if (!providerSupportsChat(provider)) return false;
  if (!runtimeCallsProvider(runtime, provider)) return false;
  const kind = runtimeSubscriptionKind(runtime.command?.[0]);
  return !kind || provider === SUBSCRIPTION_CREDENTIALS[kind].provider;
}

/** Whether a runtime can run a model. */
export function runtimeModelFits(
  runtime: RuntimeShape,
  model: Pick<LlmModel, "provider" | "id" | "capabilities">,
): boolean {
  return getAgentRuntimeModelCompatibility({
    inferenceProtocol: runtime.inferenceProtocol,
    runtimeCommand: runtime.command,
    provider: model.provider,
    modelId: model.id,
    supportedEndpoints: model.capabilities?.supportedEndpoints,
  }).compatible;
}

/** Where a locked connection or model is set, as its field says on hover. */
export const LOCKED_IN = {
  agent: "Locked in this agent's settings.",
  runtime: "Locked in the runtime's settings.",
} as const;
