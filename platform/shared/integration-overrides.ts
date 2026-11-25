import { z } from "zod";
import type { AgentCatalogId } from "./agent-catalog-images";
import AGENT_CATALOG_IMAGE_NAMES from "./agent-catalog-images.json";
import { CONNECTOR_TYPE_LABELS, type ConnectorType } from "./knowledge-base";
import {
  providerDisplayNames,
  providerRequiresPerUserCredential,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "./model-constants";
import {
  isPersonalSubscriptionProvider,
  PERSONAL_SUBSCRIPTION_LABELS,
  type SubscriptionCredentialKind,
} from "./subscription-credentials";

/**
 * Messaging channels an admin can hide or relabel. Mirrors the tabs on
 * /messaging-channels: the three ChatOps providers plus email and A2A.
 */
export const MessagingChannelIdSchema = z.enum([
  "slack",
  "ms-teams",
  "telegram",
  "jira",
  "email",
  "a2a",
]);
export type MessagingChannelId = z.infer<typeof MessagingChannelIdSchema>;

export const MESSAGING_CHANNEL_LABELS: Record<MessagingChannelId, string> = {
  slack: "Slack",
  "ms-teams": "MS Teams",
  telegram: "Telegram",
  jira: "Jira",
  email: "Email",
  a2a: "A2A",
};

/** The messaging channels that are chat apps; Jira, email and A2A are not. */
export const CHAT_APP_CHANNEL_IDS = [
  "slack",
  "ms-teams",
  "telegram",
] as const satisfies readonly MessagingChannelId[];

/**
 * Keyed off the label map so a connector type added to
 * `CONNECTOR_TYPE_LABELS` is configurable without a second edit here.
 */
export const KnowledgeConnectorIdSchema = z.enum(
  Object.keys(CONNECTOR_TYPE_LABELS) as [ConnectorType, ...ConnectorType[]],
);

export const PopularAgentIdSchema = z.enum(
  Object.keys(AGENT_CATALOG_IMAGE_NAMES) as [
    AgentCatalogId,
    ...AgentCatalogId[],
  ],
);

export const MAX_INTEGRATION_DISPLAY_NAME_LENGTH = 60;

/**
 * An admin override of a built-in catalog entry.
 *
 * `hidden` removes an entry from its picker. Integration catalogs also refuse
 * to configure hidden entries in the API; popular agent templates only control
 * suggestions and runtime image choices. An absent entry means "available, named as
 * it ships".
 */
const integrationToggleShape = { hidden: z.boolean().optional() };

/**
 * Strict on input: a key this catalog does not take (a name on a toggle-only
 * catalog, say) is a client mistake worth a 400 rather than a silent strip.
 */
export const IntegrationToggleSchema = z.strictObject(integrationToggleShape);
export type IntegrationToggle = z.infer<typeof IntegrationToggleSchema>;

/**
 * Lenient on the way out. These columns are jsonb, so a row written by an
 * older build can hold a key this one no longer knows; validating the stored
 * value strictly would turn that into a 500 on the organization endpoint —
 * one stale key taking the whole app down for everyone.
 */
export const StoredIntegrationToggleSchema = z.object(integrationToggleShape);

/**
 * The two ways into GitHub Copilot: a person's own Copilot subscription
 * (`personal`, a sign-in with their GitHub account) and the organization's
 * Copilot plan connected through a GitHub App (`enterprise`). An admin can
 * turn each one off while the provider stays on.
 */
export const CopilotPlanSchema = z.enum(["personal", "enterprise"]);
export type CopilotPlan = z.infer<typeof CopilotPlanSchema>;

/**
 * The name the enterprise plan shows under until an admin gives it one. The
 * personal plan has no name of its own: it shows under the provider's name.
 */
export const GITHUB_COPILOT_ORGANIZATION_LABEL = "GitHub Copilot Organization";

/**
 * The ways into a provider an admin can turn off on their own: ordinary API
 * keys (`apiKey`), a person's own subscription (`personal`), and GitHub
 * Copilot's organization plan (`enterprise`).
 */
export const ProviderPlanSchema = z.enum(["apiKey", "personal", "enterprise"]);
export type ProviderPlan = z.infer<typeof ProviderPlanSchema>;

/**
 * The providers that offer more than one way in, and which ones. Every other
 * provider has one way in, so its provider switch is the whole story.
 */
const PROVIDER_PLANS = {
  anthropic: ["apiKey", "personal"],
  openai: ["apiKey", "personal"],
  xai: ["apiKey", "personal"],
  "github-copilot": CopilotPlanSchema.options,
} as const satisfies Partial<
  Record<SupportedProvider, readonly ProviderPlan[]>
>;

type MultiPlanProvider = keyof typeof PROVIDER_PLANS;

/** The plans a provider offers, or none when it has one way in. */
export function providerPlans(
  provider: SupportedProvider,
): readonly ProviderPlan[] {
  return Object.hasOwn(PROVIDER_PLANS, provider)
    ? PROVIDER_PLANS[provider as MultiPlanProvider]
    : [];
}

/**
 * Model providers additionally take the organization's own name for the
 * provider, which replaces the built-in one everywhere it is rendered.
 * Messaging channels and knowledge connectors are deliberately toggle-only:
 * they name a single external service each, so there is nothing to rename that
 * would not make the setup instructions harder to follow.
 *
 * `plans` is for the providers in {@link PROVIDER_PLANS}; the input schema
 * refuses it on any other provider, and refuses a plan the provider does not
 * offer. A personal subscription on a provider that also takes API keys
 * (ChatGPT, Claude Code, SuperGrok) has a name of its own in
 * `plans.personal.displayName`; the provider's `displayName` names its API
 * keys. GitHub Copilot's personal plan shows under the provider's name.
 */
const modelProviderOverrideShape = {
  ...integrationToggleShape,
  displayName: z
    .string()
    .trim()
    .max(MAX_INTEGRATION_DISPLAY_NAME_LENGTH)
    .nullish(),
};

export const ModelProviderOverrideSchema = z.strictObject({
  ...modelProviderOverrideShape,
  plans: z
    .strictObject({
      apiKey: IntegrationToggleSchema.optional(),
      personal: z.strictObject(modelProviderOverrideShape).optional(),
      enterprise: z.strictObject(modelProviderOverrideShape).optional(),
    })
    .optional(),
});
export type ModelProviderOverride = z.infer<typeof ModelProviderOverrideSchema>;

// ---- Input: what PATCH /api/organization/integration-settings accepts ----

export const ModelProviderOverridesSchema = z
  .partialRecord(SupportedProvidersSchema, ModelProviderOverrideSchema)
  .superRefine((overrides, ctx) => {
    for (const [key, override] of Object.entries(overrides)) {
      const plans = override?.plans;
      if (!plans) continue;
      const provider = key as SupportedProvider;
      const offered = providerPlans(provider);
      const label = builtInProviderLabel(provider);
      if (offered.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: [provider, "plans"],
          message: `${label} has one way to connect, so it has no plans to turn off.`,
        });
        continue;
      }
      for (const plan of ProviderPlanSchema.options) {
        if (plans[plan] === undefined || offered.includes(plan)) continue;
        ctx.addIssue({
          code: "custom",
          path: [provider, "plans", plan],
          message: `${label} has no ${PLAN_NOUNS[plan]}.`,
        });
      }
      // GitHub Copilot's personal plan shows under the provider's own name.
      if (provider === "github-copilot" && plans.personal?.displayName) {
        ctx.addIssue({
          code: "custom",
          path: [provider, "plans", "personal", "displayName"],
          message:
            "GitHub Copilot personal subscriptions show under the provider's name.",
        });
      }
      // Every plan off is the provider off. Keep one switch for that, so
      // every place that asks whether the provider is offered gets one answer.
      if (offered.every((plan) => plans[plan]?.hidden === true)) {
        ctx.addIssue({
          code: "custom",
          path: [provider, "plans"],
          message: `To turn off both plans, turn off ${label} as a provider.`,
        });
      }
    }
  });

