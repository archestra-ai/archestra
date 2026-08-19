import { z } from "zod";
import { CONNECTOR_TYPE_LABELS, type ConnectorType } from "./knowledge-base";
import {
  providerDisplayNames,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "./model-constants";

/**
 * The messaging channel catalog. Mirrors the tabs on /messaging-channels: the
 * three ChatOps providers plus email and A2A. Roles carry an allow-list over
 * these ids — see `role-resource-access`.
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
 * `CONNECTOR_TYPE_LABELS` is gateable without a second edit here.
 */
export const KnowledgeConnectorIdSchema = z.enum(
  Object.keys(CONNECTOR_TYPE_LABELS) as [ConnectorType, ...ConnectorType[]],
);

export const MAX_INTEGRATION_DISPLAY_NAME_LENGTH = 60;

/**
 * The organization's own name for a built-in model provider, which replaces
 * the built-in one everywhere it is rendered.
 *
 * Renaming is deliberately *not* part of the per-role access model: a provider
 * that reads under two different names to two different people makes every
 * setup instruction and support conversation ambiguous, so the name is one
 * org-wide fact. Which roles may *use* the provider is the separate question
 * `role-resource-access` answers.
 *
 * Messaging channels and knowledge connectors take no name at all: each names
 * a single external service, and renaming those would only make their setup
 * instructions harder to follow.
 */
const modelProviderOverrideShape = {
  displayName: z
    .string()
    .trim()
    .max(MAX_INTEGRATION_DISPLAY_NAME_LENGTH)
    .nullish(),
};

/**
 * Strict on input: an unknown key is a client mistake worth a 400 rather than
 * a silent strip.
 */
export const ModelProviderOverrideSchema = z.strictObject(
  modelProviderOverrideShape,
);
export type ModelProviderOverride = z.infer<typeof ModelProviderOverrideSchema>;

// ---- Input: what PATCH /api/organization/integration-settings accepts ----

export const ModelProviderOverridesSchema = z.partialRecord(
  SupportedProvidersSchema,
  ModelProviderOverrideSchema,
);

// ---- Stored: what the organization column may actually hold ----

/**
 * Lenient on the way out. The column is jsonb, so a row written by an older
 * build can hold a key this one no longer knows — the retired `hidden` flag,
 * say, now expressed as a per-role allow-list. Validating the stored value
 * strictly would turn that into a 500 on the organization endpoint: one stale
 * key taking the whole app down for everyone.
 */
export const StoredModelProviderOverridesSchema = z.partialRecord(
  SupportedProvidersSchema,
  z.object(modelProviderOverrideShape),
);
export type ModelProviderOverrides = z.infer<
  typeof StoredModelProviderOverridesSchema
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
 * Drops entries that carry no customization, so an admin who renames a
 * provider and then clears the name leaves no residue behind.
 */
export function pruneIntegrationOverrides<Id extends string>(
  overrides: Partial<Record<Id, ModelProviderOverride>>,
): Partial<Record<Id, ModelProviderOverride>> | null {
  const pruned: Partial<Record<Id, ModelProviderOverride>> = {};
  for (const [id, override] of Object.entries(overrides) as [
    Id,
    ModelProviderOverride | undefined,
  ][]) {
    const displayName = override?.displayName?.trim();
    if (!displayName) continue;
    pruned[id] = { displayName };
  }
  return Object.keys(pruned).length > 0 ? pruned : null;
}
