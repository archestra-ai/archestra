import {
  getAgentRuntimeModelCompatibility,
  getAgentRuntimeProviderCompatibility,
  isCopilotRuntimeCommand,
  providerSupportsChat,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindForRuntimeCommand,
} from "@archestra/shared";
import type { AgentRuntimeConfig } from "@/components/agent-runtime-fields";
import type { LlmModel } from "@/lib/llm-models.query";
import {
  organizationSubscriptionName,
  organizationSubscriptionSubtitle,
} from "@/lib/organization-subscription";

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

/** The company's own connection: every runtime but the Copilot CLI has it. */
export function companyApiKeyCard(appName: string): CardText {
  return {
    title: "An API key",
    description: `An LLM provider key set up in ${appName}. Cost limits apply. A run's container only gets a short-lived key.`,
  };
}

/**
 * The personal subscription a runtime other than Claude Code can run on, or
 * null where it has none: Codex on ChatGPT, Grok Build on SuperGrok, the
 * Copilot CLI on GitHub Copilot.
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

/**
 * One of the Copilot CLI's company accounts: an enterprise plan the
 * organization connected. Named by its kind first: beside the personal card,
 * a plan's own name does not say whose account it is.
 */
export function enterprisePlanCard(
  plan: Parameters<typeof organizationSubscriptionName>[0],
): CardText {
  return {
    title: `Enterprise plan: ${organizationSubscriptionName(plan)}`,
    description: `${organizationSubscriptionSubtitle(plan)}. A run's container only gets a short-lived key.`,
  };
}

/**
 * The same card for a plan known only by name: one a runtime fixes for its
 * agents, shown to someone who may not read the plan itself.
 */
export function namedEnterprisePlanCard(
  name: string | null | undefined,
): CardText {
  return {
    title: name ? `Enterprise plan: ${name}` : "Enterprise plan",
    description: `${organizationSubscriptionSubtitle({})}. A run's container only gets a short-lived key.`,
  };
}

/** What the meaning line calls the Copilot CLI's company account. */
export function companyAccountName(
  command: string | null | undefined,
): string | undefined {
  return isCopilotRuntimeCommand(command)
    ? "the company's enterprise plan"
    : undefined;
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
 * subscription of its own runs its company key on that vendor too: Grok
 * Build on an xAI key beside SuperGrok, Codex on OpenAI.
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

// The Copilot CLI's company accounts are the enterprise plans, one card
// each. The company's way is open on every plan, or on the one that is
// fixed: a runtime's settings and an agent's settings both say it so.

/** The plans the company's way is open on: every plan, one, or none. */
export type CopilotPlansOpen = "all" | string | null;

export function copilotPlansOpen(params: {
  companyWayOpen: boolean;
  /** The plan that is fixed, when it is one of the cards. */
  fixedPlanId: string | undefined;
}): CopilotPlansOpen {
  return params.companyWayOpen ? (params.fixedPlanId ?? "all") : null;
}

/**
 * What the plan cards show after a click on one. A set of several plans
 * short of all of them is not something a runtime or an agent can say, so a
 * click that would leave one settles on one plan.
 */
export function copilotPlansAfterClick(params: {
  planIds: string[];
  open: CopilotPlansOpen;
  planId: string;
}): CopilotPlansOpen {
  const { planIds, open, planId } = params;
  const only = planIds.length === 1;
  if (open === "all" || open === planId) {
    // Unticking one of all leaves the other, or the first of the others.
    return open === "all" && !only
      ? (planIds.find((id) => id !== planId) ?? null)
      : null;
  }
  // Ticking the last unticked plan of two opens them all.
  return only || (open !== null && planIds.length === 2) ? "all" : planId;
}

/**
 * The model set for each plan, laid on what holds them: an agent's runtime,
 * or a runtime's account rule. None set leaves the field out, as it is
 * stored.
 */
export function withPlanModels<T extends { connectionModels?: PlanModels }>(
  holder: T,
  models: PlanModels,
): T {
  const { connectionModels: _previous, ...rest } = holder;
  return (
    Object.keys(models).length > 0
      ? { ...rest, connectionModels: models }
      : rest
  ) as T;
}

/** The same with one plan's model set, or cleared with null. */
export function withPlanModel<T extends { connectionModels?: PlanModels }>(
  holder: T,
  planId: string,
  modelId: string | null,
): T {
  const { [planId]: _previous, ...others } = holder.connectionModels ?? {};
  return withPlanModels(
    holder,
    modelId ? { ...others, [planId]: modelId } : others,
  );
}

/**
 * The plan models after a click on a plan card. A plan's model stays with
 * it: when every plan opens, the model of the plan that was fixed becomes
 * the model set for that plan. Where one plan is fixed, its model is the
 * holder's own, and none is set per plan.
 */
export function planModelsAfterClick(params: {
  models: PlanModels | undefined;
  open: CopilotPlansOpen;
  fixedPlanId: string | undefined;
  fixedModelId: string | undefined;
}): PlanModels {
  if (params.open !== "all") return {};
  const models = params.models ?? {};
  return params.fixedPlanId && params.fixedModelId
    ? { ...models, [params.fixedPlanId]: params.fixedModelId }
    : models;
}

type PlanModels = Record<string, string>;

/**
 * The accounts those cards amount to: the one kind that is open (null for
 * both), and the plan and model that are fixed. `none` is every card
 * unticked. A plan's model stays with it.
 */
export function copilotAccountsFor(params: {
  subscription: boolean;
  open: CopilotPlansOpen;
  fixedPlanId: string | undefined;
  modelId: string | undefined;
}):
  | { lock: "none" }
  | {
      lock: "subscription" | "key" | null;
      llmApiKeyId?: string;
      modelId?: string;
    } {
  const { subscription, open } = params;
  if (!subscription && open === null) return { lock: "none" };
  const planId = open === "all" || open === null ? undefined : open;
  return {
    lock:
      subscription && open !== null
        ? null
        : subscription
          ? "subscription"
          : "key",
    llmApiKeyId: planId,
    modelId:
      planId && planId === params.fixedPlanId ? params.modelId : undefined,
  };
}

/** Where a locked connection or model is set, as its field says on hover. */
export const LOCKED_IN = {
  agent: "Locked in this agent's settings.",
  runtime: "Locked in the runtime's settings.",
} as const;