export const MessagingChannelOverridesSchema = z.partialRecord(
  MessagingChannelIdSchema,
  IntegrationToggleSchema,
);

export const KnowledgeConnectorOverridesSchema = z.partialRecord(
  KnowledgeConnectorIdSchema,
  IntegrationToggleSchema,
);

const popularAgentOverrideShape = {
  ...integrationToggleShape,
  position: z.number().int().nonnegative().optional(),
};
const PopularAgentOverrideSchema = z.strictObject(popularAgentOverrideShape);

/**
 * The "Custom image" choice: running an image that is none of the offered
 * runtimes. It is no runtime of its own, so it has no place in the order and
 * no permissions; an administrator can only take it off the list.
 */
export const CUSTOM_IMAGE_RUNTIME_ID = "custom-image";

// Explicit properties keep the generated OpenAPI/SDK request contract closed.
// The satisfies check requires every maintained template to be represented.
export const PopularAgentOverridesSchema = z.strictObject({
  ...({
    "claude-code": PopularAgentOverrideSchema.optional(),
    codex: PopularAgentOverrideSchema.optional(),
    opencode: PopularAgentOverrideSchema.optional(),
    hermes: PopularAgentOverrideSchema.optional(),
    openclaw: PopularAgentOverrideSchema.optional(),
    grok: PopularAgentOverrideSchema.optional(),
    kimi: PopularAgentOverrideSchema.optional(),
    copilot: PopularAgentOverrideSchema.optional(),
  } satisfies Record<
    AgentCatalogId,
    z.ZodOptional<typeof PopularAgentOverrideSchema>
  >),
  [CUSTOM_IMAGE_RUNTIME_ID]: IntegrationToggleSchema.optional(),
});

