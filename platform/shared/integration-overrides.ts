import { z } from "zod";
import { CONNECTOR_TYPE_LABELS, type ConnectorType } from "./knowledge-base";
import {
  providerDisplayNames,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "./model-constants";

/**
 * Messaging channels an admin can hide or relabel. Mirrors the tabs on
 * /messaging-channels: the three ChatOps providers plus email and A2A.
 */
export const MessagingChannelIdSchema = z.enum([
  "slack",
  "ms-teams",
  "telegram",
  "email",
  "a2a",
]);
export type MessagingChannelId = z.infer<typeof MessagingChannelIdSchema>;

export const MESSAGING_CHANNEL_LABELS: Record<MessagingChannelId, string> = {
  slack: "Slack",
  "ms-teams": "MS Teams",
  telegram: "Telegram",
  email: "Email",
  a2a: "A2A",
};

/**
 * Keyed off the label map so a connector type added to
 * `CONNECTOR_TYPE_LABELS` is configurable without a second edit here.
 */
export const KnowledgeConnectorIdSchema = z.enum(
  Object.keys(CONNECTOR_TYPE_LABELS) as [ConnectorType, ...ConnectorType[]],
);

export const MAX_INTEGRATION_DISPLAY_NAME_LENGTH = 60;

/**
 * An admin override of a built-in catalog entry.
 *
 * `hidden` is the off switch, and it is a real restriction rather than a
 * cosmetic one: a hidden entry disappears from the pickers and the API refuses
 * to configure it. An absent entry means "available, named as it ships".
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
 * Model providers additionally take the organization's own name for the
 * provider, which replaces the built-in one everywhere it is rendered.
 * Messaging channels and knowledge connectors are deliberately toggle-only:
 * they name a single external service each, so there is nothing to rename that
 * would not make the setup instructions harder to follow.
 */
const modelProviderOverrideShape = {
  ...integrationToggleShape,
  displayName: z
    .string()
    .trim()
    .max(MAX_INTEGRATION_DISPLAY_NAME_LENGTH)
    .nullish(),
};

export const ModelProviderOverrideSchema = z.strictObject(
  modelProviderOverrideShape,
);
export type ModelProviderOverride = z.infer<typeof ModelProviderOverrideSchema>;

// ---- Input: what PATCH /api/organization/integration-settings accepts ----

export const ModelProviderOverridesSchema = z.partialRecord(
  SupportedProvidersSchema,
  ModelProviderOverrideSchema,
);

export const MessagingChannelOverridesSchema = z.partialRecord(
  MessagingChannelIdSchema,
  IntegrationToggleSchema,
);

export const KnowledgeConnectorOverridesSchema = z.partialRecord(
  KnowledgeConnectorIdSchema,
  IntegrationToggleSchema,
);

// ---- Stored: what the organization columns may actually hold ----

export const StoredModelProviderOverridesSchema = z.partialRecord(
  SupportedProvidersSchema,
  z.object(modelProviderOverrideShape),
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
    if (!hidden && !displayName) continue;
    pruned[id] = {
      ...(hidden ? { hidden: true } : {}),
      ...(displayName ? { displayName } : {}),
    };
  }
  return Object.keys(pruned).length > 0 ? pruned : null;
}