export const StoredPopularAgentOverridesSchema = z.partialRecord(
  z.enum([...PopularAgentIdSchema.options, CUSTOM_IMAGE_RUNTIME_ID]),
  z.object(popularAgentOverrideShape),
);
export type PopularAgentOverrides = z.infer<
  typeof StoredPopularAgentOverridesSchema
>;

// ---- Stored: what the organization columns may actually hold ----

export const StoredModelProviderOverridesSchema = z.partialRecord(
  SupportedProvidersSchema,
  z.object({
    ...modelProviderOverrideShape,
    plans: z
      .object({
        apiKey: StoredIntegrationToggleSchema.optional(),
        personal: z.object(modelProviderOverrideShape).optional(),
        enterprise: z.object(modelProviderOverrideShape).optional(),
      })
      .optional(),
  }),
);
export type ModelProviderOverrides = z.infer<
  typeof StoredModelProviderOverridesSchema
>;

export const StoredMessagingChannelOverridesSchema = z.partialRecord(
  MessagingChannelIdSchema,
  StoredIntegrationToggleSchema,
);
export type MessagingChannelOverrides = z.infer<
  typeof StoredMessagingChannelOverridesSchema
>;

export const StoredKnowledgeConnectorOverridesSchema = z.partialRecord(
  KnowledgeConnectorIdSchema,
  StoredIntegrationToggleSchema,
);
export type KnowledgeConnectorOverrides = z.infer<
  typeof StoredKnowledgeConnectorOverridesSchema
>;

/**
 * The name an entry ships with, ignoring any admin override.
 *
 * Only for the two places where the shipped name IS the point: the settings
 * dialog's own placeholder (what the admin is overriding), and the catalog's
 * fallback. Everywhere else must resolve through the catalog, or a renamed
 * provider silently reads under its shipped name.
 *
 * The local alias is deliberate: `integration-labels-via-catalog.grit` flags
 * direct indexing of `providerDisplayNames`, and this is the sanctioned way
 * through it.
 */
export function builtInProviderLabel(provider: SupportedProvider): string {
  const labels: Record<SupportedProvider, string> = providerDisplayNames;
  return labels[provider];
}

type IntegrationOverrides<Id extends string> = Partial<
  Record<Id, IntegrationToggle>
> | null;

/** True when an admin has switched this catalog entry off. */
export function isIntegrationHidden<Id extends string>(
  overrides: IntegrationOverrides<Id>,
  id: Id,
): boolean {
  return overrides?.[id]?.hidden === true;
}

/**
 * True when one GitHub Copilot plan is not offered: either GitHub Copilot as a
 * whole is off, or an admin turned off just this plan.
 */
export function isCopilotPlanHidden(
  overrides: ModelProviderOverrides | null,
  plan: CopilotPlan,
): boolean {
  return isProviderPlanHidden(overrides, "github-copilot", plan);
}

/**
 * True when one way into a provider is not offered: the provider is off, or
 * an admin turned off this plan. A plan the provider does not offer reads the
 * provider switch alone.
 */
export function isProviderPlanHidden(
  overrides: ModelProviderOverrides | null,
  provider: SupportedProvider,
  plan: ProviderPlan,
): boolean {
  const override = overrides?.[provider];
  if (override?.hidden === true) return true;
  return (
    providerPlans(provider).includes(plan) &&
    override?.plans?.[plan]?.hidden === true
  );
}

/**
 * True when people cannot connect a new personal subscription of this
 * provider: the provider is off, or an admin turned off just its personal
 * subscriptions. A provider with no personal subscription follows its provider
 * switch.
 */
export function isPersonalSubscriptionHidden(
  overrides: ModelProviderOverrides | null,
  provider: SupportedProvider,
): boolean {
  return isProviderPlanHidden(overrides, provider, "personal");
}

/**
 * True when people cannot add a new ordinary API key for this provider: the
 * provider is off, or an admin turned off just its API keys. GitHub Copilot
 * and Microsoft 365 Copilot take no API keys, so the answer there is always
 * true.
 */
export function isProviderApiKeyHidden(
  overrides: ModelProviderOverrides | null,
  provider: SupportedProvider,
): boolean {
  if (providerRequiresPerUserCredential(provider)) return true;
  return isProviderPlanHidden(overrides, provider, "apiKey");
}

/**
 * True when a provider key belongs to something an admin turned off. Each
 * plan's switch alone decides its keys:
 * - GitHub Copilot: an organization's GitHub App key is the enterprise plan,
 *   any other key a personal sign-in.
 * - OpenAI and xAI: a key holding a ChatGPT or SuperGrok sign-in
 *   (`subscriptionKind`) is a personal subscription, any other key an API key.
 * - Microsoft 365 Copilot: every key is a personal subscription.
 */
export function isProviderKeyHidden(
  overrides: ModelProviderOverrides | null,
  key: {
    provider: SupportedProvider;
    isGithubAppKey?: boolean | null;
    subscriptionKind?: SubscriptionCredentialKind | null;
  },
): boolean {
  return isProviderPlanHidden(overrides, key.provider, providerKeyPlan(key));
}

/**
 * The plan a provider key belongs to, for the providers that offer more than
 * one. Every other key gets `apiKey`, which reads the provider switch.
 */
export function providerKeyPlan(key: {
  provider: SupportedProvider;
  isGithubAppKey?: boolean | null;
  subscriptionKind?: SubscriptionCredentialKind | null;
}): ProviderPlan {
  if (key.provider === "github-copilot") {
    return key.isGithubAppKey ? "enterprise" : "personal";
  }
  if (providerRequiresPerUserCredential(key.provider)) return "personal";
  return key.subscriptionKind ? "personal" : "apiKey";
}

/**
 * The name a personal subscription shows under: the admin's, or the one it
 * ships with ("Claude Code", "ChatGPT", "GitHub Copilot", "SuperGrok",
 * "Microsoft 365 Copilot"). GitHub Copilot and Microsoft 365 Copilot are
 * personal subscriptions as a whole, so they take the provider's name.
 */
export function personalSubscriptionLabel(
  overrides: ModelProviderOverrides | null,
  provider: SupportedProvider,
  /** The name to use when the admins gave none, instead of the shipped one. */
  fallback?: string,
): string {
  const builtIn =
    fallback ??
    (isPersonalSubscriptionProvider(provider)
      ? PERSONAL_SUBSCRIPTION_LABELS[provider]
      : builtInProviderLabel(provider));
  if (!providerPlans(provider).includes("apiKey")) {
    return integrationLabel(overrides, provider, builtIn);
  }
  const custom = overrides?.[provider]?.plans?.personal?.displayName?.trim();
  return custom ? custom : builtIn;
}

/**
 * What a person reads when a GitHub Copilot plan they asked for is turned
 * off: "GitHub Copilot enterprise plans are turned off for this organization…".
 */
export function copilotPlanTurnedOffMessage(
  overrides: ModelProviderOverrides | null,
  plan: CopilotPlan,
): string {
  const label = integrationLabel(
    overrides,
    "github-copilot",
    builtInProviderLabel("github-copilot"),
  );
  return `${label} ${PLAN_NOUNS[plan]} are turned off for this organization. ${askAnAdministrator("them")}`;
}

/**
 * What a person reads when the personal subscription they asked for is
 * turned off: "ChatGPT is turned off for this organization…".
 */
export function personalSubscriptionTurnedOffMessage(
  overrides: ModelProviderOverrides | null,
  provider: SupportedProvider,
): string {
  if (provider === "github-copilot") {
    return copilotPlanTurnedOffMessage(overrides, "personal");
  }
  return `${personalSubscriptionLabel(overrides, provider)} is turned off for this organization. ${askAnAdministrator("it")}`;
}

/**
 * What a person reads when new API keys of a provider are turned off:
 * "OpenAI API keys are turned off for this organization…".
 */
export function providerApiKeyTurnedOffMessage(
  overrides: ModelProviderOverrides | null,
  provider: SupportedProvider,
): string {
  const label = integrationLabel(
    overrides,
    provider,
    builtInProviderLabel(provider),
  );
  return `${label} API keys are turned off for this organization. ${askAnAdministrator("them")}`;
}

/**
 * What a person reads when a plan they asked for is turned off: the plan's own
 * message, or the provider's when the provider has one way in.
 */
export function providerPlanTurnedOffMessage(
  overrides: ModelProviderOverrides | null,
  provider: SupportedProvider,
  plan: ProviderPlan,
): string {
  if (plan === "enterprise") {
    return copilotPlanTurnedOffMessage(overrides, "enterprise");
  }
  if (plan === "personal") {
    return personalSubscriptionTurnedOffMessage(overrides, provider);
  }
  if (providerPlans(provider).includes("apiKey")) {
    return providerApiKeyTurnedOffMessage(overrides, provider);
  }
  const label = integrationLabel(
    overrides,
    provider,
    builtInProviderLabel(provider),
  );
  return `${label} is turned off for this organization. ${askAnAdministrator("it")}`;
}

/** The plan names the Model Providers page uses for its sections. */
const PLAN_NOUNS: Record<ProviderPlan, string> = {
  apiKey: "API keys",
  personal: "personal subscriptions",
  enterprise: "enterprise plans",
};

function askAnAdministrator(pronoun: "it" | "them"): string {
  return `Ask an administrator to turn ${pronoun} on under Settings → LLM → Model providers.`;
}

/** The name the GitHub Copilot enterprise plan shows under. */
export function copilotEnterprisePlanLabel(
  overrides: ModelProviderOverrides | null,
): string {
  const custom =
    overrides?.["github-copilot"]?.plans?.enterprise?.displayName?.trim();
  return custom ? custom : GITHUB_COPILOT_ORGANIZATION_LABEL;
}

/**
 * The label to render for a catalog entry: the admin's override when they set
 * one, otherwise the built-in name.
 */
export function integrationLabel<Id extends string>(
  overrides: Partial<Record<Id, ModelProviderOverride>> | null,
  id: Id,
  fallback: string,
): string {
  const custom = overrides?.[id]?.displayName?.trim();
  return custom ? custom : fallback;
}

/**
 * Drops entries that carry no customization, so an admin who toggles a
 * provider off and back on leaves no residue behind and newly added catalog
 * entries keep defaulting to visible.
 */
export function pruneIntegrationOverrides<Id extends string>(
  overrides: Partial<Record<Id, ModelProviderOverride>>,
): Partial<Record<Id, ModelProviderOverride>> | null {
  const pruned: Partial<Record<Id, ModelProviderOverride>> = {};
  for (const [id, override] of Object.entries(overrides) as [
    Id,
    ModelProviderOverride | undefined,
  ][]) {
    if (!override) continue;
    const displayName = override.displayName?.trim() || null;
    const hidden = override.hidden === true;
    const plans = prunePlans(override.plans);
    if (!hidden && !displayName && !plans) continue;
    pruned[id] = {
      ...(hidden ? { hidden: true } : {}),
      ...(displayName ? { displayName } : {}),
      // Kept while the provider is off too, so switching it back on restores
      // the plan the admin had turned off.
      ...(plans ? { plans } : {}),
    };
  }
  return Object.keys(pruned).length > 0 ? pruned : null;
}

/**
 * The catalog entries an organization offers: everything an admin has not
 * switched off. This is the shape the availability control renders — a chip
 * per allowed entry — so an untouched organization shows the whole catalog.
 */
export function allowedIntegrationIds<Id extends string>(
  overrides: Partial<Record<Id, ModelProviderOverride>> | null,
  catalog: readonly Id[],
): Id[] {
  return catalog.filter((id) => !isIntegrationHidden(overrides, id));
}

/**
 * Rewrites overrides so exactly `allowed` stays on.
 *
 * Names survive the rewrite: model providers keep `displayName` in the same
 * column as the off switch, so switching a provider off and back on must not
 * cost the organization the name it chose for it.
 */
export function withAllowedIntegrationIds<Id extends string>(
  overrides: Partial<Record<Id, ModelProviderOverride>> | null,
  catalog: readonly Id[],
  allowed: readonly Id[],
): Partial<Record<Id, ModelProviderOverride>> | null {
  const allowedIds = new Set<string>(allowed);
  const next: Partial<Record<Id, ModelProviderOverride>> = {};
  for (const id of catalog) {
    next[id] = {
      ...(overrides?.[id] ?? {}),
      hidden: !allowedIds.has(id),
    };
  }
  return pruneIntegrationOverrides(next);
}

/** Saved positions precede unpositioned entries; ties keep the catalog order. */
export function orderedPopularAgentIds(
  overrides: PopularAgentOverrides | null,
  catalog: readonly AgentCatalogId[],
): AgentCatalogId[] {
  return catalog
    .filter((id) => !isIntegrationHidden(overrides, id))
    .sort(
      (a, b) =>
        (overrides?.[a]?.position ?? Number.MAX_SAFE_INTEGER) -
        (overrides?.[b]?.position ?? Number.MAX_SAFE_INTEGER),
    );
}

/** Store both visibility and order in the existing catalog customization. */
export function withOrderedPopularAgentIds(
  overrides: PopularAgentOverrides | null,
  catalog: readonly AgentCatalogId[],
  allowed: readonly string[],
): PopularAgentOverrides {
  const customImage = overrides?.[CUSTOM_IMAGE_RUNTIME_ID];
  return {
    ...Object.fromEntries(
      catalog.map((id) => {
        const position = allowed.indexOf(id);
        return [
          id,
          position < 0 ? { ...overrides?.[id], hidden: true } : { position },
        ];
      }),
    ),
    // Not part of the order, so reordering leaves its switch as it was.
    ...(customImage && { [CUSTOM_IMAGE_RUNTIME_ID]: customImage }),
  };
}

// ===================================================================
// Internal
// ===================================================================

/**
 * The plans an admin turned off or named, or undefined when every plan is
 * offered under its default name. A plan's name is kept while the plan is
 * off, so switching it back on restores it.
 */
function prunePlans(
  plans: ModelProviderOverride["plans"],
): ModelProviderOverride["plans"] {
  const pruned: NonNullable<ModelProviderOverride["plans"]> = {};
  if (plans?.apiKey?.hidden === true) pruned.apiKey = { hidden: true };
  for (const plan of ["personal", "enterprise"] as const) {
    const hidden = plans?.[plan]?.hidden === true;
    const displayName = plans?.[plan]?.displayName?.trim() || null;
    if (!hidden && !displayName) continue;
    pruned[plan] = {
      ...(hidden ? { hidden: true } : {}),
      ...(displayName ? { displayName } : {}),
    };
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}
